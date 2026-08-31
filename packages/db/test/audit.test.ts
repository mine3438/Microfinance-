import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Audit logging.
 *
 * The previous system had this table, its policies, and nothing writing to it —
 * "currently decorative", empty in every deployment (analysis R8). These tests
 * exist to keep that from recurring: they assert entries are actually produced,
 * that they carry the actor, that secrets never reach them, and that no
 * application role can amend one afterwards.
 */

const INSTITUTION = '88888888-8888-7888-8888-888888888888';
const OTHER_INSTITUTION = '99999999-9999-7999-8999-999999999999';

let pool: pg.Pool;
let db: Database;
let adminUser: string;
let auditorUser: string;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  const owned = [INSTITUTION, OTHER_INSTITUTION];

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);
    for (const table of ['user_roles', 'invitations', 'users', 'branches']) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = ANY($1::uuid[])`, [owned]);
    }
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);

    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      INSTITUTION,
      'Audited Institution',
      OTHER_INSTITUTION,
      'Other Institution',
    ]);

    const users = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (institution_id, email, full_name, password_hash, status)
       VALUES ($1, 'admin@audit.test',   'Audit Admin',   'hashed-secret', 'active'),
              ($1, 'auditor@audit.test', 'Audit Auditor', 'hashed-secret', 'active')
       RETURNING id, email`,
      [INSTITUTION],
    );
    adminUser = users.rows.find((row) => row.email === 'admin@audit.test')?.id ?? '';
    auditorUser = users.rows.find((row) => row.email === 'auditor@audit.test')?.id ?? '';

    await client.query(
      `INSERT INTO user_roles (institution_id, user_id, role_code) VALUES
         ($1, $2, 'institution_admin'), ($1, $3, 'auditor')`,
      [INSTITUTION, adminUser, auditorUser],
    );

    // Clear the entries the fixture itself produced, so each test observes only
    // what it does.
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);
  });
});

interface AuditRow {
  table_name: string;
  operation: string;
  row_id: string | null;
  actor_user_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  changed_columns: string[] | null;
}

const auditEntries = async (tableName?: string): Promise<AuditRow[]> => {
  const result = await pool.query<AuditRow>(
    `SELECT table_name, operation, row_id, actor_user_id, before_data, after_data, changed_columns
       FROM audit_logs
      WHERE institution_id = $1 AND ($2::text IS NULL OR table_name = $2)
      ORDER BY changed_at, id`,
    [INSTITUTION, tableName ?? null],
  );
  return result.rows;
};

describe('entries are produced', () => {
  it('records an insert', async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-1', 'First Branch')`,
          [INSTITUTION],
        );
      },
    );

    const entries = await auditEntries('branches');

    expect(entries).toHaveLength(1);
    expect(entries[0]?.operation).toBe('INSERT');
    expect(entries[0]?.before_data).toBeNull();
    expect(entries[0]?.after_data).toMatchObject({ code: 'BR-1', name: 'First Branch' });
  });

  it('records an update with both sides and the columns that moved', async () => {
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(
        `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-2', 'Old')`,
        [INSTITUTION],
      );
    });
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(`UPDATE branches SET name = 'New' WHERE code = 'BR-2'`);
    });

    const update = (await auditEntries('branches')).find((entry) => entry.operation === 'UPDATE');

    expect(update?.before_data).toMatchObject({ name: 'Old' });
    expect(update?.after_data).toMatchObject({ name: 'New' });
    expect(update?.changed_columns).toContain('name');
  });

  it('lists only columns whose value actually moved', async () => {
    // An UPDATE setting a column to the value it already held is not a change,
    // and reporting it as one makes the log harder to read for no benefit.
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(
        `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-3', 'Same')`,
        [INSTITUTION],
      );
    });
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(`UPDATE branches SET name = 'Same', status = 'closed' WHERE code = 'BR-3'`);
    });

    const update = (await auditEntries('branches')).find((entry) => entry.operation === 'UPDATE');

    expect(update?.changed_columns).toContain('status');
    expect(update?.changed_columns).not.toContain('name');
  });

  it('records a delete with the row that was removed', async () => {
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(
        `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-4', 'Doomed')`,
        [INSTITUTION],
      );
    });
    await db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
      await c.query(`DELETE FROM branches WHERE code = 'BR-4'`);
    });

    const removal = (await auditEntries('branches')).find((entry) => entry.operation === 'DELETE');

    expect(removal?.before_data).toMatchObject({ code: 'BR-4' });
    expect(removal?.after_data).toBeNull();
  });

  it('records changes made through a system transaction too', async () => {
    // Signup creates an institution before any user exists. That still has to
    // be auditable, with a null actor rather than no entry.
    const entries = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs
        WHERE table_name = 'institutions' AND institution_id = $1`,
      [OTHER_INSTITUTION],
    );

    // The fixture cleared this institution's entries, so create one now.
    await db.withTransaction(async (client) => {
      await client.query(`UPDATE institutions SET name = 'Renamed' WHERE id = $1`, [
        OTHER_INSTITUTION,
      ]);
    });

    const after = await pool.query<{ actor_user_id: string | null }>(
      `SELECT actor_user_id FROM audit_logs
        WHERE table_name = 'institutions' AND institution_id = $1 AND operation = 'UPDATE'`,
      [OTHER_INSTITUTION],
    );

    expect(entries.rows[0]?.count).toBe('0');
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]?.actor_user_id).toBeNull();
  });
});

describe('the actor', () => {
  it('is recorded from the acting user', async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-5', 'Attributed')`,
          [INSTITUTION],
        );
      },
    );

    const entries = await auditEntries('branches');

    expect(entries[0]?.actor_user_id).toBe(adminUser);
  });

  it('is null when no user is acting', async () => {
    // A scheduled job has no principal. Recording null is honest; inventing one
    // would put a name against a change nobody made.
    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      await client.query(
        `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-6', 'Unattributed')`,
        [INSTITUTION],
      );
    });

    const entries = await auditEntries('branches');

    expect(entries[0]?.actor_user_id).toBeNull();
  });
});

describe('secrets never reach the log', () => {
  it('omits password_hash when a user is created', async () => {
    // An audit trail holding password hashes is a second credential store, with
    // longer retention and a wider read audience than the first.
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO users (institution_id, email, full_name, password_hash, status)
           VALUES ($1, 'secret@audit.test', 'Secret Holder', 'super-secret-hash', 'active')`,
          [INSTITUTION],
        );
      },
    );

    const entry = (await auditEntries('users')).find((row) => row.operation === 'INSERT');

    expect(entry?.after_data).toMatchObject({ email: 'secret@audit.test' });
    expect(entry?.after_data).not.toHaveProperty('password_hash');
    expect(JSON.stringify(entry)).not.toContain('super-secret-hash');
  });

  it('omits password_hash from both sides of a password change', async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [
          'rotated-secret-hash',
          adminUser,
        ]);
      },
    );

    const entry = (await auditEntries('users')).find((row) => row.operation === 'UPDATE');

    expect(entry).toBeDefined();
    expect(entry?.before_data).not.toHaveProperty('password_hash');
    expect(entry?.after_data).not.toHaveProperty('password_hash');
    expect(JSON.stringify(entry)).not.toContain('rotated-secret-hash');
  });

  it('omits token_hash when an invitation is created', async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO invitations
             (institution_id, email, full_name, role_code, token_hash, invited_by, expires_at)
           VALUES ($1, 'invited@audit.test', 'Invitee', 'loan_officer', 'secret-token-hash', $2,
                   now() + interval '7 days')`,
          [INSTITUTION, adminUser],
        );
      },
    );

    const entry = (await auditEntries('invitations'))[0];

    expect(entry?.after_data).toMatchObject({ email: 'invited@audit.test' });
    expect(entry?.after_data).not.toHaveProperty('token_hash');
    expect(JSON.stringify(entry)).not.toContain('secret-token-hash');
  });
});

describe('the log cannot be tampered with', () => {
  beforeEach(async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-T', 'Tamper Target')`,
          [INSTITUTION],
        );
      },
    );
  });

  it.each([
    ['amend', `UPDATE audit_logs SET after_data = '{}'::jsonb`],
    ['remove', 'DELETE FROM audit_logs'],
    [
      'forge',
      `INSERT INTO audit_logs (institution_id, table_name, operation)
       VALUES ('88888888-8888-7888-8888-888888888888', 'branches', 'INSERT')`,
    ],
  ])('refuses an attempt to %s an entry', async (_label, sql) => {
    // An entry that can be amended, removed, or fabricated is not evidence.
    // The privilege is withheld outright, so this fails loudly rather than
    // silently affecting zero rows.
    await expect(
      db.withTenantTransaction(
        { institutionId: INSTITUTION, userId: adminUser },
        async (client) => {
          await client.query(sql);
        },
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it('leaves the entry intact after a failed tampering attempt', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION, userId: adminUser }, async (c) => {
        await c.query('DELETE FROM audit_logs');
      }),
    ).rejects.toThrow();

    expect((await auditEntries('branches')).length).toBeGreaterThan(0);
  });
});

describe('reading the log', () => {
  beforeEach(async () => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: adminUser },
      async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-R', 'Readable')`,
          [INSTITUTION],
        );
      },
    );
  });

  it('is visible to a user holding audit.read', async () => {
    const visible = await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: auditorUser },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM audit_logs',
        );
        return result.rows[0]?.count;
      },
    );

    expect(Number(visible)).toBeGreaterThan(0);
  });

  it('is hidden from a user without audit.read', async () => {
    // An audit trail every account can browse leaks the institution's internal
    // activity to anyone with a login.
    const officer = await db.withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO users (institution_id, email, full_name, password_hash, status)
         VALUES ($1, 'officer@audit.test', 'Officer', 'x', 'active') RETURNING id`,
        [INSTITUTION],
      );
      const id = result.rows[0]?.id ?? '';
      await client.query(
        `INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, 'loan_officer')`,
        [INSTITUTION, id],
      );
      return id;
    });

    const visible = await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: officer },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM audit_logs',
        );
        return result.rows[0]?.count;
      },
    );

    expect(visible).toBe('0');
  });

  it('is hidden from another institution entirely', async () => {
    const visible = await db.withTenantTransaction(
      { institutionId: OTHER_INSTITUTION, userId: adminUser },
      async (client) => {
        const result = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM audit_logs WHERE table_name = 'branches'`,
        );
        return result.rows[0]?.count;
      },
    );

    expect(visible).toBe('0');
  });
});
