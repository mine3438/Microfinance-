import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Cross-tenant isolation.
 *
 * `00-PROJECT-ANALYSIS.md` records R6: in the system this replaces, row-level
 * security was the only thing standing between one institution's loan book and
 * another's, and nothing proved it held. A policy with a subtly wrong predicate
 * is not a degraded feature — it is a full cross-tenant data leak, and it looks
 * identical to working software.
 *
 * So these run on every commit. Each asserts one way a tenant boundary can be
 * crossed: reading, writing, re-tagging a row, or forgetting the context
 * entirely.
 */

const INSTITUTION_A = '11111111-1111-7111-8111-111111111111';
const INSTITUTION_B = '22222222-2222-7222-8222-222222222222';

let pool: pg.Pool;
let db: Database;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

/**
 * Reset to two institutions, one branch each. Runs as the privileged owner.
 *
 * Scoped to this file's own institutions rather than truncating the tables, so
 * the suite neither depends on nor destroys fixtures belonging to another file.
 */
beforeEach(async () => {
  const owned = [INSTITUTION_A, INSTITUTION_B];

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM code_sequences WHERE institution_id = ANY($1::uuid[])', [
      owned,
    ]);
    await client.query('DELETE FROM branches WHERE institution_id = ANY($1::uuid[])', [owned]);
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);
    await client.query(
      `INSERT INTO institutions (id, name, msp_code) VALUES ($1, $2, $3), ($4, $5, $6)`,
      [INSTITUTION_A, 'Institution A', 'M001', INSTITUTION_B, 'Institution B', 'M002'],
    );
    await client.query(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'BR-A', 'A Head Office', true), ($2, 'BR-B', 'B Head Office', true)`,
      [INSTITUTION_A, INSTITUTION_B],
    );
  });
});

describe('reading across tenants', () => {
  it('shows an institution only itself', async () => {
    const rows = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM institutions');
        return result.rows;
      },
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(INSTITUTION_A);
  });

  it('shows only the tenant’s own branches', async () => {
    const rows = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ code: string }>('SELECT code FROM branches');
        return result.rows;
      },
    );

    expect(rows.map((row) => row.code)).toEqual(['BR-A']);
  });

  it('hides another tenant’s row even when asked for it by primary key', async () => {
    const rows = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ code: string }>(
          'SELECT code FROM branches WHERE institution_id = $1',
          [INSTITUTION_B],
        );
        return result.rows;
      },
    );

    expect(rows).toEqual([]);
  });

  it('excludes other tenants from aggregates, not just from row lists', async () => {
    // A count that leaks is as much a disclosure as a row that leaks.
    const count = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM branches',
        );
        return result.rows[0]?.count;
      },
    );

    expect(count).toBe('1');
  });
});

describe('writing across tenants', () => {
  it('refuses an insert tagged with another tenant', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'X', 'Cross tenant')`,
          [INSTITUTION_B],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('updates nothing when targeting another tenant’s row', async () => {
    const updated = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query('UPDATE branches SET name = $1 WHERE code = $2', [
          'renamed',
          'BR-B',
        ]);
        return result.rowCount;
      },
    );

    expect(updated).toBe(0);

    const untouched = await db.withTransaction(async (client) => {
      const result = await client.query<{ name: string }>(
        'SELECT name FROM branches WHERE code = $1',
        ['BR-B'],
      );
      return result.rows[0]?.name;
    });
    expect(untouched).toBe('B Head Office');
  });

  it('deletes nothing when targeting another tenant’s row', async () => {
    const deleted = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query('DELETE FROM branches WHERE code = $1', ['BR-B']);
        return result.rowCount;
      },
    );

    expect(deleted).toBe(0);

    const survivors = await db.withTransaction(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM branches WHERE institution_id = ANY($1::uuid[])',
        [[INSTITUTION_A, INSTITUTION_B]],
      );
      return result.rows[0]?.count;
    });
    expect(survivors).toBe('2');
  });

  it('refuses to re-tag its own row to another tenant', async () => {
    // Without WITH CHECK on UPDATE, a tenant could hand its rows to another
    // institution — or quietly take one for itself.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query('UPDATE branches SET institution_id = $1 WHERE code = $2', [
          INSTITUTION_B,
          'BR-A',
        ]);
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses to create an institution from inside a tenant transaction', async () => {
    // Signup is a system operation that precedes any tenant, so there is no
    // INSERT policy on institutions at all.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query('INSERT INTO institutions (name) VALUES ($1)', ['Institution C']);
      }),
    ).rejects.toThrow();
  });

  it('permits writes within the tenant’s own boundary', async () => {
    // The counterpart to every refusal above: isolation that also blocks
    // legitimate work would pass these tests and be useless.
    const created = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ code: string }>(
          `INSERT INTO branches (institution_id, code, name)
           VALUES ($1, 'BR-A2', 'A Second Branch') RETURNING code`,
          [INSTITUTION_A],
        );
        return result.rows[0]?.code;
      },
    );

    expect(created).toBe('BR-A2');
  });
});

describe('missing tenant context', () => {
  it('is refused before any statement runs', async () => {
    await expect(
      // @ts-expect-error — the type requires a context; this proves the runtime does too.
      db.withTenantTransaction(undefined, () => Promise.resolve(undefined)),
    ).rejects.toThrow(/no tenant context/i);
  });

  it.each([
    ['empty string', ''],
    ['not a UUID', 'institution-a'],
    ['almost a UUID', '11111111-1111-7111-8111-11111111111'],
  ])('is refused when institutionId is %s', async (_label, institutionId) => {
    await expect(
      db.withTenantTransaction({ institutionId }, () => Promise.resolve(undefined)),
    ).rejects.toThrow(/tenant context/i);
  });

  it('yields no rows when the setting is absent at the database level', async () => {
    // Belt and braces: even if the application guard were removed, policies
    // must fail closed rather than open.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE mfi_app');
      const institutions = await client.query('SELECT id FROM institutions');
      const branches = await client.query('SELECT id FROM branches');
      await client.query('COMMIT');

      expect(institutions.rows).toEqual([]);
      expect(branches.rows).toEqual([]);
    } finally {
      client.release();
    }
  });
});

describe('tenant context lifetime', () => {
  it('does not survive onto the next transaction on a pooled connection', async () => {
    // The setting is applied with is_local => true. Were it session-scoped, a
    // recycled connection would carry one request's tenant into the next.
    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      const result = await client.query<{ id: string | null }>(
        'SELECT current_institution_id() AS id',
      );
      expect(result.rows[0]?.id).toBe(INSTITUTION_A);
    });

    const leaked = await db.withTransaction(async (client) => {
      const result = await client.query<{ id: string | null }>(
        'SELECT current_institution_id() AS id',
      );
      return result.rows[0]?.id;
    });

    expect(leaked).toBeNull();
  });

  it('rolls back on failure without leaving the tenant setting behind', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO branches (institution_id, code, name) VALUES ($1, 'BR-TMP', 'Temp')`,
          [INSTITUTION_A],
        );
        throw new Error('deliberate failure');
      }),
    ).rejects.toThrow('deliberate failure');

    const remaining = await db.withTransaction(async (client) => {
      const result = await client.query<{ code: string }>(
        'SELECT code FROM branches WHERE code = $1',
        ['BR-TMP'],
      );
      return result.rows;
    });
    expect(remaining).toEqual([]);
  });

  it('runs as the least-privilege role, not the connecting role', async () => {
    // If the application ran as the table owner, every policy above would be
    // decorative — an owner bypasses RLS unless the table is FORCEd.
    const role = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ role: string }>('SELECT current_user AS role');
        return result.rows[0]?.role;
      },
    );

    expect(role).toBe('mfi_app');
  });
});

describe('the isolation harness itself', () => {
  it('can observe both institutions when unscoped, so the assertions above mean something', async () => {
    // Without this, a suite that saw nothing at all would pass every isolation
    // test while proving only that the database was empty.
    const count = await db.withTransaction(async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM institutions WHERE id = ANY($1::uuid[])',
        [[INSTITUTION_A, INSTITUTION_B]],
      );
      return result.rows[0]?.count;
    });

    expect(count).toBe('2');
  });
});
