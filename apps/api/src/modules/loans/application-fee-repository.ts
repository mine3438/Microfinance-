import { type ApplicationFee, type ApplicationFeeState } from '@mfi/contracts';
import { type Database } from '@mfi/db';

/**
 * The application/form fee.
 *
 * Kept entirely away from the loan's money. Nothing here reads or writes
 * `loans.outstanding_balance`, `loans.penalty_balance`, `payments` or
 * `repayment_schedules` — which is what makes the approved rule structurally
 * true rather than merely remembered: the fee is not deducted from
 * disbursement, not added to principal, not interest-bearing, and not reachable
 * by the repayment allocator.
 */

/** The application a fee belongs to, as the rules need to see it. */
export interface FeeSubject {
  readonly loanId: string;
  readonly branchId: string;
  readonly status: string;
  readonly fee: ApplicationFee | null;
}

export interface FeeToCollect {
  readonly loanId: string;
  readonly amount: string;
  readonly collectedOn: string;
  readonly method: string | null;
  readonly reference: string | null;
}

interface FeeRow {
  id: string;
  loan_id: string;
  amount: string;
  collected_on: Date;
  method: string | null;
  reference: string | null;
  collected_by: string;
  collected_by_name: string | null;
  refunded_on: Date | null;
  refunded_by: string | null;
  refunded_by_name: string | null;
  refund_reason: string | null;
  loan_status: string;
  loan_rejection_reason: string | null;
}

const FEE_PROJECTION = `
  SELECT f.id, f.loan_id, f.amount, f.collected_on, f.method, f.reference,
         f.collected_by, c.full_name AS collected_by_name,
         f.refunded_on, f.refunded_by, r.full_name AS refunded_by_name, f.refund_reason,
         l.status AS loan_status, l.rejection_reason AS loan_rejection_reason
    FROM loan_application_fees f
    JOIN loans l ON l.id = f.loan_id
    LEFT JOIN users c ON c.id = f.collected_by
    LEFT JOIN users r ON r.id = f.refunded_by`;

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Where the fee stands.
 *
 * Derived on read rather than stored, so it cannot disagree with the two facts
 * that actually govern it: whether the money was handed back, and what became
 * of the application.
 *
 * `refund_due` keys on a *recorded* rejection rather than on the status,
 * because a rejected application is returned to the officer as a draft and the
 * status does not rest at `rejected`.
 */
export function feeStateOf(row: {
  refunded_on: Date | null;
  loan_status: string;
  loan_rejection_reason: string | null;
}): ApplicationFeeState {
  if (row.refunded_on !== null) {
    return 'refunded';
  }

  // Approved, disbursed, running or closed: the application succeeded, so the
  // institution retains the fee.
  if (['approved', 'active', 'completed', 'written_off'].includes(row.loan_status)) {
    return 'retained';
  }

  // A rejection was recorded and the application has not been picked back up.
  // Once it is resubmitted it is live again and the fee belongs to it.
  if (row.loan_rejection_reason !== null && row.loan_status === 'draft') {
    return 'refund_due';
  }

  return 'collected';
}

function toFee(row: FeeRow): ApplicationFee {
  return {
    id: row.id,
    loanId: row.loan_id,
    amount: row.amount,
    collectedOn: formatDateOnly(row.collected_on),
    method: row.method,
    reference: row.reference,
    collectedBy: row.collected_by,
    collectedByName: row.collected_by_name,
    state: feeStateOf(row),
    refundedOn: row.refunded_on === null ? null : formatDateOnly(row.refunded_on),
    refundedBy: row.refunded_by,
    refundedByName: row.refunded_by_name,
    refundReason: row.refund_reason,
  };
}

export interface ApplicationFeeRepository {
  subject(institutionId: string, userId: string, loanId: string): Promise<FeeSubject | null>;
  collect(institutionId: string, userId: string, fee: FeeToCollect): Promise<ApplicationFee | null>;
  refund(
    institutionId: string,
    userId: string,
    loanId: string,
    refundedOn: string,
    reason: string | null,
  ): Promise<ApplicationFee | null>;
}

export class PostgresApplicationFeeRepository implements ApplicationFeeRepository {
  public constructor(private readonly database: Database) {}

  public async subject(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<FeeSubject | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const loans = await client.query<{
        id: string;
        branch_id: string;
        status: string;
        rejection_reason: string | null;
      }>('SELECT id, branch_id, status, rejection_reason FROM loans WHERE id = $1', [loanId]);

      const loan = loans.rows[0];
      if (loan === undefined) {
        return null;
      }

      const fees = await client.query<FeeRow>(`${FEE_PROJECTION} WHERE f.loan_id = $1`, [loanId]);
      const fee = fees.rows[0];

      return {
        loanId: loan.id,
        branchId: loan.branch_id,
        status: loan.status,
        fee: fee === undefined ? null : toFee(fee),
      };
    });
  }

  /**
   * Record the collection.
   *
   * The branch comes from the loan, so the receipt is reported against the
   * branch that took the application rather than wherever the clerk was
   * standing. Returns null when the application is gone, which the use case
   * turns into the same refusal a missing loan gets.
   */
  public async collect(
    institutionId: string,
    userId: string,
    fee: FeeToCollect,
  ): Promise<ApplicationFee | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO loan_application_fees
           (institution_id, loan_id, branch_id, amount, collected_on, method, reference, collected_by)
         SELECT $1, l.id, l.branch_id, $3, $4, $5, $6, $7
           FROM loans l
          WHERE l.id = $2
         RETURNING id`,
        [institutionId, fee.loanId, fee.amount, fee.collectedOn, fee.method, fee.reference, userId],
      );

      if (inserted.rows[0] === undefined) {
        return null;
      }

      const rows = await client.query<FeeRow>(`${FEE_PROJECTION} WHERE f.loan_id = $1`, [
        fee.loanId,
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The application fee was recorded but could not be read back.');
      }
      return toFee(row);
    });
  }

  /**
   * Stamp the refund.
   *
   * The collection columns are untouched — a database trigger refuses any
   * attempt to amend them — so what was taken stays evidenced alongside the
   * fact that it was handed back. The `refunded_at IS NULL` predicate is the
   * single-use guard, on the write rather than in a preceding read, so two
   * concurrent refunds cannot both succeed.
   */
  public async refund(
    institutionId: string,
    userId: string,
    loanId: string,
    refundedOn: string,
    reason: string | null,
  ): Promise<ApplicationFee | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE loan_application_fees
            SET refunded_on = $2, refunded_by = $3, refunded_at = now(), refund_reason = $4
          WHERE loan_id = $1 AND refunded_at IS NULL
          RETURNING id`,
        [loanId, refundedOn, userId, reason],
      );

      if (updated.rows[0] === undefined) {
        return null;
      }

      const rows = await client.query<FeeRow>(`${FEE_PROJECTION} WHERE f.loan_id = $1`, [loanId]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The refund was recorded but could not be read back.');
      }
      return toFee(row);
    });
  }
}
