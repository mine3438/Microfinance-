import { type Payment } from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';

interface PaymentRow {
  id: string;
  loan_id: string;
  loan_code: string | null;
  client_name: string;
  amount_paid: string;
  penalty_portion: string;
  fee_portion: string;
  interest_portion: string;
  principal_portion: string;
  unallocated_amount: string;
  balance_before: string;
  balance_after: string;
  date_paid: Date;
  notes: string | null;
  recorded_by: string;
  created_at: Date;
  reverses_payment_id: string | null;
  reversal_reason: string | null;
  reversed_by_payment_id: string | null;
}

/**
 * One projection for every payment read.
 *
 * `reversed_by_payment_id` is a correlated lookup rather than a stored column:
 * the reversal names its original, so the inverse is derived. Storing it would
 * mean writing the original row when the reversal is recorded, and the
 * application deliberately holds no UPDATE privilege on this table.
 */
const PAYMENT_PROJECTION = `
  SELECT p.id, p.loan_id, l.loan_code, c.full_name AS client_name,
         p.amount_paid, p.penalty_portion, p.fee_portion,
         p.interest_portion, p.principal_portion, p.unallocated_amount,
         p.balance_before, p.balance_after, p.date_paid, p.notes,
         p.recorded_by, p.created_at,
         p.reverses_payment_id, p.reversal_reason,
         (SELECT r.id FROM payments r WHERE r.reverses_payment_id = p.id) AS reversed_by_payment_id
    FROM payments p
    JOIN loans l   ON l.id = p.loan_id
    JOIN clients c ON c.id = l.client_id`;

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    loanId: row.loan_id,
    loanCode: row.loan_code,
    clientName: row.client_name,
    amountPaid: row.amount_paid,
    allocation: {
      penalty: row.penalty_portion,
      fee: row.fee_portion,
      interest: row.interest_portion,
      principal: row.principal_portion,
      unallocated: row.unallocated_amount,
    },
    balanceBefore: row.balance_before,
    balanceAfter: row.balance_after,
    datePaid: formatDateOnly(row.date_paid),
    notes: row.notes,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
    reversesPaymentId: row.reverses_payment_id,
    reversalReason: row.reversal_reason,
    reversedByPaymentId: row.reversed_by_payment_id,
  };
}

/** What a loan currently owes, as the allocator needs it. */
export interface LoanBalance {
  readonly loanId: string;
  readonly branchId: string;
  readonly status: string;
  readonly outstandingBalance: string;
  /** Interest still unpaid across the schedule. */
  readonly interestOutstanding: string;
  /** Penalty accrued and unpaid. Allocated against first, per §24.3. */
  readonly penaltyOutstanding: string;
}

export interface PaymentToRecord {
  readonly loanId: string;
  readonly amountPaid: string;
  readonly penalty: string;
  readonly fee: string;
  readonly interest: string;
  readonly principal: string;
  readonly unallocated: string;
  readonly balanceBefore: string;
  readonly balanceAfter: string;
  readonly datePaid: string;
  readonly notes: string | null;
}

export interface ReversalToRecord {
  readonly originalPaymentId: string;
  readonly reason: string;
  readonly datePaid: string;
}

export interface PaymentListFilters {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly loanId?: string | undefined;
  readonly clientId?: string | undefined;
  readonly branchId?: string | undefined;
}

export interface PaymentRepository {
  list(
    institutionId: string,
    userId: string,
    filters: PaymentListFilters,
  ): Promise<PagedRows<Payment>>;
  find(institutionId: string, userId: string, paymentId: string): Promise<Payment | null>;
  loanBalance(institutionId: string, userId: string, loanId: string): Promise<LoanBalance | null>;
  record(institutionId: string, userId: string, payment: PaymentToRecord): Promise<Payment>;
  reverse(
    institutionId: string,
    userId: string,
    reversal: ReversalToRecord,
  ): Promise<Payment | null>;
}

export class PostgresPaymentRepository implements PaymentRepository {
  public constructor(private readonly database: Database) {}

  public async list(
    institutionId: string,
    userId: string,
    filters: PaymentListFilters,
  ): Promise<PagedRows<Payment>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      if (filters.cursor !== undefined) {
        parameters.push(decodeCursor(filters.cursor));
        conditions.push(`p.id < $${String(parameters.length)}`);
      }
      if (filters.loanId !== undefined) {
        parameters.push(filters.loanId);
        conditions.push(`p.loan_id = $${String(parameters.length)}`);
      }
      if (filters.clientId !== undefined) {
        parameters.push(filters.clientId);
        conditions.push(`l.client_id = $${String(parameters.length)}`);
      }
      if (filters.branchId !== undefined) {
        parameters.push(filters.branchId);
        conditions.push(`l.branch_id = $${String(parameters.length)}`);
      }

      parameters.push(filters.limit + 1);

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = await client.query<PaymentRow>(
        `${PAYMENT_PROJECTION} ${where} ORDER BY p.id DESC LIMIT $${String(parameters.length)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toPayment), nextCursor: page.nextCursor };
    });
  }

  public async find(
    institutionId: string,
    userId: string,
    paymentId: string,
  ): Promise<Payment | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, (client) =>
      this.findWithin(client, paymentId),
    );
  }

  /**
   * What a loan owes right now.
   *
   * Interest outstanding is summed from the schedule rows less what payments
   * have already applied to interest, so the allocator works from the record
   * rather than from a figure recomputed off the loan's terms. Recomputing it
   * would be a second implementation, and the two could disagree after a
   * reversal.
   */
  public async loanBalance(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<LoanBalance | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        id: string;
        branch_id: string;
        status: string;
        outstanding_balance: string | null;
        interest_outstanding: string;
        penalty_balance: string;
      }>(
        `SELECT l.id, l.branch_id, l.status, l.outstanding_balance, l.penalty_balance,
                COALESCE(
                  (SELECT sum(s.interest_due) FROM repayment_schedules s WHERE s.loan_id = l.id), 0
                )
                - COALESCE(
                  (SELECT sum(p.interest_portion) FROM payments p WHERE p.loan_id = l.id), 0
                ) AS interest_outstanding
           FROM loans l
          WHERE l.id = $1`,
        [loanId],
      );

      const row = rows.rows[0];
      if (row === undefined) {
        return null;
      }

      return {
        loanId: row.id,
        branchId: row.branch_id,
        status: row.status,
        outstandingBalance: row.outstanding_balance ?? '0.00',
        interestOutstanding: row.interest_outstanding,
        penaltyOutstanding: row.penalty_balance,
      };
    });
  }

  /**
   * Record a payment and move the loan's balance. One transaction.
   *
   * The two are inseparable: a payment row without the matching balance change
   * leaves the loan owing money it has been paid, and a balance change without
   * a payment row is an unexplained movement in an audited ledger. The previous
   * system wrote them separately and compensated by hand on failure (R3).
   */
  public async record(
    institutionId: string,
    userId: string,
    payment: PaymentToRecord,
  ): Promise<Payment> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payments
           (institution_id, loan_id, amount_paid,
            penalty_portion, fee_portion, interest_portion, principal_portion,
            unallocated_amount, balance_before, balance_after,
            date_paid, notes, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`,
        [
          institutionId,
          payment.loanId,
          payment.amountPaid,
          payment.penalty,
          payment.fee,
          payment.interest,
          payment.principal,
          payment.unallocated,
          payment.balanceBefore,
          payment.balanceAfter,
          payment.datePaid,
          payment.notes,
          userId,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('Insert returned no payment identifier.');
      }

      await this.applyBalance(client, payment.loanId, payment.balanceAfter, payment.penalty);
      await this.markInstalmentsPaid(client, payment.loanId);

      return this.requireById(client, id);
    });
  }

  /**
   * Reverse a payment by recording its exact negation.
   *
   * Every component is negated, not just the amount: a database trigger refuses
   * a reversal that does not exactly undo its original, because a partial one
   * would leave the loan's balance depending on which rows a reader summed.
   *
   * Concurrency is handled by the unique index on `reverses_payment_id`, not by
   * a row lock. `SELECT ... FOR UPDATE` would need the UPDATE privilege, and
   * the application deliberately holds only SELECT and INSERT on this table —
   * taking a lock here would mean granting the privilege that makes a recorded
   * payment editable, to protect against a race the index already refuses. Two
   * concurrent reversals of one payment leave the loser with a unique
   * violation, which the error handler reports as a conflict.
   */
  public async reverse(
    institutionId: string,
    userId: string,
    reversal: ReversalToRecord,
  ): Promise<Payment | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const original = await client.query<{
        loan_id: string;
        amount_paid: string;
        penalty_portion: string;
        fee_portion: string;
        interest_portion: string;
        principal_portion: string;
        unallocated_amount: string;
        balance_after: string;
        balance_before: string;
      }>(
        `SELECT loan_id, amount_paid, penalty_portion, fee_portion, interest_portion,
                principal_portion, unallocated_amount, balance_before, balance_after
           FROM payments WHERE id = $1`,
        [reversal.originalPaymentId],
      );

      const row = original.rows[0];
      if (row === undefined) {
        return null;
      }

      // The reversal's own snapshots run the other way: it starts from where
      // the original left the loan and returns it to where the original found
      // it, so the pair nets to no movement.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payments
           (institution_id, loan_id, amount_paid,
            penalty_portion, fee_portion, interest_portion, principal_portion,
            unallocated_amount, balance_before, balance_after,
            date_paid, recorded_by, reverses_payment_id, reversal_reason)
         VALUES ($1, $2, -$3::numeric, -$4::numeric, -$5::numeric, -$6::numeric, -$7::numeric,
                 -$8::numeric, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          institutionId,
          row.loan_id,
          row.amount_paid,
          row.penalty_portion,
          row.fee_portion,
          row.interest_portion,
          row.principal_portion,
          row.unallocated_amount,
          row.balance_after,
          row.balance_before,
          reversal.datePaid,
          userId,
          reversal.originalPaymentId,
          reversal.reason,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('Insert returned no reversal identifier.');
      }

      // A reversal puts back what the payment took: the principal balance it
      // reduced, and the penalty it settled. Negating the penalty portion is
      // what makes `penalty_balance - $3` add it back.
      await this.applyBalance(client, row.loan_id, row.balance_before, `-${row.penalty_portion}`);
      await this.markInstalmentsPaid(client, row.loan_id);

      return this.requireById(client, id);
    });
  }

  /**
   * Set the loan's balance, and close it when nothing is left.
   *
   * `completed` is reached only through this path, because it is the only place
   * a balance reaches zero. The status machine's own constraint refuses
   * `completed` with a non-zero balance, so the two cannot disagree.
   */
  private async applyBalance(
    client: TransactionClient,
    loanId: string,
    balanceAfter: string,
    penaltyApplied = '0.00',
  ): Promise<void> {
    await client.query(
      `UPDATE loans
          SET outstanding_balance = $1,
              penalty_balance = penalty_balance - $3::numeric,
              status = CASE
                         WHEN $1::numeric = 0 AND status = 'active' THEN 'completed'
                         WHEN $1::numeric > 0 AND status = 'completed' THEN 'active'
                         ELSE status
                       END
        WHERE id = $2`,
      [balanceAfter, loanId, penaltyApplied],
    );
  }

  /**
   * Mark instalments settled, oldest first, against what has been paid.
   *
   * Recomputed from the payment history on every write rather than incremented,
   * so a reversal un-marks exactly what its original marked. An incremental
   * update would need the reverse operation written twice and could drift.
   */
  private async markInstalmentsPaid(client: TransactionClient, loanId: string): Promise<void> {
    await client.query(
      `WITH paid AS (
         SELECT COALESCE(sum(amount_paid), 0) AS total FROM payments WHERE loan_id = $1
       ),
       running AS (
         SELECT id,
                sum(total_due) OVER (ORDER BY month_number
                                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative
           FROM repayment_schedules WHERE loan_id = $1
       )
       UPDATE repayment_schedules s
          SET is_paid = (running.cumulative <= (SELECT total FROM paid))
         FROM running
        WHERE s.id = running.id
          AND s.is_paid <> (running.cumulative <= (SELECT total FROM paid))`,
      [loanId],
    );
  }

  private async findWithin(client: TransactionClient, paymentId: string): Promise<Payment | null> {
    const rows = await client.query<PaymentRow>(`${PAYMENT_PROJECTION} WHERE p.id = $1`, [
      paymentId,
    ]);
    const row = rows.rows[0];
    return row === undefined ? null : toPayment(row);
  }

  private async requireById(client: TransactionClient, paymentId: string): Promise<Payment> {
    const found = await this.findWithin(client, paymentId);
    if (found === null) {
      throw new Error(`Payment ${paymentId} was written but could not be read back.`);
    }
    return found;
  }
}
