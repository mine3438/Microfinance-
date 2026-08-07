import { Money } from '@mfi/money';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { Database, TENANT_SETTING } from '../src/database.js';
import { TYPE_OIDS, assertExactNumericsAreSafe } from '../src/driver-safety.js';
import {
  DatabaseError,
  SchemaVersionError,
  UnsafeDriverConfigurationError,
} from '../src/errors.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * This file owns its fixture rather than relying on rows another test file
 * happens to have created. An inter-file dependency passes or fails on
 * execution order, which is exactly the kind of test that goes green until the
 * day it does not.
 */
const INSTITUTION_ID = '33333333-3333-7333-8333-333333333333';

let pool: pg.Pool;
let db: Database;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);

  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO institutions (id, name) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [INSTITUTION_ID, 'Database Test Institution'],
    );
  });
});

afterAll(async () => {
  await db.close();
});

describe('driver safety', () => {
  afterEach(() => {
    pg.types.setTypeParser(TYPE_OIDS.numeric, (value: string) => value);
    pg.types.setTypeParser(TYPE_OIDS.int8, (value: string) => value);
  });

  it('passes against a default driver', () => {
    expect(() => {
      assertExactNumericsAreSafe();
    }).not.toThrow();
  });

  it('detects a NUMERIC parser that returns a float', () => {
    // Proves the check can fail. Without this, a broken assertion would be
    // indistinguishable from a healthy driver.
    pg.types.setTypeParser(TYPE_OIDS.numeric, Number.parseFloat);

    expect(() => {
      assertExactNumericsAreSafe();
    }).toThrow(UnsafeDriverConfigurationError);
  });

  it('detects a parser that silently alters its input', () => {
    pg.types.setTypeParser(TYPE_OIDS.numeric, (value: string) => value.slice(0, 4));

    expect(() => {
      assertExactNumericsAreSafe();
    }).toThrow(/altered its input/);
  });

  it('refuses to construct a Database against an unsafe driver', () => {
    pg.types.setTypeParser(TYPE_OIDS.numeric, Number.parseFloat);

    expect(() => new Database(pool)).toThrow(UnsafeDriverConfigurationError);
  });

  it('can be waived explicitly, but only explicitly', () => {
    pg.types.setTypeParser(TYPE_OIDS.numeric, Number.parseFloat);

    expect(() => new Database(pool, { verifyDriverSafety: false })).not.toThrow();
  });
});

describe('NUMERIC round-trips as an exact Money value', () => {
  it('reads a monetary column back without precision loss', async () => {
    const value = await db.withTransaction(async (client) => {
      const result = await client.query<{ amount: unknown }>(
        `SELECT '9999999999999.99'::NUMERIC(15,2) AS amount`,
      );
      return Money.fromDatabaseValue(result.rows[0]?.amount);
    });

    expect(value.toDatabaseValue()).toBe('9999999999999.99');
  });

  it('preserves a sum a double could not represent', async () => {
    const value = await db.withTransaction(async (client) => {
      const result = await client.query<{ amount: unknown }>(
        `SELECT ('0.1'::NUMERIC + '0.2'::NUMERIC)::NUMERIC(15,2) AS amount`,
      );
      return Money.fromDatabaseValue(result.rows[0]?.amount);
    });

    expect(value.toDatabaseValue()).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('writes and reads back the same amount', async () => {
    const original = Money.of('1234567.89');

    const roundTripped = await db.withTransaction(async (client) => {
      const result = await client.query<{ amount: unknown }>('SELECT $1::NUMERIC(15,2) AS amount', [
        original.toDatabaseValue(),
      ]);
      return Money.fromDatabaseValue(result.rows[0]?.amount);
    });

    expect(roundTripped.equals(original)).toBe(true);
  });
});

describe('Database construction', () => {
  it.each(['bad role', 'DROP ROLE', 'x; SELECT 1', '1_leading_digit'])(
    'rejects unsafe application role %j',
    (role) => {
      expect(() => new Database(pool, { applicationRole: role })).toThrow(DatabaseError);
    },
  );

  it('accepts a null application role, leaving the connection role alone', async () => {
    const plain = new Database(pool, { applicationRole: null });

    const role = await plain.withTenantTransaction(
      { institutionId: INSTITUTION_ID },
      async (client) => {
        const result = await client.query<{ role: string }>('SELECT current_user AS role');
        return result.rows[0]?.role;
      },
    );

    expect(role).not.toBe('mfi_app');
  });
});

describe('transactions', () => {
  it('commits work that succeeds', async () => {
    const value = await db.withTransaction(async (client) => {
      const result = await client.query<{ answer: string }>(`SELECT 'committed' AS answer`);
      return result.rows[0]?.answer;
    });

    expect(value).toBe('committed');
  });

  it('rolls back work that throws, and propagates the original error', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query('CREATE TEMP TABLE rollback_probe (id int)');
        throw new Error('deliberate');
      }),
    ).rejects.toThrow('deliberate');
  });

  it('returns the connection to the pool after a failure', async () => {
    // A transaction helper that leaks connections exhausts the pool under load,
    // which surfaces as unexplained timeouts rather than as an error.
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await expect(
        db.withTransaction(() => Promise.reject(new Error('deliberate'))),
      ).rejects.toThrow('deliberate');
    }

    await expect(
      db.withTransaction(async (client) => {
        const result = await client.query<{ ok: number }>('SELECT 1 AS ok');
        return result.rows[0]?.ok;
      }),
    ).resolves.toBe(1);
  });
});

describe('readiness verification', () => {
  it('passes against a migrated database', async () => {
    await expect(db.verifyReadiness()).resolves.toBeUndefined();
  });

  it('confirms the tenant setting round-trips through current_institution_id()', async () => {
    // The specific failure this guards, recorded as R4 in the analysis: tenant
    // resolution silently returning NULL, every policy evaluating false, and the
    // application showing empty screens with no error anywhere.
    const probe = '00000000-0000-7000-8000-000000000000';

    const resolved = await db.withTransaction(async (client) => {
      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, probe]);
      const result = await client.query<{ id: string | null }>(
        'SELECT current_institution_id() AS id',
      );
      return result.rows[0]?.id;
    });

    expect(resolved).toBe(probe);
  });

  it('fails against a database that has never been migrated', async () => {
    const admin = new pg.Pool({ connectionString: testDatabaseUrl() });
    try {
      await admin.query('CREATE DATABASE mfi_db_unmigrated');
    } catch {
      await admin.query('DROP DATABASE IF EXISTS mfi_db_unmigrated');
      await admin.query('CREATE DATABASE mfi_db_unmigrated');
    }
    await admin.end();

    const url = new URL(testDatabaseUrl());
    url.pathname = '/mfi_db_unmigrated';
    const unmigrated = Database.fromConnectionString(url.toString());

    try {
      await expect(unmigrated.verifyReadiness()).rejects.toThrow(SchemaVersionError);
    } finally {
      await unmigrated.close();
      const cleanup = new pg.Pool({ connectionString: testDatabaseUrl() });
      await cleanup.query('DROP DATABASE IF EXISTS mfi_db_unmigrated');
      await cleanup.end();
    }
  });
});

describe('entity code allocation', () => {
  const institutionId = INSTITUTION_ID;

  it('issues sequential codes within an institution and year', async () => {
    const codes = await db.withTenantTransaction({ institutionId }, async (client) => {
      const first = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'loan', 'LN', 2026) AS code`,
        [institutionId],
      );
      const second = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'loan', 'LN', 2026) AS code`,
        [institutionId],
      );
      return [first.rows[0]?.code, second.rows[0]?.code];
    });

    expect(codes[0]).toMatch(/^LN-2026-\d{3}$/);
    expect(codes[1]).toMatch(/^LN-2026-\d{3}$/);
    expect(codes[0]).not.toBe(codes[1]);
  });

  it('keeps separate series per entity', async () => {
    const [loan, client_] = await db.withTenantTransaction({ institutionId }, async (client) => {
      const loanCode = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'loan_isolated', 'LN', 2030) AS code`,
        [institutionId],
      );
      const clientCode = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'client_isolated', 'MFI', 2030) AS code`,
        [institutionId],
      );
      return [loanCode.rows[0]?.code, clientCode.rows[0]?.code];
    });

    expect(loan).toBe('LN-2030-001');
    expect(client_).toBe('MFI-2030-001');
  });

  it('never issues the same code twice under concurrency', async () => {
    // The race this replaces: deriving the next number by parsing MAX(code)
    // lets two simultaneous inserts compute the same value (analysis R7).
    const concurrency = 25;

    const codes = await Promise.all(
      Array.from({ length: concurrency }, () =>
        db.withTenantTransaction({ institutionId }, async (client) => {
          const result = await client.query<{ code: string }>(
            `SELECT allocate_entity_code($1, 'concurrent', 'CC', 2027) AS code`,
            [institutionId],
          );
          return result.rows[0]?.code;
        }),
      ),
    );

    expect(new Set(codes).size).toBe(concurrency);
  });

  it('refuses allocation without an institution', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(`SELECT allocate_entity_code(NULL, 'loan', 'LN', 2026)`);
      }),
    ).rejects.toThrow(/institution_id is required/);
  });
});
