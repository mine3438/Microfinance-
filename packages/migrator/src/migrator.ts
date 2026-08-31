import type { Pool, PoolClient } from 'pg';

import {
  ChecksumMismatchError,
  MigrationExecutionError,
  MissingMigrationFileError,
  OutOfOrderMigrationError,
} from './errors.js';
import { compareVersions, loadMigrations, type MigrationFile } from './migration-file.js';

/** Default name of the table recording applied migrations. */
export const DEFAULT_REGISTRY_TABLE = 'schema_migrations';

/**
 * Session-level advisory lock key held for the duration of a migration run.
 *
 * Two deploys landing at once would otherwise both read the same pending list
 * and both try to apply it. An arbitrary but fixed constant: only this runner
 * uses it.
 */
export const MIGRATION_LOCK_KEY = 8_274_193_056_112_233n;

/** A migration as recorded in the registry table. */
export interface AppliedMigration {
  readonly version: string;
  readonly name: string;
  readonly filename: string;
  readonly checksum: string;
  readonly appliedAt: Date;
  readonly executionMs: number;
}

/** Result of applying one migration. */
export interface MigrationResult {
  readonly version: string;
  readonly filename: string;
  readonly executionMs: number;
  readonly ranOutsideTransaction: boolean;
}

/** Applied and pending migrations at a point in time. */
export interface MigrationStatus {
  readonly applied: readonly AppliedMigration[];
  readonly pending: readonly MigrationFile[];
}

/** Sink for progress output. The CLI passes the console; tests capture. */
export interface MigrationLogger {
  info(message: string): void;
  warn(message: string): void;
}

/** Logger that discards everything. Default, so the library is silent unless asked. */
const SILENT_LOGGER: MigrationLogger = {
  info: () => undefined,
  warn: () => undefined,
};

export interface MigratorOptions {
  /** Directory holding `NNNN_name.sql` files. */
  readonly migrationsDir: string;
  /** Registry table name. Overridable so tests can isolate. */
  readonly registryTable?: string;
  readonly logger?: MigrationLogger;
}

interface RegistryRow {
  version: string;
  name: string;
  filename: string;
  checksum: string;
  applied_at: Date;
  execution_ms: number;
}

/**
 * Forward-only SQL migration runner.
 *
 * Four properties it guarantees, each corresponding to a way schema management
 * goes wrong in practice:
 *
 * - **Ordered.** Migrations apply in version order, and a pending migration
 *   that sorts before an applied one is refused rather than run out of order.
 * - **Atomic.** Each migration runs inside its own transaction, so a failure
 *   leaves no partial schema — unless it explicitly opts out via
 *   `-- mfi:no-transaction`.
 * - **Immutable.** Checksums are recorded on apply and verified on every
 *   subsequent run, so editing applied history is detected instead of silently
 *   diverging the database from the repository.
 * - **Exclusive.** A session advisory lock means two concurrent deploys cannot
 *   both apply the same pending set.
 *
 * There is deliberately no `down` path. Rolling a schema backwards against live
 * financial data loses information; the recovery path is a new forward
 * migration, reviewed like any other change.
 */
export class Migrator {
  private readonly pool: Pool;
  private readonly migrationsDir: string;
  private readonly registryTable: string;
  private readonly logger: MigrationLogger;

  public constructor(pool: Pool, options: MigratorOptions) {
    this.pool = pool;
    this.migrationsDir = options.migrationsDir;
    this.registryTable = options.registryTable ?? DEFAULT_REGISTRY_TABLE;
    this.logger = options.logger ?? SILENT_LOGGER;

    // The table name reaches SQL as an identifier, which cannot be parameterised.
    // Constraining it to a safe character set is what makes that interpolation safe.
    if (!/^[a-z_][a-z0-9_]*$/.test(this.registryTable)) {
      throw new Error(
        `Invalid registry table name "${this.registryTable}". ` +
          'Expected lower snake_case matching /^[a-z_][a-z0-9_]*$/.',
      );
    }
  }

  /** Create the registry table if absent. Safe to call repeatedly. */
  public async ensureRegistry(client: PoolClient): Promise<void> {
    // Identifier interpolation only; see listApplied.
    // eslint-disable-next-line no-restricted-syntax
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${this.registryTable} (
        version      TEXT        PRIMARY KEY,
        name         TEXT        NOT NULL,
        filename     TEXT        NOT NULL,
        checksum     TEXT        NOT NULL,
        applied_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        execution_ms INTEGER     NOT NULL CHECK (execution_ms >= 0)
      )
    `);
  }

  /** Read the registry, oldest first. */
  public async listApplied(client: PoolClient): Promise<AppliedMigration[]> {
    // A table name is an identifier, and Postgres does not accept identifiers as
    // bind parameters. `registryTable` is constrained to /^[a-z_][a-z0-9_]*$/ in
    // the constructor and is never caller-supplied at runtime.
    const result = await client.query<RegistryRow>(
      // eslint-disable-next-line no-restricted-syntax
      `SELECT version, name, filename, checksum, applied_at, execution_ms
         FROM ${this.registryTable}`,
    );
    return result.rows
      .map((row) => ({
        version: row.version,
        name: row.name,
        filename: row.filename,
        checksum: row.checksum,
        appliedAt: row.applied_at,
        executionMs: row.execution_ms,
      }))
      .sort((a, b) => compareVersions(a.version, b.version));
  }

  /**
   * Check the repository against the registry without changing anything.
   *
   * Throws on drift: an applied migration whose file changed or vanished, or a
   * pending migration that sorts before the latest applied one.
   */
  public async verify(): Promise<MigrationStatus> {
    const client = await this.pool.connect();
    try {
      await this.ensureRegistry(client);
      const [files, applied] = await Promise.all([
        loadMigrations(this.migrationsDir),
        this.listApplied(client),
      ]);
      return this.reconcile(files, applied);
    } finally {
      client.release();
    }
  }

  /** Applied and pending migrations. Throws on the same drift conditions as {@link verify}. */
  public async status(): Promise<MigrationStatus> {
    return this.verify();
  }

  /**
   * Apply every pending migration, in order.
   *
   * Verification runs first, under the lock, so a drifted repository fails
   * before any statement executes.
   */
  public async migrate(): Promise<MigrationResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
      try {
        await this.ensureRegistry(client);
        const files = await loadMigrations(this.migrationsDir);
        const applied = await this.listApplied(client);
        const { pending } = this.reconcile(files, applied);

        if (pending.length === 0) {
          this.logger.info('Database is up to date; no migrations to apply.');
          return [];
        }

        this.logger.info(`Applying ${String(pending.length)} migration(s).`);
        const results: MigrationResult[] = [];
        for (const migration of pending) {
          results.push(await this.applyOne(client, migration));
        }
        return results;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY.toString()]);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Compare files against the registry.
   *
   * Ordering is checked against the latest applied version rather than each
   * pending migration's neighbours, because that is the condition that actually
   * matters: a migration may only apply to a schema at or beyond the state it
   * was written for.
   */
  private reconcile(
    files: readonly MigrationFile[],
    applied: readonly AppliedMigration[],
  ): MigrationStatus {
    const filesByVersion = new Map(files.map((file) => [file.version, file]));

    for (const record of applied) {
      const file = filesByVersion.get(record.version);
      if (file === undefined) {
        throw new MissingMigrationFileError(record.version, record.filename);
      }
      if (file.checksum !== record.checksum) {
        throw new ChecksumMismatchError(
          record.version,
          file.filename,
          record.checksum,
          file.checksum,
        );
      }
    }

    const appliedVersions = new Set(applied.map((record) => record.version));
    const pending = files.filter((file) => !appliedVersions.has(file.version));

    const latestApplied = applied.at(-1);
    if (latestApplied !== undefined) {
      for (const file of pending) {
        if (compareVersions(file.version, latestApplied.version) < 0) {
          throw new OutOfOrderMigrationError(file.version, file.filename, latestApplied.version);
        }
      }
    }

    return { applied, pending };
  }

  /** Execute one migration and record it. */
  private async applyOne(client: PoolClient, migration: MigrationFile): Promise<MigrationResult> {
    const { version, filename, sql, runOutsideTransaction } = migration;

    if (runOutsideTransaction) {
      this.logger.warn(
        `${filename} runs outside a transaction (-- mfi:no-transaction). ` +
          'A failure part-way through will leave partial schema changes to clean up by hand.',
      );
    }

    const startedAt = process.hrtime.bigint();
    if (!runOutsideTransaction) {
      await client.query('BEGIN');
    }

    try {
      await client.query(sql);
      const executionMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      await this.recordApplied(client, migration, executionMs);

      if (!runOutsideTransaction) {
        await client.query('COMMIT');
      }

      this.logger.info(`  ${filename} applied in ${String(executionMs)}ms`);
      return { version, filename, executionMs, ranOutsideTransaction: runOutsideTransaction };
    } catch (cause) {
      if (!runOutsideTransaction) {
        await client.query('ROLLBACK');
      }
      throw new MigrationExecutionError(version, filename, cause);
    }
  }

  private async recordApplied(
    client: PoolClient,
    migration: MigrationFile,
    executionMs: number,
  ): Promise<void> {
    // Identifier interpolation only; see listApplied. Every value is bound.
    await client.query(
      // eslint-disable-next-line no-restricted-syntax
      `INSERT INTO ${this.registryTable} (version, name, filename, checksum, execution_ms)
       VALUES ($1, $2, $3, $4, $5)`,
      [migration.version, migration.name, migration.filename, migration.checksum, executionMs],
    );
  }
}
