import { describe, expect, it } from 'vitest';

import {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  loginRequestSchema,
  loginResponseSchema,
  passwordSchema,
  sessionUserSchema,
} from './auth.js';
import { PERMISSIONS, ROLES } from './authorization.js';

describe('passwordSchema', () => {
  it('accepts a passphrase at the minimum length', () => {
    const passphrase = 'a'.repeat(MINIMUM_PASSWORD_LENGTH);
    expect(passwordSchema.parse(passphrase)).toBe(passphrase);
  });

  it('rejects one character below the minimum', () => {
    expect(passwordSchema.safeParse('a'.repeat(MINIMUM_PASSWORD_LENGTH - 1)).success).toBe(false);
  });

  it('bounds the maximum, since argon2id hashes whatever length it is given', () => {
    // Without a cap this field is a CPU-exhaustion vector aimed at the most
    // expensive operation the server performs.
    expect(passwordSchema.safeParse('a'.repeat(MAXIMUM_PASSWORD_LENGTH + 1)).success).toBe(false);
  });

  it('preserves surrounding whitespace rather than trimming it', () => {
    // Spaces are legitimate passphrase characters. Trimming here would mean a
    // password set through one client cannot be typed into another.
    expect(passwordSchema.parse('  correct horse  ')).toBe('  correct horse  ');
  });

  it('accepts a passphrase with no digit, upper case or symbol', () => {
    // Composition rules push people towards `Password1!`, which is weaker than
    // a long phrase. NIST SP 800-63B has advised against them since 2017.
    expect(passwordSchema.safeParse('correct horse battery staple').success).toBe(true);
  });
});

describe('loginRequestSchema', () => {
  it('normalises the email so it matches the lower(email) unique index', () => {
    const parsed = loginRequestSchema.parse({
      email: '  Officer@Institution.CO.TZ ',
      password: 'correct horse battery staple',
    });

    expect(parsed.email).toBe('officer@institution.co.tz');
  });

  it('does not hold an existing password to the current policy', () => {
    // A password set under an older policy must still be able to log in and be
    // prompted to change, rather than being locked out by a rule change.
    expect(
      loginRequestSchema.safeParse({ email: 'officer@x.co.tz', password: 'short' }).success,
    ).toBe(true);
  });

  it('rejects an unrecognised key rather than stripping it', () => {
    const result = loginRequestSchema.safeParse({
      email: 'officer@x.co.tz',
      password: 'correct horse battery staple',
      institutionId: '01930000-0000-7000-8000-000000000000',
    });

    // Tenancy is resolved from the credentials, never from the request. A
    // caller-supplied institution must be refused loudly, not ignored quietly.
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });

  it('requires a password rather than accepting an empty one', () => {
    expect(loginRequestSchema.safeParse({ email: 'officer@x.co.tz', password: '' }).success).toBe(
      false,
    );
  });
});

describe('sessionUserSchema', () => {
  const session = {
    id: '01930000-0000-7000-8000-000000000001',
    email: 'officer@institution.co.tz',
    fullName: 'Amina Hassan',
    institutionId: '01930000-0000-7000-8000-000000000002',
    institutionName: 'Faraja Microfinance',
    branch: {
      id: '01930000-0000-7000-8000-000000000003',
      name: 'Kariakoo',
      code: 'KRK',
    },
    roles: ['loan_officer'],
    permissions: ['client.read', 'loan.create'],
    emailVerifiedAt: '2026-01-15T09:00:00.000Z',
    lastLoginAt: null,
  };

  it('accepts a resolved session', () => {
    expect(sessionUserSchema.parse(session).roles).toEqual(['loan_officer']);
  });

  it('accepts a user with no branch, meaning institution-wide authority', () => {
    expect(sessionUserSchema.parse({ ...session, branch: null }).branch).toBeNull();
  });

  it('rejects a permission outside the catalogue', () => {
    expect(
      sessionUserSchema.safeParse({ ...session, permissions: ['loan.approve_everything'] }).success,
    ).toBe(false);
  });

  it('rejects a role outside the catalogue', () => {
    expect(sessionUserSchema.safeParse({ ...session, roles: ['superuser'] }).success).toBe(false);
  });

  it('carries no password hash, however it is spelled', () => {
    // The shape is strict, so a hash cannot be added to a response by accident
    // — including through a repository that selects * and spreads the row.
    for (const key of ['passwordHash', 'password_hash', 'password']) {
      expect(sessionUserSchema.safeParse({ ...session, [key]: 'x' }).success).toBe(false);
    }
  });
});

describe('loginResponseSchema', () => {
  const response = {
    accessToken: 'header.payload.signature',
    expiresIn: 900,
    user: {
      id: '01930000-0000-7000-8000-000000000001',
      email: 'officer@institution.co.tz',
      fullName: 'Amina Hassan',
      institutionId: '01930000-0000-7000-8000-000000000002',
      institutionName: 'Faraja Microfinance',
      branch: null,
      roles: ['institution_admin'],
      permissions: [...PERMISSIONS],
      emailVerifiedAt: null,
      lastLoginAt: null,
    },
  };

  it('accepts a login response carrying every permission', () => {
    expect(loginResponseSchema.parse(response).user.permissions).toHaveLength(PERMISSIONS.length);
  });

  it('has no field for the refresh token', () => {
    // The refresh token belongs in an HttpOnly cookie. A body field for it
    // would be readable by any script on the origin, which is the exfiltration
    // path the cookie exists to close — so the schema refuses to describe one.
    expect(loginResponseSchema.safeParse({ ...response, refreshToken: 'x' }).success).toBe(false);
  });

  it('rejects a non-positive token lifetime', () => {
    expect(loginResponseSchema.safeParse({ ...response, expiresIn: 0 }).success).toBe(false);
  });
});

describe('the catalogue', () => {
  it('names every role the identity migration seeds', () => {
    expect([...ROLES]).toEqual([
      'institution_admin',
      'branch_manager',
      'loan_officer',
      'accountant',
      'auditor',
    ]);
  });

  it('holds no duplicate permissions', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});
