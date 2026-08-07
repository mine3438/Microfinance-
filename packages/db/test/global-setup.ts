import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Migrator } from '@mfi/migrator';
import pg from 'pg';

/**
 * Creates a dedicated test database, migrates it, and drops it afterwards.
 *
 * A real database rather than a mock, because the properties under test are the
 * database's own: row-level security evaluation, policy `WITH CHECK` behaviour,
 * transaction rollback, row locking. A stubbed driver would assert the stub.
 *
 * A dedicated database rather than a schema, because roles and their grants are
 * cluster-level and the policies reference `public` explicitly.
 */
const TEST_DATABASE = 'mfi_db_test';

const ADMIN_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres@localhost:5432/postgres';

/** The migrated test database, for the suites to connect to. */
export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

export async function setup(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    // Terminate stragglers from an interrupted run; DROP DATABASE fails while
    // any session is connected.
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }

  const target = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await new Migrator(target, { migrationsDir: MIGRATIONS_DIR }).migrate();
  } finally {
    await target.end();
  }
}

export async function teardown(): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DATABASE],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
  } finally {
    await admin.end();
  }
}
