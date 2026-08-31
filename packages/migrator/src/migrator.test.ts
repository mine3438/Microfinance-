import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ChecksumMismatchError,
  MigrationExecutionError,
  MissingMigrationFileError,
  OutOfOrderMigrationError,
} from './errors.js';
import { Migrator, MIGRATION_LOCK_KEY, type MigrationLogger } from './migrator.js';

/**
 * Integration tests. These run against a real Postgres because the behaviour
 * under test *is* the database behaviour — transaction rollback, advisory
 * locking, DDL atomicity. A mocked driver would assert the mock, not the
 * guarantee.
 */
const CONNECTION_STRING =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres@localhost:5432/postgres';

let schema: string;
let dir: string;
let pool: pg.Pool;
let adminPool: pg.Pool;

const logs: string[] = [];
const logger: MigrationLogger = {
  info: (message) => logs.push(`info: ${message}`),
  warn: (message) => logs.push(`warn: ${message}`),
};

/** Each test gets its own schema so migrations cannot collide across tests. */
beforeEach(async () => {
  schema = `mig_test_${Math.random().toString(36).slice(2, 10)}`;
  dir = await mkdtemp(join(tmpdir(), 'mfi-migrator-'));
  logs.length = 0;

  adminPool = new pg.Pool({ connectionString: CONNECTION_STRING });
  await adminPool.query(`CREATE SCHEMA ${schema}`);

  pool = new pg.Pool({
    connectionString: CONNECTION_STRING,
    options: `-c search_path=${schema}`,
  });
});

afterEach(async () => {
  await pool.end();
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
  await rm(dir, { recursive: true, force: true });
});

const write = async (filename: string, sql: string): Promise<void> => {
  await writeFile(join(dir, filename), sql, 'utf8');
};

const makeMigrator = (): Migrator => new Migrator(pool, { migrationsDir: dir, logger });

const tableExists = async (name: string): Promise<boolean> => {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
     ) AS exists`,
    [schema, name],
  );
  return result.rows[0]?.exists ?? false;
};

describe('Migrator.migrate', () => {
  it('applies pending migrations in version order', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');
    await write('0002_add_column.sql', 'ALTER TABLE clients ADD COLUMN full_name TEXT;');

    const results = await makeMigrator().migrate();

    expect(results.map((result) => result.version)).toEqual(['0001', '0002']);
    await expect(tableExists('clients')).resolves.toBe(true);
  });

  it('is idempotent — a second run applies nothing', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');
    const migrator = makeMigrator();

    await migrator.migrate();
    const second = await migrator.migrate();

    expect(second).toEqual([]);
  });

  it('records version, name, filename and checksum in the registry', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');

    await makeMigrator().migrate();
    const { applied } = await makeMigrator().status();

    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      version: '0001',
      name: 'create_clients',
      filename: '0001_create_clients.sql',
    });
    expect(applied[0]?.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(applied[0]?.executionMs).toBeGreaterThanOrEqual(0);
  });

  it('rolls back a failing migration, leaving no partial schema', async () => {
    // Postgres is transactional for DDL, so the first statement's table must
    // disappear when the second statement fails.
    await write(
      '0001_partial.sql',
      'CREATE TABLE good (id INT); CREATE TABLE bad (id INT) WITH (nonexistent_option = 1);',
    );

    await expect(makeMigrator().migrate()).rejects.toThrow(MigrationExecutionError);

    await expect(tableExists('good')).resolves.toBe(false);
    const { applied } = await makeMigrator().status();
    expect(applied).toEqual([]);
  });

  it('stops at the first failure without applying later migrations', async () => {
    await write('0001_ok.sql', 'CREATE TABLE first_table (id INT);');
    await write('0002_broken.sql', 'THIS IS NOT SQL;');
    await write('0003_never_runs.sql', 'CREATE TABLE third_table (id INT);');

    await expect(makeMigrator().migrate()).rejects.toThrow(MigrationExecutionError);

    await expect(tableExists('first_table')).resolves.toBe(true);
    await expect(tableExists('third_table')).resolves.toBe(false);
  });

  it('applies a migration marked no-transaction and warns about it', async () => {
    await write('0001_base.sql', 'CREATE TABLE t (c INT);');
    await write(
      '0002_concurrent_index.sql',
      '-- mfi:no-transaction\nCREATE INDEX CONCURRENTLY t_c_idx ON t (c);',
    );

    const results = await makeMigrator().migrate();

    expect(results[1]?.ranOutsideTransaction).toBe(true);
    expect(logs.some((line) => line.startsWith('warn:'))).toBe(true);
  });

  describe('advisory lock', () => {
    /**
     * Count sessions holding the migration lock.
     *
     * A bigint advisory lock is stored split across two int4 columns: `classid`
     * holds the high 32 bits and `objid` the low 32.
     */
    const heldLockCount = async (): Promise<number> => {
      const result = await adminPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM pg_locks
          WHERE locktype = 'advisory'
            AND ((classid::bigint << 32) | objid::bigint) = $1`,
        [MIGRATION_LOCK_KEY.toString()],
      );
      return Number(result.rows[0]?.count ?? '-1');
    };

    // Proves heldLockCount can observe a held lock. Without this, the release
    // assertions below would pass even if the query never matched anything.
    it('is observable while held', async () => {
      const client = await adminPool.connect();
      try {
        await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
        await expect(heldLockCount()).resolves.toBe(1);
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
        await expect(heldLockCount()).resolves.toBe(0);
      } finally {
        client.release();
      }
    });

    it('is released when the run succeeds', async () => {
      await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');

      await makeMigrator().migrate();

      await expect(heldLockCount()).resolves.toBe(0);
    });

    it('is released even when a migration fails', async () => {
      await write('0001_broken.sql', 'THIS IS NOT SQL;');

      await expect(makeMigrator().migrate()).rejects.toThrow(MigrationExecutionError);

      await expect(heldLockCount()).resolves.toBe(0);
    });
  });
});

describe('Migrator drift detection', () => {
  it('detects an applied migration whose file has been edited', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');
    await makeMigrator().migrate();

    await write('0001_create_clients.sql', 'CREATE TABLE clients (id BIGINT PRIMARY KEY);');

    await expect(makeMigrator().verify()).rejects.toThrow(ChecksumMismatchError);
  });

  it('detects an applied migration whose file has been deleted', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');
    await makeMigrator().migrate();

    await rm(join(dir, '0001_create_clients.sql'));

    await expect(makeMigrator().verify()).rejects.toThrow(MissingMigrationFileError);
  });

  it('refuses a pending migration that sorts before the latest applied one', async () => {
    await write('0002_second.sql', 'CREATE TABLE second_table (id INT);');
    await makeMigrator().migrate();

    // Simulates a branch merged after another branch's higher-numbered migration landed.
    await write('0001_first.sql', 'CREATE TABLE first_table (id INT);');

    await expect(makeMigrator().migrate()).rejects.toThrow(OutOfOrderMigrationError);
    await expect(tableExists('first_table')).resolves.toBe(false);
  });

  it('verifies clean when files and registry agree', async () => {
    await write('0001_create_clients.sql', 'CREATE TABLE clients (id INT PRIMARY KEY);');
    await makeMigrator().migrate();

    const status = await makeMigrator().verify();

    expect(status.applied).toHaveLength(1);
    expect(status.pending).toEqual([]);
  });
});

describe('Migrator.status', () => {
  it('separates applied from pending', async () => {
    await write('0001_first.sql', 'CREATE TABLE a (id INT);');
    await makeMigrator().migrate();
    await write('0002_second.sql', 'CREATE TABLE b (id INT);');

    const { applied, pending } = await makeMigrator().status();

    expect(applied.map((record) => record.version)).toEqual(['0001']);
    expect(pending.map((file) => file.version)).toEqual(['0002']);
  });

  it('reports everything pending against an empty database', async () => {
    await write('0001_first.sql', 'CREATE TABLE a (id INT);');

    const { applied, pending } = await makeMigrator().status();

    expect(applied).toEqual([]);
    expect(pending).toHaveLength(1);
  });
});

describe('Migrator construction', () => {
  it.each(['bad name', 'DROP TABLE', 'x; DELETE FROM y', '1_leading_digit'])(
    'rejects unsafe registry table name %j',
    (table) => {
      expect(() => new Migrator(pool, { migrationsDir: dir, registryTable: table })).toThrow(
        /Invalid registry table name/,
      );
    },
  );

  it('accepts a lower snake_case registry table name', () => {
    expect(
      () => new Migrator(pool, { migrationsDir: dir, registryTable: 'mfi_schema_migrations' }),
    ).not.toThrow();
  });

  it('isolates state when a custom registry table is used', async () => {
    await write('0001_first.sql', 'CREATE TABLE a (id INT);');
    await new Migrator(pool, { migrationsDir: dir, registryTable: 'custom_registry' }).migrate();

    // The default registry knows nothing about the run recorded in the custom one.
    const { applied } = await makeMigrator().status();
    expect(applied).toEqual([]);
  });
});
