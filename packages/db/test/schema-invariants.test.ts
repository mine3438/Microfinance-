import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from './global-setup.js';

/**
 * Structural guarantees about the schema, checked against the live catalogue.
 *
 * The isolation suite proves the tables that exist today are isolated. These
 * tests are what keeps that true for tables that do not exist yet: a new table
 * added in a later stage without row-level security fails here, on the commit
 * that adds it, rather than in a cross-tenant incident months later.
 *
 * This is the same reasoning as the audit trigger design in
 * `01-ARCHITECTURE.md` §10.2 — a guarantee that depends on every future
 * developer remembering is not a guarantee.
 */

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
});

afterAll(async () => {
  await pool.end();
});

/**
 * Tables deliberately outside tenant scope.
 *
 * Adding an entry is a decision that must be justified here in writing. The
 * list being explicit is the point: it makes "this table holds no tenant data"
 * a reviewed claim rather than an oversight.
 */
const NON_TENANT_TABLES: ReadonlyMap<string, string> = new Map([
  [
    'schema_migrations',
    'Migration registry owned by @mfi/migrator. Records schema history, not institution data, ' +
      'and is written only by the migration runner under a privileged role.',
  ],
]);

interface TableRow {
  table_name: string;
  row_security: boolean;
  force_row_security: boolean;
}

async function listTables(): Promise<TableRow[]> {
  const result = await pool.query<TableRow>(
    `SELECT c.relname             AS table_name,
            c.relrowsecurity      AS row_security,
            c.relforcerowsecurity AS force_row_security
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return result.rows;
}

const tenantTables = async (): Promise<TableRow[]> =>
  (await listTables()).filter((table) => !NON_TENANT_TABLES.has(table.table_name));

describe('every tenant table enforces row-level security', () => {
  it('finds tables to check, so the suite cannot pass vacuously', async () => {
    expect((await tenantTables()).length).toBeGreaterThan(0);
  });

  it('has row-level security enabled on every tenant table', async () => {
    const offenders = (await tenantTables())
      .filter((table) => !table.row_security)
      .map((table) => table.table_name);

    expect(offenders).toEqual([]);
  });

  it('forces row-level security on every tenant table', async () => {
    // ENABLE alone exempts the table's owner. Migrations run as the owner, so
    // without FORCE a bug that ran application queries on the owning connection
    // would bypass every policy silently.
    const offenders = (await tenantTables())
      .filter((table) => !table.force_row_security)
      .map((table) => table.table_name);

    expect(offenders).toEqual([]);
  });

  it('defines at least one policy on every tenant table', async () => {
    // RLS enabled with no policies denies everything, which is safe but means
    // the table is unusable — a mistake worth catching at the same moment.
    const result = await pool.query<{ table_name: string; policy_count: string }>(
      `SELECT c.relname AS table_name, COUNT(p.polname)::text AS policy_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_policy p ON p.polrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
     GROUP BY c.relname`,
    );

    const offenders = result.rows
      .filter((row) => !NON_TENANT_TABLES.has(row.table_name) && row.policy_count === '0')
      .map((row) => row.table_name);

    expect(offenders).toEqual([]);
  });

  it('scopes every policy reachable by the application through current_institution_id()', async () => {
    // A policy that never consults tenant resolution is not a tenant policy,
    // whatever it is named.
    //
    // Scoped to policies that apply to `mfi_app`, because that is what the
    // invariant is actually about: the application role must not be able to
    // escape its tenant. Internal policies granted to another role — the audit
    // writer, for instance — are governed by the fact that `mfi_app` holds no
    // privilege there at all, which is a stronger guarantee than a predicate.
    const result = await pool.query<{
      table_name: string;
      policy_name: string;
      roles: string[];
      qualifier: string | null;
      with_check: string | null;
    }>(
      `SELECT tablename AS table_name, policyname AS policy_name, roles,
              qual AS qualifier, with_check
         FROM pg_policies
        WHERE schemaname = 'public'`,
    );

    const appReachable = result.rows.filter(
      (row) => row.roles.includes('mfi_app') || row.roles.includes('public'),
    );
    expect(appReachable.length).toBeGreaterThan(0);

    const offenders = appReachable
      .filter((row) => {
        const expression = `${row.qualifier ?? ''} ${row.with_check ?? ''}`;
        return !expression.includes('current_institution_id');
      })
      .map((row) => `${row.table_name}.${row.policy_name}`);

    expect(offenders).toEqual([]);
  });
});

/**
 * Tables deliberately not audited, each with the reason.
 *
 * The list being explicit is the mechanism: adding a table here is a reviewed
 * decision, whereas forgetting to attach a trigger is silent. The previous
 * system's audit table was empty in every deployment precisely because nothing
 * made the omission visible.
 */
const UNAUDITED_TABLES: ReadonlyMap<string, string> = new Map([
  [
    'schema_migrations',
    'Migration registry. Its own contents are the change history of the schema.',
  ],
  ['audit_logs', 'Auditing the audit log is circular.'],
  [
    'domain_events',
    'Append-only event log with the same shape as audit_logs: written solely by a ' +
      'SECURITY DEFINER trigger, read-only to the application, never amended. A change ' +
      'log over an immutable log records nothing that the log does not already say.',
  ],
  [
    'refresh_tokens',
    'Rotated on every request. Auditing session churn would bury genuine business ' +
      'changes, and who logged in is a security concern served by the login record.',
  ],
  [
    'user_tokens',
    'Verification and reset tokens, issued and consumed mechanically. No business meaning.',
  ],
  [
    'system_health',
    'Derived-state record, written solely by the classification job. The changes it ' +
      'summarises — each loan gaining or losing a classification — are themselves audited on ' +
      'the loans table, so auditing this as well would log the same event twice.',
  ],
  [
    'code_sequences',
    'Implementation detail of code allocation. The audit entry for the loan says ' +
      'everything the counter increment would.',
  ],
]);

describe('every business table is audited', () => {
  const auditedTables = async (): Promise<Set<string>> => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'audit_row_change' AND NOT t.tgisinternal`,
    );
    return new Set(result.rows.map((row) => row.table_name));
  };

  it('attaches the audit trigger to every table not explicitly excluded', async () => {
    // This is what keeps the audit trail honest as the schema grows: a table
    // added in a later stage without a trigger fails here, on the commit that
    // adds it, rather than being discovered missing during an inspection.
    const audited = await auditedTables();
    const offenders = (await listTables())
      .map((table) => table.table_name)
      .filter((name) => !UNAUDITED_TABLES.has(name) && !audited.has(name));

    expect(offenders).toEqual([]);
  });

  it('audits something, so the check cannot pass vacuously', async () => {
    expect((await auditedTables()).size).toBeGreaterThan(0);
  });

  it('fires on insert, update and delete alike', async () => {
    // A trigger attached for INSERT only would satisfy the check above while
    // recording none of the changes that matter most.
    const result = await pool.query<{ table_name: string; events: number }>(
      `SELECT c.relname AS table_name, t.tgtype AS events
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'audit_row_change' AND NOT t.tgisinternal`,
    );

    // tgtype bits: 4 = INSERT, 8 = DELETE, 16 = UPDATE.
    const offenders = result.rows
      .filter((row) => (row.events & 4) === 0 || (row.events & 8) === 0 || (row.events & 16) === 0)
      .map((row) => row.table_name);

    expect(offenders).toEqual([]);
  });
});

describe('every tenant table carries a tenant key', () => {
  it('has a NOT NULL institution_id, or is the institutions table itself', async () => {
    const result = await pool.query<{ table_name: string; is_nullable: string }>(
      `SELECT table_name, is_nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'institution_id'`,
    );
    const byTable = new Map(result.rows.map((row) => [row.table_name, row.is_nullable]));

    const offenders: string[] = [];
    for (const table of await tenantTables()) {
      // `institutions` is the tenant root: its own id is the key.
      if (table.table_name === 'institutions') {
        continue;
      }
      const nullable = byTable.get(table.table_name);
      if (nullable === undefined) {
        offenders.push(`${table.table_name} (no institution_id column)`);
      } else if (nullable !== 'NO') {
        // A nullable tenant key produces rows no policy matches — invisible to
        // every tenant, and quietly excluded from every regulatory total.
        offenders.push(`${table.table_name} (institution_id is nullable)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('indexes institution_id, since every tenant query filters on it', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
        WHERE n.nspname = 'public' AND a.attname = 'institution_id'`,
    );
    const indexed = new Set(result.rows.map((row) => row.table_name));

    const offenders = (await tenantTables())
      .filter((table) => table.table_name !== 'institutions' && !indexed.has(table.table_name))
      .map((table) => table.table_name);

    expect(offenders).toEqual([]);
  });
});

describe('the application role holds no more privilege than it needs', () => {
  it('is not a superuser and cannot bypass row-level security', async () => {
    const result = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
      ['mfi_app'],
    );

    expect(result.rows[0]).toBeDefined();
    expect(result.rows[0]?.rolsuper).toBe(false);
    expect(result.rows[0]?.rolbypassrls).toBe(false);
  });

  it('owns no tables, so it is never exempt from its own policies', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_roles r ON r.oid = c.relowner
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = 'mfi_app'`,
    );

    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });

  it('cannot create objects in the schema', async () => {
    const result = await pool.query<{ has_create: boolean }>(
      `SELECT has_schema_privilege('mfi_app', 'public', 'CREATE') AS has_create`,
    );

    expect(result.rows[0]?.has_create).toBe(false);
  });

  it('can read every tenant table it is expected to use', async () => {
    const offenders: string[] = [];
    for (const table of await tenantTables()) {
      const result = await pool.query<{ has_select: boolean }>(
        `SELECT has_table_privilege('mfi_app', $1, 'SELECT') AS has_select`,
        [table.table_name],
      );
      if (result.rows[0]?.has_select !== true) {
        offenders.push(table.table_name);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('timestamp columns are maintained by the database', () => {
  it('attaches the updated_at trigger to every table that has the column', async () => {
    // An updated_at the application sets is not evidence of when a row changed;
    // it is evidence of what the writer claimed.
    const withColumn = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'updated_at'`,
    );
    const withTrigger = await pool.query<{ table_name: string }>(
      `SELECT DISTINCT c.relname AS table_name
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_proc p ON p.oid = t.tgfoid
        WHERE p.proname = 'set_updated_at' AND NOT t.tgisinternal`,
    );
    const triggered = new Set(withTrigger.rows.map((row) => row.table_name));

    const offenders = withColumn.rows
      .map((row) => row.table_name)
      .filter((name) => !NON_TENANT_TABLES.has(name) && !triggered.has(name));

    expect(offenders).toEqual([]);
  });
});
