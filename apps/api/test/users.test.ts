import { randomUUID } from 'node:crypto';

import {
  type CreatedInvitation,
  type ErrorResponse,
  type Invitation,
  type StaffMember,
} from '@mfi/contracts';
import { hashPassword } from '@mfi/identity';
import { type Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_PASSWORD,
  freshAddress,
  seedUser,
  startHarness,
  type Harness,
  type SeededUser,
} from './harness.js';

/**
 * Staff invitations, and everything that must refuse one.
 *
 * Until this module existed an institution could not add a member of staff.
 * `user.read`, `user.invite` and `user.manage` were seeded by migration 0005
 * and enforced nothing; the `invitations` table was created by the same
 * migration and nothing ever wrote to it.
 *
 * Most of what follows is refusals, because the interesting property of an
 * invitation system is not that it creates accounts — it is which accounts it
 * declines to create, and for whom.
 */

let harness: Harness;
let admin: SeededUser;
let adminToken: string;
let officer: SeededUser;
let officerToken: string;
let secondBranchId: string;

const NEW_PASSWORD = 'a perfectly adequate passphrase';

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);

  admin = await seedUserIn(officer.institutionId, null, ['institution_admin']);
  adminToken = await tokenFor(admin);

  secondBranchId = await createBranch(officer.institutionId, 'BR2', 'Second Branch');
});

afterAll(async () => {
  await harness.close();
});

async function seedUserIn(
  institutionId: string,
  branchId: string | null,
  roles: readonly string[],
): Promise<SeededUser> {
  const email = `staff.${randomUUID().slice(0, 8)}@seed.test`;
  const passwordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

  return harness.database.withTransaction(async (db) => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Administrator', $4, 'active') RETURNING id`,
      [institutionId, branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await db.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, userId, role],
      );
    }
    // `SeededUser.branchId` is a string because the shared harness seeds
    // branch-scoped users. An institution-wide user genuinely has none, and no
    // test below reads this field for one — it is the empty string rather than
    // a lie about which branch they belong to.
    return {
      institutionId,
      branchId: branchId ?? '',
      userId,
      email,
      password: DEFAULT_TEST_PASSWORD,
    };
  });
}

async function createBranch(institutionId: string, code: string, name: string): Promise<string> {
  return harness.database.withTransaction(async (db) => {
    const branch = await db.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, district_code)
       VALUES ($1, $2, $3, (SELECT code FROM reference.districts ORDER BY code LIMIT 1))
       RETURNING id`,
      [institutionId, code, name],
    );
    return branch.rows[0]!.id;
  });
}

async function tokenFor(user: SeededUser): Promise<string> {
  const login = await harness.server.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: freshAddress(),
    payload: { email: user.email, password: user.password },
  });
  return login.json<{ accessToken: string }>().accessToken;
}

const request = async (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  token: string | null,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> =>
  harness.server.inject({
    method,
    url,
    remoteAddress: freshAddress(),
    ...(token === null ? {} : { headers: { authorization: `Bearer ${token}` } }),
    ...(payload === undefined ? {} : { payload }),
  });

/** A fresh address, so the global uniqueness of email never collides across tests. */
const freshEmail = (): string => `invitee.${randomUUID().slice(0, 12)}@seed.test`;

const invite = async (
  overrides: Record<string, unknown> = {},
  token: string = adminToken,
): Promise<InjectResponse> =>
  request('POST', '/users/invitations', token, {
    email: freshEmail(),
    fullName: 'Neema Joseph',
    roleCode: 'loan_officer',
    branchId: officer.branchId,
    ...overrides,
  });

/** Pull the token out of the link the manual mechanism hands back. */
function tokenFromLink(created: CreatedInvitation): string {
  const link = created.link;
  if (link === null) {
    throw new Error('The manual delivery mechanism returned no link.');
  }
  const value = new URL(link).searchParams.get('token');
  if (value === null) {
    throw new Error(`No token in the invitation link: ${link}`);
  }
  return value;
}

describe('POST /users/invitations', () => {
  it('creates a pending invitation and hands the link to the inviter', async () => {
    const response = await invite();

    expect(response.statusCode).toBe(201);
    const created = response.json<CreatedInvitation>();

    expect(created.invitation.state).toBe('pending');
    expect(created.invitation.roleCode).toBe('loan_officer');
    expect(created.invitation.invitedBy).toBe(admin.userId);
    expect(created.delivery).toBe('manual');
    expect(created.link).toContain('/accept-invitation?token=');
  });

  it('stores only the hash, never the token', async () => {
    const created = (await invite()).json<CreatedInvitation>();
    const token = tokenFromLink(created);

    const stored = await harness.database.withTransaction(async (db) =>
      db.query<{ token_hash: string }>('SELECT token_hash FROM invitations WHERE id = $1', [
        created.invitation.id,
      ]),
    );

    // A database disclosure must not yield a redeemable invitation.
    expect(stored.rows[0]!.token_hash).not.toBe(token);
    expect(stored.rows[0]!.token_hash).toHaveLength(64);
  });

  it('creates the account alongside, invited and unable to sign in', async () => {
    const email = freshEmail();
    await invite({ email });

    const staff = (await request('GET', '/users', adminToken)).json<StaffMember[]>();
    const created = staff.find((member) => member.email === email);

    expect(created?.status).toBe('invited');

    // No password, so login refuses — which is what makes an account safe to
    // create before the invitation is accepted.
    const attempt = await request('POST', '/auth/login', null, {
      email,
      password: NEW_PASSWORD,
    });
    expect(attempt.statusCode).toBe(401);
  });

  it('refuses an officer, who does not hold user.invite', async () => {
    expect((await invite({}, officerToken)).statusCode).toBe(403);
  });

  it('refuses a role carrying authority the inviter lacks', async () => {
    // The escalation that would otherwise make `user.invite` equal to every
    // permission in the catalogue: hold it, mint an administrator, sign in as
    // one. The officer is refused elsewhere for lacking `user.invite` outright;
    // this is the subtler case, where the caller may invite but may not grant
    // what they are trying to grant.
    //
    // No seeded role holds `user.invite` without also holding everything else,
    // so the case has to be constructed. The grant is added to the catalogue
    // and removed again in `finally`, because every other suite resolves its
    // permissions from this table.
    const manager = await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']);

    await harness.database.withTransaction(async (db) => {
      await db.query(
        `INSERT INTO reference.role_permissions (role_code, permission_code)
         VALUES ('branch_manager', 'user.invite') ON CONFLICT DO NOTHING`,
      );
    });

    try {
      const managerToken = await tokenFor(manager);

      const response = await invite({ roleCode: 'institution_admin' }, managerToken);

      expect(response.statusCode).toBe(403);
      expect(response.json<ErrorResponse>().error.message).toContain('authority');

      // And the role it *may* grant still works, so the check is a subset test
      // rather than a blanket refusal.
      expect((await invite({ roleCode: 'loan_officer' }, managerToken)).statusCode).toBe(201);
    } finally {
      await harness.database.withTransaction(async (db) => {
        await db.query(
          `DELETE FROM reference.role_permissions
            WHERE role_code = 'branch_manager' AND permission_code = 'user.invite'`,
        );
      });
    }
  });

  it('refuses a branch-scoped inviter naming another branch', async () => {
    const branchAdmin = await seedUserIn(officer.institutionId, officer.branchId, [
      'institution_admin',
    ]);
    const scopedToken = await tokenFor(branchAdmin);

    const response = await invite({ branchId: secondBranchId }, scopedToken);

    expect(response.statusCode).toBe(403);
  });

  it('refuses a second live invitation to the same address', async () => {
    const email = freshEmail();
    expect((await invite({ email })).statusCode).toBe(201);

    // `invitations_one_pending_per_email` is a partial unique index over the
    // invitations that are still open, so re-inviting means revoking first.
    const second = await invite({ email });
    expect(second.statusCode).toBe(409);

    // The refusal names no table and no constraint. A constraint name discloses
    // the schema, so it goes to the log with the correlation ID instead.
    const message = second.json<ErrorResponse>().error.message;
    expect(message).not.toContain('invitations');
    expect(message).not.toContain('idx');
  });

  it('leaves nothing behind when the second invitation is refused', async () => {
    const email = freshEmail();
    await invite({ email });
    await invite({ email });

    const rows = await harness.database.withTransaction(async (db) =>
      db.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM invitations WHERE lower(email) = lower($1)',
        [email],
      ),
    );

    // The account and the invitation are written in one transaction, so a
    // refused second attempt rolls back whole. A half-applied invite would
    // leave an account that cannot accept and an address consumed globally.
    expect(rows.rows[0]!.count).toBe('1');
  });

  it('refuses inviting somebody who already works here', async () => {
    const response = await invite({ email: officer.email });

    expect(response.statusCode).toBe(409);
    expect(response.json<ErrorResponse>().error.message).toContain('already belongs');
  });

  it('lets a revoked address be invited again', async () => {
    const email = freshEmail();
    const first = (await invite({ email })).json<CreatedInvitation>();

    await request('POST', `/users/invitations/${first.invitation.id}/revocation`, adminToken);

    const second = await invite({ email });
    expect(second.statusCode).toBe(201);

    // And the first link is dead, which is the whole reason revocation exists.
    const replay = await request('POST', '/auth/invitations/acceptance', null, {
      token: tokenFromLink(first),
      password: NEW_PASSWORD,
    });
    expect(replay.statusCode).toBe(422);
  });
});

describe('accepting an invitation', () => {
  it('activates the account and lets the new user sign in', async () => {
    const email = freshEmail();
    const created = (await invite({ email })).json<CreatedInvitation>();

    const accepted = await request('POST', '/auth/invitations/acceptance', null, {
      token: tokenFromLink(created),
      password: NEW_PASSWORD,
    });
    expect(accepted.statusCode).toBe(204);

    const login = await request('POST', '/auth/login', null, {
      email,
      password: NEW_PASSWORD,
    });
    expect(login.statusCode).toBe(200);

    const staff = (await request('GET', '/users', adminToken)).json<StaffMember[]>();
    expect(staff.find((member) => member.email === email)?.status).toBe('active');
  });

  it('shows the invitee what they are joining before they commit', async () => {
    const created = (await invite()).json<CreatedInvitation>();

    const preview = await request('POST', '/auth/invitations/preview', null, {
      token: tokenFromLink(created),
    });

    expect(preview.statusCode).toBe(200);
    const body = preview.json<{ institutionName: string; roleCode: string }>();
    expect(body.institutionName).toContain('Seed Institution');
    expect(body.roleCode).toBe('loan_officer');
  });

  it('refuses a token that has been tampered with', async () => {
    const created = (await invite()).json<CreatedInvitation>();
    const token = tokenFromLink(created);
    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;

    const response = await request('POST', '/auth/invitations/acceptance', null, {
      token: tampered,
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a replayed token', async () => {
    const created = (await invite()).json<CreatedInvitation>();
    const token = tokenFromLink(created);

    expect(
      (
        await request('POST', '/auth/invitations/acceptance', null, {
          token,
          password: NEW_PASSWORD,
        })
      ).statusCode,
    ).toBe(204);

    // Single use. The predicate is on the UPDATE itself, so a second request
    // matches no row rather than re-running the activation.
    const replay = await request('POST', '/auth/invitations/acceptance', null, {
      token,
      password: NEW_PASSWORD,
    });
    expect(replay.statusCode).toBe(422);
  });

  it('refuses an expired token', async () => {
    const created = (await invite()).json<CreatedInvitation>();

    // Wound the clock forward by moving the row rather than the process clock:
    // the expiry that matters is the one the database evaluates inside the
    // conditional UPDATE that consumes the invitation.
    await harness.database.withTransaction(async (db) => {
      await db.query(
        "UPDATE invitations SET expires_at = now() - interval '1 hour' WHERE id = $1",
        [created.invitation.id],
      );
    });

    const response = await request('POST', '/auth/invitations/acceptance', null, {
      token: tokenFromLink(created),
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a revoked token', async () => {
    const created = (await invite()).json<CreatedInvitation>();
    await request('POST', `/users/invitations/${created.invitation.id}/revocation`, adminToken);

    const response = await request('POST', '/auth/invitations/acceptance', null, {
      token: tokenFromLink(created),
      password: NEW_PASSWORD,
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a password the policy rejects, and leaves the invitation open', async () => {
    const created = (await invite()).json<CreatedInvitation>();
    const token = tokenFromLink(created);

    const tooShort = await request('POST', '/auth/invitations/acceptance', null, {
      token,
      password: 'short',
    });
    expect(tooShort.statusCode).toBe(400);

    // The refusal must not have consumed the invitation: a rejected password is
    // a typing mistake, and burning the link over one would strand the invitee.
    const retry = await request('POST', '/auth/invitations/acceptance', null, {
      token,
      password: NEW_PASSWORD,
    });
    expect(retry.statusCode).toBe(204);
  });
});

describe('tenant isolation', () => {
  it('shows one institution nothing of another’s invitations', async () => {
    await invite();

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);

    const listed = (await request('GET', '/users/invitations', strangerToken)).json<Invitation[]>();

    expect(listed).toEqual([]);
  });

  it('refuses revoking another institution’s invitation', async () => {
    const created = (await invite()).json<CreatedInvitation>();

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);

    const response = await request(
      'POST',
      `/users/invitations/${created.invitation.id}/revocation`,
      strangerToken,
    );

    // Not found rather than forbidden: a caller who cannot see it should not
    // learn that it exists.
    expect(response.statusCode).toBe(404);
  });

  it('shows one institution nothing of another’s staff', async () => {
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);

    const staff = (await request('GET', '/users', strangerToken)).json<StaffMember[]>();

    expect(staff.every((member) => member.email !== officer.email)).toBe(true);
  });
});

describe('PATCH /users/:id', () => {
  it('suspends a member of staff, and login then refuses them', async () => {
    const email = freshEmail();
    const created = (await invite({ email })).json<CreatedInvitation>();
    await request('POST', '/auth/invitations/acceptance', null, {
      token: tokenFromLink(created),
      password: NEW_PASSWORD,
    });

    const staff = (await request('GET', '/users', adminToken)).json<StaffMember[]>();
    const member = staff.find((entry) => entry.email === email)!;

    const suspended = await request('PATCH', `/users/${member.id}`, adminToken, {
      status: 'suspended',
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json<StaffMember>().status).toBe('suspended');

    const login = await request('POST', '/auth/login', null, { email, password: NEW_PASSWORD });
    expect(login.statusCode).toBe(403);
  });

  it('refuses an administrator changing their own account', async () => {
    // What keeps an institution from losing its last administrator: every
    // caller here holds `user.manage`, which only `institution_admin` has, and
    // none of them can suspend themselves — so one always remains.
    const response = await request('PATCH', `/users/${admin.userId}`, adminToken, {
      status: 'suspended',
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses activating somebody who has not accepted yet', async () => {
    const email = freshEmail();
    await invite({ email });

    const staff = (await request('GET', '/users', adminToken)).json<StaffMember[]>();
    const invited = staff.find((entry) => entry.email === email)!;

    const response = await request('PATCH', `/users/${invited.id}`, adminToken, {
      status: 'active',
    });

    // `users_active_requires_password` would refuse it at the database anyway.
    // An account marked active with no password is one that cannot sign in but
    // looks as though it can.
    expect(response.statusCode).toBe(422);
  });

  it('refuses an officer, who does not hold user.manage', async () => {
    const response = await request('PATCH', `/users/${admin.userId}`, officerToken, {
      status: 'suspended',
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses amending somebody in another institution', async () => {
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);

    const response = await request('PATCH', `/users/${officer.userId}`, strangerToken, {
      status: 'suspended',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /users', () => {
  it('refuses a caller without user.read', async () => {
    // The officer holds neither user.read nor user.manage.
    expect((await request('GET', '/users', officerToken)).statusCode).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await request('GET', '/users', null)).statusCode).toBe(401);
  });
});
