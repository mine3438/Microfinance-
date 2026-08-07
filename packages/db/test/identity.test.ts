import { PERMISSIONS, ROLES, isPermission, isRoleCode } from '@mfi/identity';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Identity schema: tenant isolation, referential tenancy, and permission
 * resolution.
 *
 * The permission catalogue is asserted against `@mfi/identity`'s typed
 * constants. Those two copies exist for different reasons — the database is the
 * authority, the constants make a misspelled check a compile error — and if
 * they drift, permission checks silently start denying or granting the wrong
 * things. Nothing else would catch it.
 */

const INSTITUTION_A = '44444444-4444-7444-8444-444444444444';
const INSTITUTION_B = '55555555-5555-7555-8555-555555555555';

let pool: pg.Pool;
let db: Database;

let branchA: string;
let branchB: string;
let adminA: string;
let officerA: string;
let adminB: string;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

/** Two institutions, each with a branch, an administrator, and (for A) an officer. */
beforeEach(async () => {
  const owned = [INSTITUTION_A, INSTITUTION_B];

  await db.withTransaction(async (client) => {
    // Torn down in dependency order. Branches and users reference institutions
    // with ON DELETE RESTRICT precisely so financial history cannot be removed
    // by deleting its parent, so the fixture has to respect that rather than
    // rely on a cascade.
    for (const table of [
      'refresh_tokens',
      'user_tokens',
      'user_roles',
      'invitations',
      'users',
      'code_sequences',
      'branches',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = ANY($1::uuid[])`, [owned]);
    }
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);
    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      INSTITUTION_A,
      'Identity Institution A',
      INSTITUTION_B,
      'Identity Institution B',
    ]);

    const branches = await client.query<{ id: string; institution_id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'A Head Office', true), ($2, 'HQ', 'B Head Office', true)
       RETURNING id, institution_id`,
      [INSTITUTION_A, INSTITUTION_B],
    );
    branchA = branches.rows.find((row) => row.institution_id === INSTITUTION_A)?.id ?? '';
    branchB = branches.rows.find((row) => row.institution_id === INSTITUTION_B)?.id ?? '';

    const users = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, NULL,  'admin.a@example.test',   'Admin A',   'x', 'active'),
              ($1, $3,    'officer.a@example.test', 'Officer A', 'x', 'active'),
              ($2, NULL,  'admin.b@example.test',   'Admin B',   'x', 'active')
       RETURNING id, email`,
      [INSTITUTION_A, INSTITUTION_B, branchA],
    );
    adminA = users.rows.find((row) => row.email === 'admin.a@example.test')?.id ?? '';
    officerA = users.rows.find((row) => row.email === 'officer.a@example.test')?.id ?? '';
    adminB = users.rows.find((row) => row.email === 'admin.b@example.test')?.id ?? '';

    await client.query(
      `INSERT INTO user_roles (institution_id, user_id, role_code) VALUES
         ($1, $2, 'institution_admin'),
         ($1, $3, 'loan_officer'),
         ($4, $5, 'institution_admin')`,
      [INSTITUTION_A, adminA, officerA, INSTITUTION_B, adminB],
    );
  });
});

describe('the seeded permission catalogue', () => {
  it('matches the typed catalogue in @mfi/identity exactly', async () => {
    const result = await pool.query<{ code: string }>(
      'SELECT code FROM reference.permissions ORDER BY code',
    );
    const seeded = result.rows.map((row) => row.code);

    expect(seeded).toEqual([...PERMISSIONS].sort());
  });

  it('matches the typed role list exactly', async () => {
    const result = await pool.query<{ code: string }>(
      'SELECT code FROM reference.roles ORDER BY code',
    );

    expect(result.rows.map((row) => row.code)).toEqual([...ROLES].sort());
  });

  it('grants only permissions that exist', async () => {
    const result = await pool.query<{ permission_code: string }>(
      'SELECT DISTINCT permission_code FROM reference.role_permissions',
    );

    const unknown = result.rows
      .map((row) => row.permission_code)
      .filter((code) => !isPermission(code));
    expect(unknown).toEqual([]);
  });

  it('grants only to roles that exist', async () => {
    const result = await pool.query<{ role_code: string }>(
      'SELECT DISTINCT role_code FROM reference.role_permissions',
    );

    const unknown = result.rows.map((row) => row.role_code).filter((code) => !isRoleCode(code));
    expect(unknown).toEqual([]);
  });

  it('gives the administrator every permission', async () => {
    const result = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM reference.role_permissions
        WHERE role_code = 'institution_admin'`,
    );

    expect(result.rows[0]?.count).toBe(String(PERMISSIONS.length));
  });

  it('gives the auditor reads and nothing else', async () => {
    // A reader that can write is not an auditor.
    const result = await pool.query<{ permission_code: string }>(
      `SELECT permission_code FROM reference.role_permissions WHERE role_code = 'auditor'`,
    );

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.every((row) => row.permission_code.endsWith('.read'))).toBe(true);
  });

  it('withholds loan.approve and payment.reverse from the loan officer', async () => {
    // Segregation of duties, expressed in the seed rather than in a UI: the
    // officer who prepares an application must not be able to approve it.
    const result = await pool.query<{ permission_code: string }>(
      `SELECT permission_code FROM reference.role_permissions WHERE role_code = 'loan_officer'`,
    );
    const held = new Set(result.rows.map((row) => row.permission_code));

    expect(held.has('loan.approve')).toBe(false);
    expect(held.has('payment.reverse')).toBe(false);
    expect(held.has('loan.create')).toBe(true);
  });
});

describe('permission resolution', () => {
  it('resolves an administrator to every permission', async () => {
    const result = await pool.query<{ code: string }>(
      'SELECT * FROM user_permissions($1) AS code',
      [adminA],
    );

    expect(result.rows).toHaveLength(PERMISSIONS.length);
  });

  it('resolves an officer to their role’s permissions only', async () => {
    const result = await pool.query<{ code: string }>(
      'SELECT * FROM user_permissions($1) AS code',
      [officerA],
    );
    const held = new Set(result.rows.map((row) => row.code));

    expect(held.has('loan.create')).toBe(true);
    expect(held.has('loan.approve')).toBe(false);
  });

  it('resolves a user with no roles to nothing', async () => {
    const orphan = await db.withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (institution_id, email, full_name, status)
         VALUES ($1, 'noroles@example.test', 'No Roles', 'invited') RETURNING id`,
        [INSTITUTION_A],
      );
      return result.rows[0]?.id;
    });

    const result = await pool.query('SELECT * FROM user_permissions($1) AS code', [orphan]);
    expect(result.rows).toEqual([]);
  });

  it('answers has_permission() for the acting user', async () => {
    const allowed = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A, userId: officerA },
      async (client) => {
        const result = await client.query<{ create_loan: boolean; approve_loan: boolean }>(
          `SELECT has_permission('loan.create') AS create_loan,
                  has_permission('loan.approve') AS approve_loan`,
        );
        return result.rows[0];
      },
    );

    expect(allowed?.create_loan).toBe(true);
    expect(allowed?.approve_loan).toBe(false);
  });

  it('denies every permission when no user is acting', async () => {
    // A scheduled job or a migration has no principal, and absence of a
    // principal must not read as unrestricted authority.
    const allowed = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ granted: boolean }>(
          `SELECT has_permission('loan.read') AS granted`,
        );
        return result.rows[0]?.granted;
      },
    );

    expect(allowed).toBe(false);
  });
});

describe('identity tables are tenant-isolated', () => {
  it('shows only the tenant’s own users', async () => {
    const emails = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ email: string }>(
          'SELECT email FROM users ORDER BY email',
        );
        return result.rows.map((row) => row.email);
      },
    );

    expect(emails).toEqual(['admin.a@example.test', 'officer.a@example.test']);
  });

  it('shows only the tenant’s own role grants', async () => {
    const count = await db.withTenantTransaction(
      { institutionId: INSTITUTION_B },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM user_roles',
        );
        return result.rows[0]?.count;
      },
    );

    expect(count).toBe('1');
  });

  it('refuses to create a user in another institution', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name) VALUES ($1, $2, $3)`,
          [INSTITUTION_B, 'intruder@example.test', 'Intruder'],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to grant a role to another institution’s user', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, 'auditor')`,
          [INSTITUTION_A, adminB],
        );
      }),
    ).rejects.toThrow();
  });

  it('offers no DELETE on users, since history references them', async () => {
    // A user who approved a loan or recorded a payment is referenced by that
    // record. The account is suspended; it is never removed.
    //
    // The privilege is withheld outright rather than merely policy-denied, so
    // the attempt raises an error instead of quietly reporting zero rows
    // affected. Loud is better here: code that believes it deleted a user and
    // did not is worse than code that fails.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query('DELETE FROM users WHERE id = $1', [officerA]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('referential tenancy', () => {
  it('refuses to place a user in another institution’s branch', async () => {
    // Row-level security governs what a session may see. This governs what the
    // data may say, which is a different guarantee: without the composite
    // foreign key, a privileged path could write a user into a branch belonging
    // to a different institution and every branch-scoped report would be wrong.
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, branch_id, email, full_name)
           VALUES ($1, $2, 'misplaced@example.test', 'Misplaced')`,
          [INSTITUTION_A, branchB],
        );
      }),
    ).rejects.toThrow(/users_branch_within_institution|foreign key/i);
  });

  it('refuses to tag a role grant to the wrong institution', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, 'auditor')`,
          [INSTITUTION_B, officerA],
        );
      }),
    ).rejects.toThrow(/user_roles_user_within_institution|foreign key/i);
  });

  it('accepts a user in a branch of their own institution', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, branch_id, email, full_name)
           VALUES ($1, $2, 'correct@example.test', 'Correctly Placed')`,
          [INSTITUTION_A, branchA],
        );
      }),
    ).resolves.toBeUndefined();
  });
});

describe('user invariants', () => {
  it('keeps email unique across all institutions, since login resolves by it', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name) VALUES ($1, $2, $3)`,
          [INSTITUTION_B, 'ADMIN.A@example.test', 'Duplicate'],
        );
      }),
    ).rejects.toThrow(/users_email_unique|duplicate key/i);
  });

  it('refuses an active user with no password hash', async () => {
    // An account that cannot authenticate must not be marked active; an invited
    // one legitimately has no hash yet.
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name, status)
           VALUES ($1, 'nopassword@example.test', 'No Password', 'active')`,
          [INSTITUTION_A],
        );
      }),
    ).rejects.toThrow(/users_active_requires_password/i);
  });

  it('accepts an invited user with no password hash', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name, status)
           VALUES ($1, 'invited@example.test', 'Invited', 'invited')`,
          [INSTITUTION_A],
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an address with no at sign', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name) VALUES ($1, 'notanemail', 'Bad')`,
          [INSTITUTION_A],
        );
      }),
    ).rejects.toThrow(/users_email_check|violates check/i);
  });
});

describe('invitations', () => {
  // Every invitation mints its own token, as the real flow does — reusing one
  // would trip the token-hash uniqueness constraint rather than the behaviour
  // under test.
  let tokenCounter = 0;

  const insertInvitation = async (email: string, expiresInHours = 24): Promise<void> => {
    tokenCounter += 1;
    const tokenHash = `invitation-hash-${String(tokenCounter)}-${email}`;

    await db.withTenantTransaction(
      { institutionId: INSTITUTION_A, userId: adminA },
      async (client) => {
        await client.query(
          `INSERT INTO invitations
             (institution_id, branch_id, email, full_name, role_code, token_hash, invited_by, expires_at)
           VALUES ($1, $2, $3, 'Invitee', 'loan_officer', $4, $5, now() + ($6 || ' hours')::interval)`,
          [INSTITUTION_A, branchA, email, tokenHash, adminA, String(expiresInHours)],
        );
      },
    );
  };

  it('creates an invitation within the tenant', async () => {
    await expect(insertInvitation('invitee@example.test')).resolves.toBeUndefined();
  });

  it('permits only one live invitation per address', async () => {
    // Re-inviting must revoke the previous invitation, so an old link cannot
    // still be redeemed after a second is issued.
    await insertInvitation('duplicate@example.test');

    await expect(insertInvitation('duplicate@example.test')).rejects.toThrow(
      /invitations_one_pending_per_email|duplicate key/i,
    );
  });

  it('permits a fresh invitation once the previous one is revoked', async () => {
    await insertInvitation('revoked@example.test');

    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      await client.query(
        'UPDATE invitations SET revoked_at = now() WHERE lower(email) = lower($1)',
        ['revoked@example.test'],
      );
    });

    await expect(insertInvitation('revoked@example.test')).resolves.toBeUndefined();
  });

  it('refuses to be both accepted and revoked', async () => {
    await insertInvitation('conflicted@example.test');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `UPDATE invitations SET accepted_at = now(), revoked_at = now()
            WHERE lower(email) = lower($1)`,
          ['conflicted@example.test'],
        );
      }),
    ).rejects.toThrow(/invitations_not_both_accepted_and_revoked/i);
  });

  it('hides invitations from other institutions', async () => {
    await insertInvitation('hidden@example.test');

    const visible = await db.withTenantTransaction(
      { institutionId: INSTITUTION_B },
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM invitations');
        return result.rows;
      },
    );

    expect(visible).toEqual([]);
  });
});

describe('refresh tokens', () => {
  const FAMILY = '66666666-6666-7666-8666-666666666666';

  it('stores a token hash scoped to the tenant', async () => {
    await expect(
      db.withTenantTransaction(
        { institutionId: INSTITUTION_A, userId: officerA },
        async (client) => {
          await client.query(
            `INSERT INTO refresh_tokens (institution_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
            [INSTITUTION_A, officerA, FAMILY, 'a'.repeat(64)],
          );
        },
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a token for a user in another institution', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO refresh_tokens (institution_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
          [INSTITUTION_B, officerA, FAMILY, 'b'.repeat(64)],
        );
      }),
    ).rejects.toThrow(/refresh_tokens_user_within_institution|foreign key/i);
  });

  it('keeps token hashes unique, so one value cannot belong to two sessions', async () => {
    const hash = 'c'.repeat(64);
    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      await client.query(
        `INSERT INTO refresh_tokens (institution_id, user_id, family_id, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
        [INSTITUTION_A, officerA, FAMILY, hash],
      );
    });

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO refresh_tokens (institution_id, user_id, family_id, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '30 days')`,
          [INSTITUTION_A, adminA, FAMILY, hash],
        );
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});

describe('user tokens', () => {
  it.each(['email_verification', 'password_reset'])('accepts a %s token', async (purpose) => {
    // Two purposes, deliberately distinguished. The previous system offered
    // only password reset, so a user whose verification email was lost had no
    // route back — the interface conflated operations that are not the same.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO user_tokens (institution_id, user_id, purpose, token_hash, expires_at)
           VALUES ($1, $2, $3, $4, now() + interval '1 hour')`,
          [INSTITUTION_A, officerA, purpose, `${purpose}-hash`],
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects an unrecognised purpose', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO user_tokens (institution_id, user_id, purpose, token_hash, expires_at)
           VALUES ($1, $2, 'session_hijack', 'x', now() + interval '1 hour')`,
          [INSTITUTION_A, officerA],
        );
      }),
    ).rejects.toThrow(/user_tokens_purpose_check|violates check/i);
  });
});
