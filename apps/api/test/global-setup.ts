import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Migrator } from '@mfi/migrator';
import pg from 'pg';

/**
 * A migrated database of this app's own, created and dropped around the suite.
 *
 * Separate from `@mfi/db`'s `mfi_db_test` so the two can run without one
 * truncating the other's fixtures, and so a failure here is unambiguously this
 * app's.
 *
 * A real database, and a real HTTP server on top of it, because what these
 * suites assert is precisely what a mock cannot show: that row-level security
 * scopes a query issued through a route, that a refresh rotation is atomic
 * under a concurrent request, that an unexpected driver error becomes a 500
 * with nothing disclosed. Testing those against a stub tests the stub.
 */
const TEST_DATABASE = 'mfi_api_test';

const ADMIN_URL = process.env['DATABASE_URL'] ?? 'postgresql://postgres@localhost:5432/postgres';

export function testDatabaseUrl(): string {
  const url = new URL(ADMIN_URL);
  url.pathname = `/${TEST_DATABASE}`;
  return url.toString();
}

export function testRedisUrl(): string {
  return process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379';
}

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/migrations');

async function withAdmin(work: (pool: pg.Pool) => Promise<void>): Promise<void> {
  const admin = new pg.Pool({ connectionString: ADMIN_URL });
  try {
    await work(admin);
  } finally {
    await admin.end();
  }
}

async function dropTestDatabase(admin: pg.Pool): Promise<void> {
  // DROP DATABASE fails while any session is connected, and an interrupted run
  // leaves them behind.
  await admin.query(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [TEST_DATABASE],
  );
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE}`);
}

export async function setup(): Promise<void> {
  await withAdmin(async (admin) => {
    await dropTestDatabase(admin);
    await admin.query(`CREATE DATABASE ${TEST_DATABASE}`);
  });

  const target = new pg.Pool({ connectionString: testDatabaseUrl() });
  try {
    await new Migrator(target, { migrationsDir: MIGRATIONS_DIR }).migrate();
  } finally {
    await target.end();
  }
}

export async function teardown(): Promise<void> {
  await withAdmin(dropTestDatabase);
}
