import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import { isoTimestampSchema, uuidSchema } from './scalars.js';

/**
 * Reading the audit trail.
 *
 * The trail itself has existed since migration 0006: one trigger on every
 * business table, a schema invariant asserting none was missed, and a policy
 * restricting the table to holders of `audit.read`. What none of that provided
 * was a way to read it. The permission was granted to `institution_admin` and
 * `auditor`, both roles enforced everywhere else in the system, and answering
 * "who changed this loan's interest rate, and when" meant a database session.
 *
 * An audit trail nobody can read is the same defect as one nobody writes,
 * arriving from the other direction — and it is the defect the system being
 * replaced had (00-PROJECT-ANALYSIS.md R8), where `audit_logs` existed and was
 * empty in every deployment.
 *
 * Two shapes, deliberately. The list carries which columns moved but not their
 * values, so browsing a quarter of activity does not stream every row of the
 * loan book through the browser; the detail carries the redacted before and
 * after in full, because that is the evidence.
 */

/** What a trigger observed. Matches the CHECK constraint on `audit_logs.operation`. */
export const AUDIT_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE'] as const;

export type AuditOperation = (typeof AUDIT_OPERATIONS)[number];

/**
 * A row's state on one side of a change.
 *
 * Column names and values exactly as the table holds them, less the columns
 * `audit_redact()` strips. Untyped by necessity: one endpoint reports changes
 * to every table in the schema, and a union of every row shape would be a
 * second copy of the database's definition that could disagree with it.
 */
export const auditPayloadSchema = z.record(z.string(), z.unknown());

export type AuditPayload = z.infer<typeof auditPayloadSchema>;

/** One change, as it appears in a list. */
export const auditEntrySchema = z
  .object({
    id: uuidSchema,

    /** The table the trigger fired on, as Postgres names it. */
    tableName: z.string(),

    /**
     * The row that changed.
     *
     * `null` for the composite-keyed tables, which have no single identifier.
     * The payload on the detail still says which row it was.
     */
    rowId: uuidSchema.nullable(),

    operation: z.enum(AUDIT_OPERATIONS),

    /**
     * Who did it, and their name at the time of reading.
     *
     * Both `null` for a change with no human actor: a migration, the nightly
     * classification run, or the signup that necessarily precedes an
     * institution's first user. `actorName` is resolved by join rather than
     * copied into the trail, so a user who is later renamed does not leave a
     * history under two names.
     */
    actorUserId: uuidSchema.nullable(),
    actorName: z.string().nullable(),

    changedAt: isoTimestampSchema,

    /**
     * Columns whose value actually moved.
     *
     * Empty on an insert and on a delete, where the whole row is the change.
     */
    changedColumns: z.array(z.string()),
  })
  .strict();

export type AuditEntry = z.infer<typeof auditEntrySchema>;

/** One change, with the row either side of it. */
export const auditEntryDetailSchema = auditEntrySchema
  .extend({
    /** `null` on an insert: there was no before. */
    before: auditPayloadSchema.nullable(),
    /** `null` on a delete: there is no after. */
    after: auditPayloadSchema.nullable(),
  })
  .strict();

export type AuditEntryDetail = z.infer<typeof auditEntryDetailSchema>;

/**
 * Narrowing the trail.
 *
 * Each filter matches an index the trail already carries — tenant and time,
 * table and row, actor — so none of them turns a page into a scan.
 *
 * There is no date range. Ordering is by identifier, and a UUIDv7 identifier
 * carries the timestamp, so a range would be expressible; it is left out
 * because no supplied requirement asks for one and adding it would need a
 * fourth index to stay a seek.
 */
export const auditListQuerySchema = paginationQuerySchema.extend({
  /**
   * Restrict to one table.
   *
   * Checked against the tables that are actually audited, and refused if it
   * names one that is not. An unrecognised value returning an empty page would
   * report "nothing happened" to a question the server never understood, which
   * in an audit tool is worse than an error.
   */
  tableName: z.string().min(1).max(63).optional(),
  rowId: uuidSchema.optional(),
  actorUserId: uuidSchema.optional(),
  operation: z.enum(AUDIT_OPERATIONS).optional(),
});

export type AuditListQuery = z.infer<typeof auditListQuerySchema>;

/**
 * A table the trigger is attached to.
 *
 * Read from the catalogue rather than listed here. A table added in six months
 * with the audit trigger on it appears in this list without anyone remembering
 * to add it — which is the same argument migration 0006 makes for attaching the
 * trigger generically in the first place.
 */
export const auditedTableSchema = z
  .object({
    /** As Postgres names it: `loan_products`, not `Loan products`. */
    name: z.string(),
  })
  .strict();

export type AuditedTable = z.infer<typeof auditedTableSchema>;
