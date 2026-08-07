/**
 * Forward-only, checksum-verified SQL migration runner.
 *
 * The database is the system of record for an institution's loan book, so
 * schema change is treated as an auditable event: versioned files, immutable
 * once applied, verified on every run.
 *
 * @example
 * ```ts
 * const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
 * const migrator = new Migrator(pool, { migrationsDir: 'db/migrations' });
 * await migrator.migrate();
 * ```
 */

export {
  ChecksumMismatchError,
  DuplicateMigrationVersionError,
  MalformedMigrationNameError,
  MigrationError,
  MigrationExecutionError,
  MissingMigrationFileError,
  OutOfOrderMigrationError,
} from './errors.js';

export {
  checksumOf,
  compareVersions,
  loadMigrations,
  parseMigrationFilename,
  type MigrationFile,
} from './migration-file.js';

export {
  DEFAULT_REGISTRY_TABLE,
  MIGRATION_LOCK_KEY,
  Migrator,
  type AppliedMigration,
  type MigrationLogger,
  type MigrationResult,
  type MigrationStatus,
  type MigratorOptions,
} from './migrator.js';
