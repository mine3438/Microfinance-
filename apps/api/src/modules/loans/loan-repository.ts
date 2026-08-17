import {
  type CreateLoanProductRequest,
  type InterestMethod,
  type Loan,
  type LoanProduct,
  type LoanStatus,
  type RepaymentSchedule,
  type ScheduleInstalment,
} from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';
import { type RepaymentSchedule as DomainSchedule } from '@mfi/domain';
import { Money } from '@mfi/money';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';
import { notFound } from '../../http/errors.js';

interface LoanRow {
  id: string;
  loan_code: string | null;
  branch_id: string;
  branch_name: string;
  client_id: string;
  client_name: string;
  client_code: string;
  product_id: string;
  product_name: string;
  principal: string;
  monthly_rate: string;
  interest_method: InterestMethod;
  term_months: number;
  status: LoanStatus;
  submitted_by: string | null;
  submitted_at: Date | null;
  decided_by: string | null;
  decided_at: Date | null;
  rejection_reason: string | null;
  disbursed_by: string | null;
  disbursement_date: Date | null;
  outstanding_balance: string | null;
  compulsory_savings_secured: string;
  created_at: Date;
  updated_at: Date;
}

interface ScheduleRow {
  month_number: number;
  due_date: Date;
  principal_due: string;
  interest_due: string;
  total_due: string;
  is_paid: boolean;
}

/**
 * One projection for every loan read.
 *
 * Monetary columns are `NUMERIC` and arrive as **strings**, because `@mfi/db`
 * asserts at connection time that the driver has not been reconfigured to parse
 * them as floats. They are passed through untouched: this layer never does
 * arithmetic on money, so there is nothing here to get wrong.
 */
const LOAN_PROJECTION = `
  SELECT l.id, l.loan_code, l.branch_id, b.name AS branch_name,
         l.client_id, c.full_name AS client_name, c.client_code,
         l.product_id, p.name AS product_name,
         l.principal, l.monthly_rate, l.interest_method, l.term_months,
         l.status, l.submitted_by, l.submitted_at, l.decided_by, l.decided_at,
         l.rejection_reason, l.disbursed_by, l.disbursement_date,
         l.outstanding_balance, l.compulsory_savings_secured, l.created_at, l.updated_at
    FROM loans l
    JOIN branches b ON b.id = l.branch_id
    JOIN clients  c ON c.id = l.client_id
    JOIN loan_products p ON p.id = l.product_id`;

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toLoan(row: LoanRow): Loan {
  return {
    id: row.id,
    loanCode: row.loan_code,
    branchId: row.branch_id,
    branchName: row.branch_name,
    clientId: row.client_id,
    clientName: row.client_name,
    clientCode: row.client_code,
    productId: row.product_id,
    productName: row.product_name,
    principal: row.principal,
    monthlyRate: row.monthly_rate,
    interestMethod: row.interest_method,
    termMonths: row.term_months,
    status: row.status,
    submittedBy: row.submitted_by,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
    rejectionReason: row.rejection_reason,
    disbursedBy: row.disbursed_by,
    disbursementDate: row.disbursement_date === null ? null : formatDateOnly(row.disbursement_date),
    outstandingBalance: row.outstanding_balance,
    compulsorySavingsSecured: row.compulsory_savings_secured,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface LoanListFilters {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: LoanStatus | undefined;
  readonly clientId?: string | undefined;
  readonly branchId?: string | undefined;
}

export interface NewLoan {
  readonly branchId: string;
  readonly clientId: string;
  readonly productId: string;
  readonly principal: string;
  readonly monthlyRate: string;
  readonly interestMethod: InterestMethod;
  readonly termMonths: number;
}

/** A client and the product terms an application must satisfy. */
export interface ApplicationContext {
  readonly clientBranchId: string;
  readonly clientStatus: string;
  readonly product: LoanProduct;
}

export interface LoanRepository {
  list(institutionId: string, userId: string, filters: LoanListFilters): Promise<PagedRows<Loan>>;
  find(institutionId: string, userId: string, loanId: string): Promise<Loan | null>;
  findWithSchedule(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<{ loan: Loan; schedule: RepaymentSchedule | null } | null>;
  /** The client and product an application refers to, or null if either is absent. */
  applicationContext(
    institutionId: string,
    userId: string,
    clientId: string,
    productId: string,
  ): Promise<ApplicationContext | null>;
  create(institutionId: string, userId: string, loan: NewLoan): Promise<Loan>;
  /** Record the compulsory savings standing behind a loan (§24.1). */
  secure(
    institutionId: string,
    userId: string,
    loanId: string,
    amount: string,
  ): Promise<Loan | null>;
  submit(institutionId: string, userId: string, loanId: string): Promise<Loan | null>;
  approve(institutionId: string, userId: string, loanId: string): Promise<Loan | null>;
  reject(
    institutionId: string,
    userId: string,
    loanId: string,
    reason: string,
  ): Promise<Loan | null>;
  /** Write the schedule and move the loan to active. One transaction. */
  disburse(
    institutionId: string,
    userId: string,
    loanId: string,
    disbursementDate: string,
    schedule: DomainSchedule,
  ): Promise<Loan | null>;
  /** The approval limit configured for any of these roles, or null for none. */
  approvalLimit(
    institutionId: string,
    userId: string,
    roleCodes: readonly string[],
  ): Promise<string | null>;
  listProducts(institutionId: string, userId: string): Promise<LoanProduct[]>;
  createProduct(
    institutionId: string,
    userId: string,
    product: CreateLoanProductRequest,
  ): Promise<LoanProduct>;
}

interface ProductRow {
  id: string;
  code: string;
  name: string;
  bot_loan_type: string;
  interest_method: InterestMethod;
  min_monthly_rate: string;
  max_monthly_rate: string;
  min_term_months: number;
  max_term_months: number;
  min_principal: string;
  max_principal: string;
  status: 'active' | 'retired';
  penalty_daily_rate: string | null;
  penalty_grace_days: number | null;
  penalty_cap_fraction: string | null;
}

/**
 * A product's columns, listed here and again in `createProduct`'s `RETURNING`.
 *
 * Naming them once and interpolating would be tidier, and the SQL lint rule
 * (§10.5) refuses it: a template holding a SQL keyword may carry no expressions
 * at all. That rule is worth more than the duplication it costs here — it is
 * what makes an interpolated query visible on sight rather than something a
 * reviewer has to trace to a constant — and `toProduct` is the shared piece
 * that actually matters, since a column added to one list and forgotten in the
 * other fails to typecheck against `ProductRow` rather than passing silently.
 */
const PRODUCT_SELECT = `SELECT id, code, name, bot_loan_type, interest_method,
                min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
                min_principal, max_principal, status,
                penalty_daily_rate, penalty_grace_days, penalty_cap_fraction
           FROM loan_products`;

function toProduct(row: ProductRow): LoanProduct {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    botLoanType: row.bot_loan_type,
    interestMethod: row.interest_method,
    minMonthlyRate: row.min_monthly_rate,
    maxMonthlyRate: row.max_monthly_rate,
    minTermMonths: row.min_term_months,
    maxTermMonths: row.max_term_months,
    minPrincipal: row.min_principal,
    maxPrincipal: row.max_principal,
    status: row.status,
    penaltyDailyRate: row.penalty_daily_rate,
    penaltyGraceDays: row.penalty_grace_days,
    penaltyCapFraction: row.penalty_cap_fraction,
  };
}

export class PostgresLoanRepository implements LoanRepository {
  public constructor(private readonly database: Database) {}

  public async list(
    institutionId: string,
    userId: string,
    filters: LoanListFilters,
  ): Promise<PagedRows<Loan>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      if (filters.cursor !== undefined) {
        parameters.push(decodeCursor(filters.cursor));
        conditions.push(`l.id < $${String(parameters.length)}`);
      }
      if (filters.status !== undefined) {
        parameters.push(filters.status);
        conditions.push(`l.status = $${String(parameters.length)}`);
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
      const rows = await client.query<LoanRow>(
        `${LOAN_PROJECTION} ${where} ORDER BY l.id DESC LIMIT $${String(parameters.length)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toLoan), nextCursor: page.nextCursor };
    });
  }

  public async find(institutionId: string, userId: string, loanId: string): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, (client) =>
      this.findWithin(client, loanId),
    );
  }

  public async findWithSchedule(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<{ loan: Loan; schedule: RepaymentSchedule | null } | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const loan = await this.findWithin(client, loanId);
      if (loan === null) {
        return null;
      }

      const rows = await client.query<ScheduleRow>(
        `SELECT month_number, due_date, principal_due, interest_due, total_due, is_paid
           FROM repayment_schedules WHERE loan_id = $1 ORDER BY month_number`,
        [loanId],
      );

      return { loan, schedule: rows.rows.length === 0 ? null : toSchedule(rows.rows, loan) };
    });
  }

  public async applicationContext(
    institutionId: string,
    userId: string,
    clientId: string,
    productId: string,
  ): Promise<ApplicationContext | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const found = await client.query<{
        branch_id: string;
        client_status: string;
        product_id: string;
        code: string;
        name: string;
        bot_loan_type: string;
        interest_method: InterestMethod;
        min_monthly_rate: string;
        max_monthly_rate: string;
        min_term_months: number;
        max_term_months: number;
        min_principal: string;
        max_principal: string;
        product_status: 'active' | 'retired';
        penalty_daily_rate: string | null;
        penalty_grace_days: number | null;
        penalty_cap_fraction: string | null;
      }>(
        `SELECT c.branch_id, c.status AS client_status,
                p.id AS product_id, p.code, p.name, p.bot_loan_type, p.interest_method,
                p.min_monthly_rate, p.max_monthly_rate,
                p.min_term_months, p.max_term_months,
                p.min_principal, p.max_principal,
                p.status AS product_status,
                p.penalty_daily_rate, p.penalty_grace_days, p.penalty_cap_fraction
           FROM clients c
           CROSS JOIN loan_products p
          WHERE c.id = $1 AND p.id = $2`,
        [clientId, productId],
      );

      const row = found.rows[0];
      if (row === undefined) {
        return null;
      }

      return {
        clientBranchId: row.branch_id,
        clientStatus: row.client_status,
        product: {
          id: row.product_id,
          code: row.code,
          name: row.name,
          botLoanType: row.bot_loan_type,
          interestMethod: row.interest_method,
          minMonthlyRate: row.min_monthly_rate,
          maxMonthlyRate: row.max_monthly_rate,
          minTermMonths: row.min_term_months,
          maxTermMonths: row.max_term_months,
          minPrincipal: row.min_principal,
          maxPrincipal: row.max_principal,
          status: row.product_status,
          penaltyDailyRate: row.penalty_daily_rate,
          penaltyGraceDays: row.penalty_grace_days,
          penaltyCapFraction: row.penalty_cap_fraction,
        },
      };
    });
  }

  public async create(institutionId: string, userId: string, loan: NewLoan): Promise<Loan> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO loans
           (institution_id, branch_id, client_id, product_id,
            principal, monthly_rate, interest_method, term_months, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft')
         RETURNING id`,
        [
          institutionId,
          loan.branchId,
          loan.clientId,
          loan.productId,
          loan.principal,
          loan.monthlyRate,
          loan.interestMethod,
          loan.termMonths,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('Insert returned no loan identifier.');
      }
      return this.requireById(client, id);
    });
  }

  /**
   * Move a draft to pending approval.
   *
   * Guarded by `status = 'draft'` rather than read-then-write. Two officers
   * submitting the same draft at once would otherwise both succeed, and the
   * second would overwrite the first's `submitted_by` — a maker-checker record
   * naming the wrong maker.
   */
  public async submit(institutionId: string, userId: string, loanId: string): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE loans
            SET status = 'pending_approval', submitted_by = $1, submitted_at = now()
          WHERE id = $2 AND status = 'draft'
          RETURNING id`,
        [userId, loanId],
      );

      const id = updated.rows[0]?.id;
      return id === undefined ? null : this.requireById(client, id);
    });
  }

  public async approve(
    institutionId: string,
    userId: string,
    loanId: string,
  ): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE loans
            SET status = 'approved', decided_by = $1, decided_at = now()
          WHERE id = $2 AND status = 'pending_approval'
          RETURNING id`,
        [userId, loanId],
      );

      const id = updated.rows[0]?.id;
      return id === undefined ? null : this.requireById(client, id);
    });
  }

  public async reject(
    institutionId: string,
    userId: string,
    loanId: string,
    reason: string,
  ): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Through `rejected` and on to `draft`, in one transaction.
      //
      // The intermediate state is not decoration: it is what records the
      // decider, the timestamp and the required reason, and it is what the
      // audit trigger captures. The officer's queue then shows a draft with the
      // reason attached, rather than a dead application they would have to
      // rekey (§13.3).
      const updated = await client.query<{ id: string }>(
        `UPDATE loans
            SET status = 'rejected', decided_by = $1, decided_at = now(), rejection_reason = $2
          WHERE id = $3 AND status = 'pending_approval'
          RETURNING id`,
        [userId, reason, loanId],
      );

      const id = updated.rows[0]?.id;
      if (id === undefined) {
        return null;
      }

      await client.query(
        `UPDATE loans
            SET status = 'draft', submitted_by = NULL, submitted_at = NULL
          WHERE id = $1`,
        [id],
      );

      return this.requireById(client, id);
    });
  }

  /**
   * Release the money.
   *
   * The schedule rows and the status change are one transaction, and that is the
   * whole point of this method existing rather than two. The system this
   * replaces disbursed by writing the loan, then writing the schedule, then
   * deleting the loan by hand if the second failed — a compensating delete
   * standing in for a transaction (analysis R3). A loan active with no schedule
   * is a borrower with no instalments to pay and a balance nobody can reconcile.
   */
  /**
   * Record the security held against a loan.
   *
   * The amount is not validated here beyond its sign: a database trigger
   * refuses more than the borrower actually holds in compulsory savings, and it
   * has to, because the question spans every loan the borrower has and two of
   * them claiming the same shilling would make MSP2-03 deduct it twice.
   */
  public async secure(
    institutionId: string,
    userId: string,
    loanId: string,
    amount: string,
  ): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query(
        'UPDATE loans SET compulsory_savings_secured = $2 WHERE id = $1',
        [loanId, amount],
      );
      return updated.rowCount === 0 ? null : this.findWithin(client, loanId);
    });
  }

  public async disburse(
    institutionId: string,
    userId: string,
    loanId: string,
    disbursementDate: string,
    schedule: DomainSchedule,
  ): Promise<Loan | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE loans
            SET status = 'active', disbursed_by = $1, disbursement_date = $2,
                outstanding_balance = principal
          WHERE id = $3 AND status = 'approved'
          RETURNING id`,
        [userId, disbursementDate, loanId],
      );

      const id = updated.rows[0]?.id;
      if (id === undefined) {
        return null;
      }

      for (const instalment of schedule.instalments) {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date,
              principal_due, interest_due, total_due)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            institutionId,
            loanId,
            instalment.monthNumber,
            formatDateOnly(instalment.dueDate),
            // Money crosses to the driver as an exact decimal string. A JS
            // number here would be a float, and NUMERIC(15,2) would store
            // whatever the float rounded to.
            instalment.principalDue.toDatabaseValue(),
            instalment.interestDue.toDatabaseValue(),
            instalment.totalDue.toDatabaseValue(),
          ],
        );
      }

      return this.requireById(client, id);
    });
  }

  /**
   * The highest limit configured for any role the approver holds.
   *
   * No row means no authority, never unlimited. The absence of configuration
   * cannot be read as permission — that reading would hand every role the power
   * to approve any amount the moment someone forgot to set a limit.
   */
  public async approvalLimit(
    institutionId: string,
    userId: string,
    roleCodes: readonly string[],
  ): Promise<string | null> {
    if (roleCodes.length === 0) {
      return null;
    }

    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{ max_principal: string }>(
        `SELECT max_principal FROM approval_thresholds
          WHERE role_code = ANY($1::text[])
          ORDER BY max_principal DESC LIMIT 1`,
        [[...roleCodes]],
      );

      return rows.rows[0]?.max_principal ?? null;
    });
  }

  public async listProducts(institutionId: string, userId: string): Promise<LoanProduct[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ProductRow>(`${PRODUCT_SELECT} ORDER BY code`);

      return rows.rows.map(toProduct);
    });
  }

  /**
   * Define a product.
   *
   * The penalty figures arrive here rather than in a migration, which is
   * §13.1's answer put where it belongs: the shape is this system's, the values
   * are the institution's. A product created without them charges no penalty,
   * and that is a legitimate product rather than an unfinished one.
   *
   * Nothing is validated here that the contract has not already checked, with
   * one exception this layer cannot check at all: `bot_loan_type` must name a
   * row in `reference.loan_types`, and its foreign key is what enforces that.
   * A product reporting under a type BOT does not publish would put loans on a
   * return line that does not exist.
   */
  public async createProduct(
    institutionId: string,
    userId: string,
    product: CreateLoanProductRequest,
  ): Promise<LoanProduct> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<ProductRow>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal,
            penalty_daily_rate, penalty_grace_days, penalty_cap_fraction)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id, code, name, bot_loan_type, interest_method,
                   min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
                   min_principal, max_principal, status,
                   penalty_daily_rate, penalty_grace_days, penalty_cap_fraction`,
        [
          institutionId,
          product.code,
          product.name,
          product.botLoanType,
          product.interestMethod,
          product.minMonthlyRate,
          product.maxMonthlyRate,
          product.minTermMonths,
          product.maxTermMonths,
          product.minPrincipal,
          product.maxPrincipal,
          product.penaltyDailyRate ?? null,
          product.penaltyGraceDays ?? null,
          product.penaltyCapFraction ?? null,
        ],
      );

      const row = inserted.rows[0];
      if (row === undefined) {
        throw notFound('The loan product could not be read back after being created.');
      }
      return toProduct(row);
    });
  }

  private async findWithin(client: TransactionClient, loanId: string): Promise<Loan | null> {
    const rows = await client.query<LoanRow>(`${LOAN_PROJECTION} WHERE l.id = $1`, [loanId]);
    const row = rows.rows[0];
    return row === undefined ? null : toLoan(row);
  }

  private async requireById(client: TransactionClient, loanId: string): Promise<Loan> {
    const found = await this.findWithin(client, loanId);
    if (found === null) {
      throw new Error(`Loan ${loanId} was written but could not be read back.`);
    }
    return found;
  }
}

/**
 * Rebuild a stored schedule for the wire.
 *
 * Totals are summed from the stored rows rather than recomputed from the loan's
 * terms. The stored rows are what the borrower owes; regenerating them in order
 * to display them would be a second implementation whose output could differ
 * from the record — the drift this system exists to remove.
 *
 * The arithmetic goes through `@mfi/money`, which is the only place in this
 * codebase permitted to do it. Adding two-place decimals looks trivial enough
 * to write inline, and that is exactly how a second implementation gets made:
 * `Money.fromDatabaseValue` also refuses a value the driver returned as a
 * float, which hand-rolled parsing would silently accept.
 */
function toSchedule(rows: readonly ScheduleRow[], loan: Loan): RepaymentSchedule {
  const instalments: ScheduleInstalment[] = [];

  // Balances are walked down from the advanced principal using the stored
  // principal amounts, so they always agree with the rows they came from.
  let opening = Money.fromDatabaseValue(loan.principal);

  for (const row of rows) {
    const principalDue = Money.fromDatabaseValue(row.principal_due);
    const closing = opening.minus(principalDue);

    instalments.push({
      monthNumber: row.month_number,
      dueDate: formatDateOnly(row.due_date),
      openingBalance: opening.toDatabaseValue(),
      principalDue: row.principal_due,
      interestDue: row.interest_due,
      totalDue: row.total_due,
      closingBalance: closing.toDatabaseValue(),
      isPaid: row.is_paid,
    });

    opening = closing;
  }

  const sum = (pick: (row: ScheduleRow) => string): string =>
    Money.sum(rows.map((row) => Money.fromDatabaseValue(pick(row)))).toDatabaseValue();

  return {
    instalments,
    totalPrincipal: sum((row) => row.principal_due),
    totalInterest: sum((row) => row.interest_due),
    totalRepayable: sum((row) => row.total_due),
  };
}
