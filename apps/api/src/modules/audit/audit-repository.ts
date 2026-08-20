import { type AuditEntry, type AuditEntryDetail, type AuditOperation } from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';

interface AuditRow {
  id: string;
  table_name: string;
  row_id: string | null;
  operation: string;
  actor_user_id: string | null;
  actor_name: string | null;
  changed_at: Date;
  changed_columns: string[] | null;
}

interface AuditDetailRow extends AuditRow {
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
}

/**
 * The reader's projection.
 *
 * The actor's name is joined from `users` rather than read from the trail. The
 * trigger records the identifier only, which is the right thing for it to do —
 * a name copied at write time would freeze a user's name at the moment of every
 * change they ever made, so renaming one would leave their history split
 * across two people who never existed.
 *
 * `LEFT JOIN`, because a great many entries have no actor at all: migrations,
 * the classification run, and the signup that creates an institution before it
 * has a first user.
 */
const AUDIT_PROJECTION = `
  SELECT a.id, a.table_name, a.row_id, a.operation, a.actor_user_id,
         u.full_name AS actor_name, a.changed_at, a.changed_columns
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id`;

const AUDIT_DETAIL_PROJECTION = `
  SELECT a.id, a.table_name, a.row_id, a.operation, a.actor_user_id,
         u.full_name AS actor_name, a.changed_at, a.changed_columns,
         a.before_data, a.after_data
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id`;

/**
 * The database's CHECK constraint and the contract's enum are the same three
 * values, and this is where that is asserted rather than assumed. A row whose
 * operation is none of them means the constraint was changed without the
 * contract, and failing here says so at the row that proves it.
 */
function toOperation(value: string): AuditOperation {
  if (value !== 'INSERT' && value !== 'UPDATE' && value !== 'DELETE') {
    throw new Error(`Audit entry carries an unrecognised operation: ${value}`);
  }
  return value;
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    id: row.id,
    tableName: row.table_name,
    rowId: row.row_id,
    operation: toOperation(row.operation),
    actorUserId: row.actor_user_id,
    actorName: row.actor_name,
    changedAt: row.changed_at.toISOString(),
    // NULL on an insert or a delete, where every column is the change. The
    // contract says empty array rather than nullable: "no columns are listed"
    // and "the list is absent" mean the same thing to a reader, and one shape
    // is one branch in the UI instead of two.
    changedColumns: row.changed_columns ?? [],
  };
}

function toDetail(row: AuditDetailRow): AuditEntryDetail {
  return {
    ...toEntry(row),
    before: row.before_data,
    after: row.after_data,
  };
}

export interface AuditListFilters {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly tableName?: string | undefined;
  readonly rowId?: string | undefined;
  readonly actorUserId?: string | undefined;
  readonly operation?: AuditOperation | undefined;
}

export interface AuditRepository {
  list(
    institutionId: string,
    userId: string,
    filters: AuditListFilters,
  ): Promise<PagedRows<AuditEntry>>;
  find(institutionId: string, userId: string, entryId: string): Promise<AuditEntryDetail | null>;
  /** Every table the audit trigger is attached to, from the catalogue. */
  auditedTables(institutionId: string, userId: string): Promise<readonly string[]>;
}

/**
 * Reads of the audit trail, and nothing else.
 *
 * There is no write method here and there cannot be one: `mfi_app` holds
 * `SELECT` on `audit_logs` and no other privilege, so an insert from this
 * connection is refused by the database whatever the application asks for. The
 * only writer is the trigger, running as `mfi_audit_writer`.
 *
 * Every read goes through `withTenantTransaction`, which steps the connection
 * down to `mfi_app` and sets `app.institution_id` and `app.user_id`. That
 * matters more here than elsewhere: the policy on this table checks
 * `has_permission('audit.read')` as well as the tenant, so the route's
 * permission guard is not the only thing standing between a loan officer and
 * the institution's change history.
 */
export class PostgresAuditRepository implements AuditRepository {
  public constructor(private readonly database: Database) {}

  public async list(
    institutionId: string,
    userId: string,
    filters: AuditListFilters,
  ): Promise<PagedRows<AuditEntry>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      if (filters.cursor !== undefined) {
        parameters.push(decodeCursor(filters.cursor));
        conditions.push(`a.id < $${String(parameters.length)}`);
      }
      if (filters.tableName !== undefined) {
        parameters.push(filters.tableName);
        conditions.push(`a.table_name = $${String(parameters.length)}`);
      }
      if (filters.rowId !== undefined) {
        parameters.push(filters.rowId);
        conditions.push(`a.row_id = $${String(parameters.length)}`);
      }
      if (filters.actorUserId !== undefined) {
        parameters.push(filters.actorUserId);
        conditions.push(`a.actor_user_id = $${String(parameters.length)}`);
      }
      if (filters.operation !== undefined) {
        parameters.push(filters.operation);
        conditions.push(`a.operation = $${String(parameters.length)}`);
      }

      parameters.push(filters.limit + 1);

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = await client.query<AuditRow>(
        `${AUDIT_PROJECTION} ${where} ORDER BY a.id DESC LIMIT $${String(parameters.length)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toEntry), nextCursor: page.nextCursor };
    });
  }

  public async find(
    institutionId: string,
    userId: string,
    entryId: string,
  ): Promise<AuditEntryDetail | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<AuditDetailRow>(
        `${AUDIT_DETAIL_PROJECTION} WHERE a.id = $1`,
        [entryId],
      );

      const row = rows.rows[0];
      return row === undefined ? null : toDetail(row);
    });
  }

  /**
   * Which tables the trail covers.
   *
   * Read from `pg_trigger` rather than kept as a list somewhere. The trigger is
   * attached generically and a schema invariant asserts no table escaped it, so
   * the catalogue is the only description of the coverage that cannot drift
   * from what is actually happening.
   */
  public async auditedTables(institutionId: string, userId: string): Promise<readonly string[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, (client) =>
      auditedTablesWithin(client),
    );
  }
}

async function auditedTablesWithin(client: TransactionClient): Promise<readonly string[]> {
  const rows = await client.query<{ table_name: string }>(
    `SELECT DISTINCT c.relname AS table_name
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_proc p  ON p.oid = t.tgfoid
      WHERE p.proname = 'audit_row_change' AND NOT t.tgisinternal
      ORDER BY c.relname`,
  );

  return rows.rows.map((row) => row.table_name);
}
