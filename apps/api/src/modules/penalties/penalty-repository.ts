import { type Database } from '@mfi/db';
import { accruePenalty, overdueInstalments, type ScheduledAmount } from '@mfi/domain';
import { Money } from '@mfi/money';

/**
 * Accruing penalty across the book.
 *
 * The whole operation is **idempotent by date**, and that is the property worth
 * protecting: running it twice on a Tuesday must not charge a borrower twice.
 * Each loan carries a watermark (`penalty_accrued_to`), and the accrual charges
 * only the days between the watermark and the date it is asked about. Asked
 * again for the same date, every loan is already at that watermark and nothing
 * moves.
 *
 * A loan whose product has no penalty terms is not selected at all — §13.1's
 * values are still outstanding, so today that is every loan, and this job
 * correctly does nothing to an unconfigured book.
 */

/** One loan the job may charge, with its product's terms. */
interface AccruableRow {
  id: string;
  principal: string;
  penalty_balance: string;
  penalty_accrued_to: Date | null;
  disbursement_date: Date;
  penalty_daily_rate: string;
  penalty_grace_days: number;
  penalty_cap_fraction: string | null;
}

interface ScheduleRow {
  loan_id: string;
  due_date: Date;
  total_due: string;
}

interface ReceiptRow {
  loan_id: string;
  received: string;
}

/**
 * Loans that can be charged and are behind the date being accrued to.
 *
 * `penalty_accrued_to IS DISTINCT FROM $1` rather than `<` so a watermark
 * somehow ahead of the date is recomputed rather than silently skipped, and
 * `IS NULL` is included by the same operator rather than by a second clause.
 */
const ACCRUABLE_SELECT = `SELECT l.id, l.principal, l.penalty_balance, l.penalty_accrued_to,
              l.disbursement_date, p.penalty_daily_rate, p.penalty_grace_days,
              p.penalty_cap_fraction
         FROM loans l
         JOIN loan_products p ON p.id = l.product_id
        WHERE l.status = 'active'
          AND l.disbursement_date IS NOT NULL
          AND l.disbursement_date <= $1
          AND p.penalty_daily_rate IS NOT NULL
          AND l.penalty_accrued_to IS DISTINCT FROM $1::date`;

const SCHEDULE_SELECT = `SELECT loan_id, due_date, total_due
         FROM repayment_schedules
        WHERE loan_id = ANY($1::uuid[])
        ORDER BY loan_id, due_date`;

/**
 * What has been received against each loan, net of reversals.
 *
 * A reversal is recorded as its own payment row referring to the original, so
 * excluding both sides is what makes "received" mean money the institution
 * still holds.
 */
const RECEIPTS_SELECT = `SELECT p.loan_id, COALESCE(sum(p.amount_paid), 0) AS received
         FROM payments p
        WHERE p.loan_id = ANY($1::uuid[])
          AND p.date_paid <= $2
          AND p.reverses_payment_id IS NULL
          AND NOT EXISTS (
                SELECT 1 FROM payments r WHERE r.reverses_payment_id = p.id
              )
        GROUP BY p.loan_id`;

export interface AccrualOutcome {
  /** Loans considered, whether or not anything was charged. */
  readonly loansConsidered: number;
  /** Penalty added across the book on this run. */
  readonly charged: Money;
}

export interface PenaltyRepository {
  accrueTo(institutionId: string, userId: string, asAt: string): Promise<AccrualOutcome>;
}

export class PostgresPenaltyRepository implements PenaltyRepository {
  public constructor(private readonly database: Database) {}

  public async accrueTo(
    institutionId: string,
    userId: string,
    asAt: string,
  ): Promise<AccrualOutcome> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const loans = await client.query<AccruableRow>(ACCRUABLE_SELECT, [asAt]);

      if (loans.rows.length === 0) {
        return { loansConsidered: 0, charged: Money.zero() };
      }

      const ids = loans.rows.map((row) => row.id);
      // Sequential: one connection cannot run two statements at once (§25.1).
      const schedules = await client.query<ScheduleRow>(SCHEDULE_SELECT, [ids]);
      const receipts = await client.query<ReceiptRow>(RECEIPTS_SELECT, [ids, asAt]);

      const scheduleByLoan = new Map<string, ScheduledAmount[]>();
      for (const row of schedules.rows) {
        const instalments = scheduleByLoan.get(row.loan_id) ?? [];
        instalments.push({
          dueDate: dateOnly(row.due_date),
          totalDue: Money.fromDatabaseValue(row.total_due),
        });
        scheduleByLoan.set(row.loan_id, instalments);
      }

      const receivedByLoan = new Map<string, Money>(
        receipts.rows.map((row) => [row.loan_id, Money.fromDatabaseValue(row.received)]),
      );

      let charged = Money.zero();

      for (const loan of loans.rows) {
        // Charged **from the watermark**, not from the due date: the days before
        // it have already been billed, and re-billing them is precisely what the
        // watermark exists to prevent. A loan never accrued starts at its
        // disbursement, so its first run covers its whole life.
        const from = loan.penalty_accrued_to ?? loan.disbursement_date;

        const overdue = overdueInstalments(
          scheduleByLoan.get(loan.id) ?? [],
          receivedByLoan.get(loan.id) ?? Money.zero(),
          asAt,
        );

        const toDate = accruePenalty(
          overdue,
          {
            dailyRate: loan.penalty_daily_rate,
            graceDays: loan.penalty_grace_days,
            capFraction: loan.penalty_cap_fraction,
          },
          Money.fromDatabaseValue(loan.principal),
          asAt,
        );

        const alreadyCharged = accruePenalty(
          overdue,
          {
            dailyRate: loan.penalty_daily_rate,
            graceDays: loan.penalty_grace_days,
            capFraction: loan.penalty_cap_fraction,
          },
          Money.fromDatabaseValue(loan.principal),
          dateOnly(from),
        );

        // The increment, not the total. The balance already holds what earlier
        // runs charged, and a payment may since have reduced it — overwriting
        // with the total would undo that payment.
        const increment = toDate.total.minus(alreadyCharged.total);
        const addition = increment.isNegative() ? Money.zero() : increment;

        await client.query(
          `UPDATE loans
              SET penalty_balance = penalty_balance + $2::numeric,
                  penalty_accrued_to = $3::date
            WHERE id = $1`,
          [loan.id, addition.toDatabaseValue(), asAt],
        );

        charged = charged.plus(addition);
      }

      return { loansConsidered: loans.rows.length, charged };
    });
  }
}

function dateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
