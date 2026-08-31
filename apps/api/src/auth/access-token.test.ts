import { type Principal } from '@mfi/identity';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import {
  AccessTokenService,
  InvalidTokenError,
  TOKEN_AUDIENCE,
  TOKEN_ISSUER,
} from './access-token.js';

const SECRET = 'unit-test-signing-secret-32-chars!!';
const OTHER_SECRET = 'a-different-signing-secret-32chars!!';

const service = new AccessTokenService({ secret: SECRET, ttlSeconds: 900 });

const principal: Principal = {
  userId: '01930000-0000-7000-8000-000000000001',
  institutionId: '01930000-0000-7000-8000-000000000002',
  branchId: '01930000-0000-7000-8000-000000000003',
  roles: ['loan_officer'],
  permissions: new Set(['client.read', 'loan.create']),
};

const key = new TextEncoder().encode(SECRET);

describe('AccessTokenService', () => {
  it('round-trips a principal', async () => {
    const verified = await service.verify(await service.issue(principal));

    expect(verified.userId).toBe(principal.userId);
    expect(verified.institutionId).toBe(principal.institutionId);
    expect(verified.branchId).toBe(principal.branchId);
    expect(verified.roles).toEqual(['loan_officer']);
    expect([...verified.permissions].sort()).toEqual(['client.read', 'loan.create']);
  });

  it('carries a null branch for institution-wide authority', async () => {
    const verified = await service.verify(await service.issue({ ...principal, branchId: null }));

    expect(verified.branchId).toBeNull();
  });

  it('refuses a token signed with a different key', async () => {
    const forged = new AccessTokenService({ secret: OTHER_SECRET, ttlSeconds: 900 });

    await expect(service.verify(await forged.issue(principal))).rejects.toThrow(InvalidTokenError);
  });

  it('refuses an expired token', async () => {
    const expired = await new SignJWT({ ...principal, sub: principal.userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(key);

    await expect(service.verify(expired)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses a token minted for another audience', async () => {
    // Without this check a token issued by some other service that happens to
    // share the secret would authenticate here.
    const wrongAudience = await new SignJWT({ sub: principal.userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience('some-other-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

    await expect(service.verify(wrongAudience)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses an unsigned token, whatever its header claims', async () => {
    // The `alg: none` confusion attack. The algorithm list passed to jwtVerify
    // is what closes it: a token asking to be verified with no algorithm is not
    // verified at all.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(
      JSON.stringify({
        sub: principal.userId,
        iid: principal.institutionId,
        bid: null,
        rol: [],
        prm: ['settings.manage'],
        iss: TOKEN_ISSUER,
        aud: TOKEN_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url');

    await expect(service.verify(`${header}.${body}.`)).rejects.toThrow(InvalidTokenError);
  });

  it('refuses a correctly signed token whose claims do not match the shape', async () => {
    // A token issued before a claim was renamed. Without the schema check the
    // missing claims would reach the principal as `undefined` and produce an
    // authorisation decision on absent data.
    const stale = await new SignJWT({ sub: principal.userId, institutionId: 'old-claim-name' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

    await expect(service.verify(stale)).rejects.toThrow(/claims do not match/);
  });

  it('refuses a token naming a permission outside the catalogue', async () => {
    // A permission the application cannot check must not reach a principal,
    // even from a token this server would otherwise trust.
    const invented = await new SignJWT({
      sub: principal.userId,
      iid: principal.institutionId,
      bid: null,
      rol: ['loan_officer'],
      prm: ['loan.approve_anything'],
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(key);

    await expect(service.verify(invented)).rejects.toThrow(InvalidTokenError);
  });

  it.each([
    ['empty', ''],
    ['not a JWT', 'nonsense'],
    ['two segments only', 'aaa.bbb'],
  ])('refuses a %s token', async (_label, token) => {
    await expect(service.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it('reports the lifetime it issues, so the client need not decode the token', () => {
    expect(service.lifetimeSeconds).toBe(900);
  });
});
