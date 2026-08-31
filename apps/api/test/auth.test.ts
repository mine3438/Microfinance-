import { type ErrorResponse, type LoginResponse } from '@mfi/contracts';
import { type Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REFRESH_COOKIE } from '../src/modules/auth/routes.js';
import {
  DEFAULT_TEST_PASSWORD,
  cookieFrom,
  cookieValue,
  freshAddress,
  seedUser,
  startHarness,
  type Harness,
} from './harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

/**
 * `payload` and `cookies` are spread conditionally rather than passed as
 * `undefined`.
 *
 * Two compiler settings meet here: `inject` is overloaded, and an `unknown`
 * payload selects the chainable form whose result has no `statusCode`; and
 * under `exactOptionalPropertyTypes` an explicit `undefined` is not the same as
 * an absent property.
 */
const post = async (
  url: string,
  payload?: Record<string, unknown>,
  cookies?: Record<string, string>,
): Promise<InjectResponse> =>
  harness.server.inject({
    method: 'POST',
    url,
    remoteAddress: freshAddress(),
    ...(payload === undefined ? {} : { payload }),
    ...(cookies === undefined ? {} : { cookies }),
  });

async function loginSuccessfully(): Promise<{
  body: LoginResponse;
  refreshToken: string;
}> {
  const seeded = await seedUser(harness.database);
  const response = await post('/auth/login', {
    email: seeded.email,
    password: seeded.password,
  });

  expect(response.statusCode).toBe(200);
  const cookie = cookieFrom(response.headers, REFRESH_COOKIE);
  expect(cookie).toBeDefined();

  return {
    body: response.json<LoginResponse>(),
    refreshToken: cookieValue(cookie!),
  };
}

describe('POST /auth/login', () => {
  it('returns an access token and the resolved session', async () => {
    const { body } = await loginSuccessfully();

    expect(body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(body.expiresIn).toBe(harness.environment.ACCESS_TOKEN_TTL_SECONDS);
    expect(body.user.roles).toEqual(['loan_officer']);
    expect(body.user.branch?.code).toBe('HQ');
  });

  it('resolves permissions from the database rather than from role names', async () => {
    const { body } = await loginSuccessfully();

    // A loan officer prepares loans and cannot approve them. The separation is
    // the point of the permission model, so the login response has to reflect
    // it rather than sending a role the client expands for itself.
    expect(body.user.permissions).toContain('loan.create');
    expect(body.user.permissions).not.toContain('loan.approve');
  });

  it('puts the refresh token in an HttpOnly, SameSite=Strict cookie and not in the body', async () => {
    const seeded = await seedUser(harness.database);
    const response = await post('/auth/login', {
      email: seeded.email,
      password: seeded.password,
    });

    const cookie = cookieFrom(response.headers, REFRESH_COOKIE)!;

    // HttpOnly is what stops an XSS payload reading the one long-lived
    // credential in the system; SameSite=Strict is what removes CSRF from the
    // refresh endpoint rather than mitigating it.
    expect(cookie).toContain('HttpOnly');
    expect(cookie.toLowerCase()).toContain('samesite=strict');
    expect(JSON.stringify(response.json())).not.toContain(cookieValue(cookie));
  });

  it('accepts the email in any case, as the unique index does', async () => {
    const seeded = await seedUser(harness.database);
    const response = await post('/auth/login', {
      email: seeded.email.toUpperCase(),
      password: seeded.password,
    });

    expect(response.statusCode).toBe(200);
  });

  it('answers a wrong password and an unknown email identically', async () => {
    const seeded = await seedUser(harness.database);

    const wrongPassword = await post('/auth/login', {
      email: seeded.email,
      password: 'definitely not the password',
    });
    const unknownEmail = await post('/auth/login', {
      email: 'nobody.at.all@seed.test',
      password: DEFAULT_TEST_PASSWORD,
    });

    // Byte-identical apart from the correlation id. Any difference — status,
    // code, wording — turns this endpoint into an oracle for which staff
    // addresses at a named financial institution exist.
    expect(wrongPassword.statusCode).toBe(401);
    expect(unknownEmail.statusCode).toBe(401);

    const a = wrongPassword.json<ErrorResponse>().error;
    const b = unknownEmail.json<ErrorResponse>().error;
    expect(a.code).toBe(b.code);
    expect(a.message).toBe(b.message);
  });

  it('refuses an invited user who has not set a password, without saying so', async () => {
    const seeded = await seedUser(harness.database, {
      withPassword: false,
      userStatus: 'invited',
    });

    const response = await post('/auth/login', {
      email: seeded.email,
      password: DEFAULT_TEST_PASSWORD,
    });

    expect(response.statusCode).toBe(401);
    expect(response.json<ErrorResponse>().error.message).toBe('Email or password is incorrect.');
  });

  it('tells a suspended user why, but only after they prove the password', async () => {
    const seeded = await seedUser(harness.database, { userStatus: 'suspended' });

    const correct = await post('/auth/login', {
      email: seeded.email,
      password: seeded.password,
    });
    const incorrect = await post('/auth/login', { email: seeded.email, password: 'wrong' });

    // Having proved the password, the caller learns nothing new from being told
    // the account is suspended — and it is the difference between knowing to
    // call an administrator and retrying until they are locked out.
    expect(correct.statusCode).toBe(403);
    expect(correct.json<ErrorResponse>().error.message).toContain('suspended');

    // Without the password, the status stays hidden.
    expect(incorrect.statusCode).toBe(401);
  });

  it('refuses a user whose institution is suspended', async () => {
    const seeded = await seedUser(harness.database, { institutionStatus: 'suspended' });

    const response = await post('/auth/login', {
      email: seeded.email,
      password: seeded.password,
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.code).toBe('forbidden');
  });

  it('rejects a caller-supplied institution rather than honouring it', async () => {
    const seeded = await seedUser(harness.database);

    const response = await post('/auth/login', {
      email: seeded.email,
      password: seeded.password,
      institutionId: '01930000-0000-7000-8000-000000000000',
    });

    // Tenancy comes from the credentials. A request that could nominate its own
    // institution is a request that could nominate someone else's.
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('validation_failed');
  });

  it('reports both missing fields at once rather than one at a time', async () => {
    const response = await post('/auth/login', {});
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(400);
    expect(body.error.details?.map((detail) => detail.path[0]).sort()).toEqual([
      'email',
      'password',
    ]);
  });
});

describe('POST /auth/refresh', () => {
  it('issues a new access token and rotates the refresh cookie', async () => {
    const { refreshToken } = await loginSuccessfully();

    const response = await post('/auth/refresh', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ accessToken: string }>().accessToken).toBeTruthy();

    const rotated = cookieValue(cookieFrom(response.headers, REFRESH_COOKIE)!);
    expect(rotated).not.toBe(refreshToken);
  });

  it('returns no user record, since a refresh is not a re-authentication', async () => {
    const { refreshToken } = await loginSuccessfully();

    const response = await post('/auth/refresh', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });

    expect(Object.keys(response.json())).toEqual(['accessToken', 'expiresIn']);
  });

  it('refuses a token that was never issued', async () => {
    const response = await post('/auth/refresh', undefined, {
      [REFRESH_COOKIE]: 'not-a-token-anyone-issued',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses when no cookie is presented at all', async () => {
    expect((await post('/auth/refresh', undefined)).statusCode).toBe(401);
  });

  describe('reuse detection', () => {
    it('revokes the whole family when a consumed token is presented again', async () => {
      const { refreshToken: first } = await loginSuccessfully();

      // Legitimate rotation.
      const rotated = await post('/auth/refresh', undefined, { [REFRESH_COOKIE]: first });
      expect(rotated.statusCode).toBe(200);
      const second = cookieValue(cookieFrom(rotated.headers, REFRESH_COOKIE)!);

      // The captured token, replayed. The legitimate holder has moved past it,
      // so the only way a second party still holds it is capture.
      const replayed = await post('/auth/refresh', undefined, { [REFRESH_COOKIE]: first });
      expect(replayed.statusCode).toBe(401);

      // And the consequence that matters: the token the *legitimate* user holds
      // is dead too. Ending the session for both is the point — the attacker
      // loses access, and the user finds out by being asked to sign in again.
      const afterRevocation = await post('/auth/refresh', undefined, {
        [REFRESH_COOKIE]: second,
      });
      expect(afterRevocation.statusCode).toBe(401);
    });

    it('records why the family was revoked', async () => {
      const { refreshToken } = await loginSuccessfully();
      await post('/auth/refresh', undefined, { [REFRESH_COOKIE]: refreshToken });
      await post('/auth/refresh', undefined, { [REFRESH_COOKIE]: refreshToken });

      const reasons = await harness.database.withTransaction(async (client) =>
        client.query<{ revoked_reason: string }>(
          `SELECT DISTINCT revoked_reason FROM refresh_tokens
            WHERE revoked_reason IS NOT NULL`,
        ),
      );

      expect(reasons.rows.map((row) => row.revoked_reason)).toContain(
        'refresh_token_reuse_detected',
      );
    });
  });

  it('ends the session when the account is suspended mid-session', async () => {
    const seeded = await seedUser(harness.database);
    const login = await post('/auth/login', {
      email: seeded.email,
      password: seeded.password,
    });
    const refreshToken = cookieValue(cookieFrom(login.headers, REFRESH_COOKIE)!);

    await harness.database.withTenantTransaction(
      { institutionId: seeded.institutionId },
      async (client) => {
        await client.query('UPDATE users SET status = $1 WHERE id = $2', [
          'suspended',
          seeded.userId,
        ]);
      },
    );

    const response = await post('/auth/refresh', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });

    // This is what bounds a suspension to one access-token lifetime rather than
    // to the refresh token's thirty days.
    expect(response.statusCode).toBe(403);
  });
});

describe('POST /auth/logout', () => {
  it('revokes the family so an earlier token cannot resume the session', async () => {
    const { refreshToken } = await loginSuccessfully();

    const response = await post('/auth/logout', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });

    const afterLogout = await post('/auth/refresh', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('clears the cookie', async () => {
    const { refreshToken } = await loginSuccessfully();

    const response = await post('/auth/logout', undefined, {
      [REFRESH_COOKIE]: refreshToken,
    });

    expect(cookieFrom(response.headers, REFRESH_COOKIE)).toBeDefined();
  });

  it('succeeds when no session is presented', async () => {
    // Signing out must not be an operation a caller can fail: an error here
    // leaves a user looking at a screen that says they are still signed in.
    expect((await post('/auth/logout', undefined)).statusCode).toBe(200);
  });
});

describe('GET /auth/me', () => {
  const get = async (headers?: Record<string, string>): Promise<InjectResponse> =>
    harness.server.inject({
      method: 'GET',
      url: '/auth/me',
      remoteAddress: freshAddress(),
      ...(headers === undefined ? {} : { headers }),
    });

  it('returns the caller', async () => {
    const { body } = await loginSuccessfully();

    const response = await get({ authorization: `Bearer ${body.accessToken}` });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ id: string }>().id).toBe(body.user.id);
  });

  it('refuses without a token', async () => {
    expect((await get()).statusCode).toBe(401);
  });

  it.each([
    ['a malformed header', 'not-a-bearer-token'],
    ['a bearer with nothing after it', 'Bearer '],
    ['a token signed with another key', 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.wrong'],
  ])('refuses %s', async (_label, authorization) => {
    const response = await get({ authorization });

    expect(response.statusCode).toBe(401);
    // Every rejection reads the same. Which check failed is in the log, where
    // it helps an operator, and not in the response, where it helps an attacker
    // tell a forged token from an expired one.
    expect(response.json<ErrorResponse>().error.message).toBe('Authentication is required.');
  });

  it('carries no password hash', async () => {
    const { body } = await loginSuccessfully();

    const response = await get({ authorization: `Bearer ${body.accessToken}` });

    expect(JSON.stringify(response.json())).not.toMatch(/argon2|password/i);
  });
});
