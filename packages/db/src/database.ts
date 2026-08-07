import pg from 'pg';

import { assertExactNumericsAreSafe } from './driver-safety.js';
import { DatabaseError, SchemaVersionError } from './errors.js';
import { assertValidTenantContext, type TenantContext } from './tenant-context.js';

/** Session setting the tenancy policies read. Mirrors `current_institution_id()` in SQL. */
export const TENANT_SETTING = 'app.institution_id';

/** Session setting identifying the acting user. Mirrors `current_user_id()` in SQL. */
export const ACTING_USER_SETTING = 'app.user_id';

/** Default least-privilege role, created by migration `0001_foundation.sql`. */
export const DEFAULT_APPLICATION_ROLE = 'mfi_app';

/** A client bound to an open transaction. */
export type TransactionClient = pg.PoolClient;

/** Work performed inside a transaction. */
export type TransactionWork<T> = (client: TransactionClient) => Promise<T>;

export interface DatabaseOptions {
  /**
   * Role adopted for the duration of each transaction, via `SET LOCAL ROLE`.
   *
   * In production the application connects as this role directly and the
   * setting is redundant but harmless. It matters wherever the connecting role
   * is more privileged than the application should be — CI, local development,
   * and the isolation suite, which must run as a role that row-level security
   * actually applies to. A table's owner bypasses RLS unless the table is
   * FORCEd, and a superuser bypasses it unconditionally.
   *
   * Pass `null` to leave the connection's role alone.
   */
  readonly applicationRole?: string | null;

  /**
   * Verify the driver returns exact numerics as strings when constructing.
   *
   * On by default. Turning it off means accepting that monetary values may
   * arrive as floats, which the money layer is built to prevent.
   */
  readonly verifyDriverSafety?: boolean;
}

/** Postgres identifier: lower snake_case, as `mfi_app` is. */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Postgres access, with tenancy enforced at the transaction boundary.
 *
 * Two kinds of unit of work, and the distinction is deliberate:
 *
 * - {@link withTenantTransaction} — scoped to one institution. Adopts the
 *   application role and sets the tenant setting that every row-level security
 *   policy reads, so the database refuses cross-tenant access even if the
 *   application layer's own scoping is wrong.
 * - {@link withTransaction} — unscoped, for the handful of operations that
 *   genuinely have no tenant: creating an institution during signup, running
 *   migrations, scheduled jobs that sweep every tenant.
 *
 * Making the unscoped variant a separate, differently-named method means
 * reaching outside a tenant is a visible act at the call site and in review,
 * rather than the accidental consequence of forgetting an argument.
 */
export class Database {
  private readonly pool: pg.Pool;
  private readonly applicationRole: string | null;

  public constructor(pool: pg.Pool, options: DatabaseOptions = {}) {
    if (options.verifyDriverSafety !== false) {
      assertExactNumericsAreSafe();
    }

    const role =
      options.applicationRole === undefined ? DEFAULT_APPLICATION_ROLE : options.applicationRole;
    if (role !== null && !SAFE_IDENTIFIER.test(role)) {
      throw new DatabaseError(
        `Invalid application role "${role}". Expected lower snake_case matching ${String(SAFE_IDENTIFIER)}.`,
      );
    }

    this.pool = pool;
    this.applicationRole = role;
  }

  /** Build from a connection string. */
  public static fromConnectionString(
    connectionString: string,
    options: DatabaseOptions = {},
  ): Database {
    return new Database(new pg.Pool({ connectionString }), options);
  }

  /**
   * Run `work` in a transaction scoped to one institution.
   *
   * Commits on success, rolls back on any thrown error. The tenant setting uses
   * `set_config(..., is_local => true)`, so it is scoped to this transaction and
   * cannot survive on a pooled connection into the next request.
   */
  public async withTenantTransaction<T>(
    context: TenantContext,
    work: TransactionWork<T>,
  ): Promise<T> {
    const { institutionId, userId } = assertValidTenantContext(context);

    return this.runInTransaction(async (client) => {
      if (this.applicationRole !== null) {
        // A role name is an identifier and cannot be a bind parameter. The value
        // is validated against SAFE_IDENTIFIER in the constructor and never
        // comes from a request.
        await client.query(`SET LOCAL ROLE ${this.applicationRole}`);
      }
      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, institutionId]);
      // Empty string rather than NULL when there is no acting user: set_config
      // rejects NULL, and current_user_id() maps '' back to NULL.
      await client.query('SELECT set_config($1, $2, true)', [ACTING_USER_SETTING, userId ?? '']);
      return work(client);
    });
  }

  /**
   * Run `work` in a transaction with no tenant scope.
   *
   * For operations that precede or span tenants. Row-level security policies
   * evaluate false without a tenant setting, so this is only useful for a role
   * that is not subject to them — which is exactly why its use should be rare
   * and obvious.
   */
  public async withTransaction<T>(work: TransactionWork<T>): Promise<T> {
    return this.runInTransaction(work);
  }

  /**
   * Confirm the database is usable before the application serves traffic.
   *
   * Checks three things, each of which has a silent failure mode:
   *
   * 1. The connection works at all.
   * 2. `current_institution_id()` exists and round-trips the tenant setting. If
   *    tenancy resolution is broken, every policy evaluates false and the
   *    application shows empty screens with no error — the failure the analysis
   *    records as R4, which went undiagnosed repeatedly in the system this
   *    replaces.
   * 3. Migrations have been applied.
   *
   * @throws {SchemaVersionError} if the schema is missing or tenancy does not resolve.
   */
  public async verifyReadiness(): Promise<void> {
    const probeInstitutionId = '00000000-0000-7000-8000-000000000000';

    await this.runInTransaction(async (client) => {
      const migrations = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'schema_migrations'
         ) AS exists`,
      );
      if (migrations.rows[0]?.exists !== true) {
        throw new SchemaVersionError(
          'No schema_migrations table. The database has never been migrated — run `pnpm db:migrate`.',
        );
      }

      await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, probeInstitutionId]);
      const resolved = await client.query<{ institution_id: string | null }>(
        'SELECT current_institution_id() AS institution_id',
      );

      if (resolved.rows[0]?.institution_id !== probeInstitutionId) {
        throw new SchemaVersionError(
          'current_institution_id() did not return the tenant setting it was given. ' +
            'Tenant resolution is broken: every row-level security policy would evaluate ' +
            'false and the application would return empty results with no error.',
        );
      }
    });
  }

  /** Release every pooled connection. */
  public async close(): Promise<void> {
    await this.pool.end();
  }

  private async runInTransaction<T>(work: TransactionWork<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error: unknown) {
        // Rollback is best-effort: if the connection is already broken, the
        // original error is the one worth reporting.
        try {
          await client.query('ROLLBACK');
        } catch {
          /* the original error is propagated below */
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }
}
