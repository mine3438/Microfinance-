import { type RepaymentSchedule as DomainSchedule } from '@mfi/domain';
import { type LoanRestructuring } from '@mfi/contracts';
import { type Database } from '@mfi/db';

/**
 * Restructuring: a new loan carrying what the old one still owed.
 *
 * The whole operation is one transaction, and it has to be. Between closing the
 * old loan and opening the new one there is an instant where the borrower owes
 * either nothing or everything twice, and neither may ever be observable —
 * "it must never be possible for both the old and new loan to behave as
 * simultaneously active independent debts" is the approved rule, and a
 * transaction is what makes it structural rather than hoped for.
 *
 * Nothing is deleted. The old loan keeps its schedule, its payments and its
 * classification history; it moves to `restructured`, which is a state of its
 * own precisely so it is not mistaken for a loan somebody repaid.
 */

/** What the old loan looks like when somebody proposes restructuring it. */
export interface RestructuringSubject {
  readonly loanId: string;
  readonly branchId: string;
  readonly clientId: string;
  readonly productId: string;
  readonly status: string;
  readonly monthlyRate: string;
  readonly interestMethod: 'flat' | 'reducing_balance';
  readonly termMonths: number;
  readonly outstandingPrincipal: string;
  readonly penaltyOutstanding: string;
  readonly interestAlreadyPaid: string;
  readonly schedule: readonly { dueDate: string; interestDue: string }[];
  /** Last scheduled due date — the originally agreed maturity. */
  readonly originalMaturity: string | null;
  readonly alreadyRestructured: boolean;
}

export interface RestructuringToRecord {
  readonly oldLoanId: string;
  readonly principalCarried: string;
  readonly interestCapitalised: string;
  readonly penaltiesCapitalised: string;
  readonly newPrincipal: string;
  readonly reason: string;
  readonly requestedBy: string;
  readonly effectiveOn: string;
  readonly schedule: DomainSchedule;
}

interface RestructuringRow {
  id: string;
  old_loan_id: string;
  new_loan_id: string;
  principal_carried: string;
  interest_capitalised: string;
  penalties_capitalised: string;
  new_principal: string;
  reason: string;
  requested_by: string;
  approved_by: string;
  approved_by_name: string | null;
  approved_at: Date;
}

const RESTRUCTURING_PROJECTION = `
  SELECT r.id, r.old_loan_id, r.new_loan_id, r.principal_carried,
         r.interest_capitalised, r.penalties_capitalised, r.new_principal,
         r.reason, r.requested_by, r.approved_by, u.full_name AS approved_by_name,
         r.approved_at
    FROM loan_restructurings r
    LEFT JOIN users u ON u.id = r.approved_by`;

function toRestructuring(row: RestructuringRow): LoanRestructuring {
  return {
    id: row.id,
    oldLoanId: row.old_loan_id,
    newLoanId: row.new_loan_id,
    principalCarried: row.principal_carried,
    interestCapitalised: row.interest_capitalised,
    penaltiesCapitalised: row.penalties_capitalised,
    newPrincipal: row.new_principal,
    reason: row.reason,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedAt: row.approved_at.toISOString(),
  };
}

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export interface RestructuringRepository {
  subject(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<RestructuringSubject | null>;
  /** Close the old loan, open the new one, link them. One transaction. */
  restructure(
    institutionId: string,
    userId: string,
    restructuring: RestructuringToRecord,
  ): Promise<LoanRestructuring | null>;
}

export class PostgresRestructuringRepository implements RestructuringRepository {
  public constructor(private readonly database: Database) {}

  public async subject(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<RestructuringSubject | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const loans = await client.query<{
        id: string;
        branch_id: string;
        client_id: string;
        product_id: string;
        status: string;
        monthly_rate: string;
        interest_method: string;
        term_months: number;
        outstanding_balance: string | null;
        penalty_balance: string;
        interest_paid: string;
        already_restructured: boolean;
      }>(
        `SELECT l.id, l.branch_id, l.client_id, l.product_id, l.status,
                l.monthly_rate, l.interest_method, l.term_months,
                l.outstanding_balance, l.penalty_balance,
                COALESCE(
                  (SELECT sum(p.interest_portion) FROM payments p WHERE p.loan_id = l.id), 0
                )::text AS interest_paid,
                EXISTS (
                  SELECT 1 FROM loan_restructurings r WHERE r.old_loan_id = l.id
                ) AS already_restructured
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

      const rows = schedule.rows.map((row) => ({
        dueDate: formatDateOnly(row.due_date),
        interestDue: row.interest_due,
      }));

      return {
        loanId: loan.id,
        branchId: loan.branch_id,
        clientId: loan.client_id,
        productId: loan.product_id,
        status: loan.status,
        monthlyRate: loan.monthly_rate,
        interestMethod: loan.interest_method === 'flat' ? 'flat' : 'reducing_balance',
        termMonths: loan.term_months,
        outstandingPrincipal: loan.outstanding_balance ?? '0.00',
        penaltyOutstanding: loan.penalty_balance,
        interestAlreadyPaid: loan.interest_paid,
        schedule: rows,
        // The originally agreed maturity, taken from the schedule rather than
        // recomputed from the term: the schedule is what the borrower agreed to.
        originalMaturity: rows.at(-1)?.dueDate ?? null,
        alreadyRestructured: loan.already_restructured,
      };
    });
  }

  /**
   * Close the old loan, open its successor, and link the two.
   *
   * Order is deliberate. The old loan is closed first, on a predicate that it is
   * still active, so a second or concurrent request matches no row and stops
   * before anything else is written. Only then is the new loan created.
   *
   * The new loan's `disbursement_date` is the restructuring date, because the
   * schema requires a disbursed loan to have one and that is the day the new
   * facility began. What that means for MSP2-09 — which counts every loan whose
   * disbursement date falls in the quarter — is RESTRUCT-06, unresolved: no cash
   * moves in a restructuring, so counting it as a disbursement may overstate
   * lending. The link in `loan_restructurings` is what will let the compiler
   * exclude them once that is decided.
   */
  public async restructure(
    institutionId: string,
    userId: string,
    restructuring: RestructuringToRecord,
  ): Promise<LoanRestructuring | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const closed = await client.query<{
        id: string;
        branch_id: string;
        client_id: string;
        product_id: string;
        monthly_rate: string;
        interest_method: string;
        term_months: number;
      }>(
        `UPDATE loans
            SET status = 'restructured', outstanding_balance = 0, penalty_balance = 0
          WHERE id = $1 AND status = 'active'
          RETURNING id, branch_id, client_id, product_id, monthly_rate, interest_method, term_months`,
        [restructuring.oldLoanId],
      );

      const old = closed.rows[0];
      if (old === undefined) {
        return null;
      }

      // The successor carries the old loan's terms, not the product's current
      // ones. A product may have been repriced since; restructuring is not the
      // moment to move a borrower onto a rate they never agreed to.
      const created = await client.query<{ id: string }>(
        `INSERT INTO loans
           (institution_id, branch_id, client_id, product_id,
            principal, monthly_rate, interest_method, term_months,
            status, submitted_by, submitted_at, decided_by, decided_at,
            disbursed_by, disbursement_date, outstanding_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 'draft', NULL, NULL, NULL, NULL, NULL, NULL, NULL)
         RETURNING id`,
        [
          institutionId,
          old.branch_id,
          old.client_id,
          old.product_id,
          restructuring.newPrincipal,
          old.monthly_rate,
          old.interest_method,
          old.term_months,
        ],
      );

      const newLoanId = created.rows[0]?.id;
      if (newLoanId === undefined) {
        throw new Error('The restructured loan could not be created.');
      }

      // Through the status machine rather than around it, so the same
      // transitions that govern an ordinary advance govern this one. The
      // approver is the decider, and it is not the requester — the maker-checker
      // constraint on `loans` enforces that at the table.
      await client.query(`UPDATE loans SET status = 'pending_approval' WHERE id = $1`, [newLoanId]);
      await client.query(
        `UPDATE loans SET status = 'approved', decided_by = $2, decided_at = now() WHERE id = $1`,
        [newLoanId, userId],
      );
      await client.query(
        `UPDATE loans
            SET status = 'active', disbursed_by = $2,
                disbursement_date = $3, outstanding_balance = $4
          WHERE id = $1`,
        [newLoanId, userId, restructuring.effectiveOn, restructuring.newPrincipal],
      );

      for (const instalment of restructuring.schedule.instalments) {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date,
              principal_due, interest_due, total_due)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            institutionId,
            newLoanId,
            instalment.monthNumber,
            formatDateOnly(instalment.dueDate),
            instalment.principalDue.toDatabaseValue(),
            instalment.interestDue.toDatabaseValue(),
            instalment.totalDue.toDatabaseValue(),
          ],
        );
      }

      await client.query(
        `INSERT INTO loan_restructurings
           (institution_id, old_loan_id, new_loan_id, principal_carried,
            interest_capitalised, penalties_capitalised, new_principal,
            reason, requested_by, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          institutionId,
          restructuring.oldLoanId,
          newLoanId,
          restructuring.principalCarried,
          restructuring.interestCapitalised,
          restructuring.penaltiesCapitalised,
          restructuring.newPrincipal,
          restructuring.reason,
          restructuring.requestedBy,
          userId,
        ],
      );

      const rows = await client.query<RestructuringRow>(
        `${RESTRUCTURING_PROJECTION} WHERE r.old_loan_id = $1`,
        [restructuring.oldLoanId],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The restructuring was recorded but could not be read back.');
      }
      return toRestructuring(row);
    });
  }
}
