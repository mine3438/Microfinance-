import { type Database } from '@mfi/db';

/**
 * Settling a loan before maturity.
 *
 * The settlement writes a `payments` row, and that is deliberate. Interest
 * income on MSP2-02 is summed from `payments.interest_portion`, so a settlement
 * recorded anywhere else would collect the money and report none of it. What
 * makes it a settlement rather than an ordinary repayment is where the split
 * comes from: the settlement rule computes it, not the allocator.
 *
 * The allocator could not be used here even if one wanted to. It splits against
 * everything a loan owes, and what a loan owes includes the whole remaining
 * scheduled interest — so it would consume interest the approved rule says is
 * never charged, and leave principal outstanding.
 *
 * The schedule is left exactly as it is. Instalments after the settlement month
 * keep their interest as history; nothing pays them and nothing deletes them.
 */

/** Everything a quote needs, read in one go. */
export interface SettlementSubject {
  readonly loanId: string;
  readonly branchId: string;
  readonly status: string;
  readonly outstandingPrincipal: string;
  readonly penaltyOutstanding: string;
  readonly interestAlreadyPaid: string;
  readonly schedule: readonly { dueDate: string; interestDue: string }[];
}

/** The split the settlement rule produced, ready to record. */
export interface SettlementToRecord {
  readonly loanId: string;
  readonly principal: string;
  readonly interest: string;
  readonly penalty: string;
  readonly total: string;
  readonly balanceBefore: string;
  readonly settledOn: string;
  readonly notes: string | null;
}

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface SettlementRepository {
  subject(institutionId: string, userId: string, loanId: string): Promise<SettlementSubject | null>;
  /** Record the settlement and close the loan. One transaction. */
  settle(
    institutionId: string,
    userId: string,
    settlement: SettlementToRecord,
  ): Promise<string | null>;
}

export class PostgresSettlementRepository implements SettlementRepository {
  public constructor(private readonly database: Database) {}

  public async subject(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<SettlementSubject | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const loans = await client.query<{
        id: string;
        branch_id: string;
        status: string;
        outstanding_balance: string | null;
        penalty_balance: string;
        interest_paid: string;
      }>(
        `SELECT l.id, l.branch_id, l.status, l.outstanding_balance, l.penalty_balance,
                COALESCE(
                  (SELECT sum(p.interest_portion) FROM payments p WHERE p.loan_id = l.id), 0
                )::text AS interest_paid
           FROM loans l
          WHERE l.id = $1`,
        [loanId],
      );

      const loan = loans.rows[0];
      if (loan === undefined) {
        return null;
      }

      const schedule = await client.query<{ due_date: Date; interest_due: string }>(
        'SELECT due_date, interest_due FROM repayment_schedules WHERE loan_id = $1 ORDER BY due_date',
        [loanId],
      );

      return {
        loanId: loan.id,
        branchId: loan.branch_id,
        status: loan.status,
        outstandingPrincipal: loan.outstanding_balance ?? '0.00',
        penaltyOutstanding: loan.penalty_balance,
        interestAlreadyPaid: loan.interest_paid,
        schedule: schedule.rows.map((row) => ({
          dueDate: formatDateOnly(row.due_date),
          interestDue: row.interest_due,
        })),
      };
    });
  }

  /**
   * Record the settlement.
   *
   * The `status = 'active'` predicate on the closing UPDATE is what makes a
   * repeated request safe: the second one matches no row, and the use case
   * reports the loan already settled rather than recording a second payment
   * against a zero balance.
   *
   * `fee_portion` is zero. The application/form fee was handled at application
   * and never became a loan balance, so it has no part in a settlement quote.
   */
  public async settle(
    institutionId: string,
    userId: string,
    settlement: SettlementToRecord,
  ): Promise<string | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const closed = await client.query<{ id: string }>(
        `UPDATE loans
            SET outstanding_balance = 0, penalty_balance = 0, status = 'completed'
          WHERE id = $1 AND status = 'active'
          RETURNING id`,
        [settlement.loanId],
      );

      if (closed.rows[0] === undefined) {
        return null;
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO payments
           (institution_id, loan_id, amount_paid,
            penalty_portion, fee_portion, interest_portion, principal_portion,
            unallocated_amount, balance_before, balance_after,
            date_paid, notes, recorded_by)
         VALUES ($1, $2, $3, $4, 0, $5, $6, 0, $7, 0, $8, $9, $10)
         RETURNING id`,
        [
          institutionId,
          settlement.loanId,
          settlement.total,
          settlement.penalty,
          settlement.interest,
          settlement.principal,
          settlement.balanceBefore,
          settlement.settledOn,
          settlement.notes,
          userId,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('The settlement was closed but no payment was recorded.');
      }

      // Mark instalments settled, oldest first, exactly as the payment path
      // does. Instalments whose interest was never charged stay unmarked, which
      // is accurate: nothing paid them because nothing charged them.
      await client.query(
        `WITH paid AS (
           SELECT COALESCE(sum(amount_paid), 0) AS total FROM payments WHERE loan_id = $1
         ),
         running AS (
           SELECT s.id,
                  sum(s.total_due) OVER (ORDER BY s.due_date, s.id) AS cumulative
             FROM repayment_schedules s
            WHERE s.loan_id = $1
         )
         UPDATE repayment_schedules s
            SET is_paid = (r.cumulative <= (SELECT total FROM paid))
           FROM running r
          WHERE s.id = r.id`,
        [settlement.loanId],
      );

      return id;
    });
  }
}
