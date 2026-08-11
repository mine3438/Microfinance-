import { type Database } from '@mfi/db';
import {
  type AgentBankingBalance,
  type ClassifiedExposure,
  type CounterpartyHolding,
  type FinanceEntry,
  type HoldingKind,
  type Msp2_02Line,
  type StatementLine,
  type Disbursement,
  type DistrictInHierarchy,
  type DistrictPresence,
  type Gender,
  type GeographicExposure,
  type InterestMethod,
  type OverdueClassification,
  type RateExposure,
  type ReportingPeriod,
  type SectorWriteOff,
  classifyByDaysOverdue,
  type ProvisioningBand,
} from '@mfi/domain';
import { Money, Percentage, Rate } from '@mfi/money';

/**
 * Everything the MSP2 compilers need, gathered as at a reporting period.
 *
 * **Point-in-time, not current state.** This is the whole difficulty of the
 * module. `loans.outstanding_balance` and `loans.overdue_class` describe the
 * book *today*; a return filed on 15 April for the quarter ending 31 March must
 * describe it as it stood on 31 March. Fifteen days of ageing move loans
 * between classification buckets, and a payment received on 2 April reduces a
 * balance that BOT wants reported unreduced.
 *
 * So nothing here reads the stored classification or the stored balance.
 * Both are reconstructed from what was recorded and when:
 *
 * - **Outstanding** comes from `payments.balance_after` — the snapshot on the
 *   latest payment dated on or before the period end, or the principal if none.
 * - **Days overdue** comes from comparing the schedule's cumulative amount due
 *   by each date against payments received by that date. `loan_days_overdue()`
 *   cannot be used: it reads `repayment_schedules.is_paid`, which is current
 *   state, so an instalment due in March and settled in April would show as
 *   paid when asked about March.
 *
 * Both are derivable because payments are append-only and carry their own
 * balance snapshots — a design decision from stage 9 that was made for
 * reconciliation and turns out to be what makes restatement possible at all.
 */

interface ExposureRow {
  loan_id: string;
  client_id: string;
  sector_code: string;
  district_code: string;
  date_of_birth: Date;
  gender: Gender;
  bot_loan_type: string;
  provisioning_schedule: string;
  outstanding: string;
  monthly_rate: string;
  interest_method: InterestMethod;
  days_overdue: number;
}

interface BandRow {
  schedule_code: string;
  classification: OverdueClassification;
  min_days_overdue: number;
  max_days_overdue: number | null;
  provision_rate: string;
}

/**
 * The book as at a date, one row per loan.
 *
 * One query rather than one per loan: a portfolio of ten thousand loans would
 * otherwise be ten thousand round trips, and the compilers need every row.
 *
 * It also carries the borrower's district, birth date and gender, so MSP2-10's
 * geographic aggregation is a grouping of these same rows rather than a second
 * execution of this CTE. Two executions would be a second definition of "the
 * book as at a date" — the kind of duplication that stays correct until one of
 * them is edited.
 */
const EXPOSURES_AS_AT = `
  WITH received AS (
    SELECT loan_id, COALESCE(sum(amount_paid), 0) AS total
      FROM payments
     WHERE date_paid <= $1
     GROUP BY loan_id
  ),
  latest_balance AS (
    SELECT DISTINCT ON (loan_id) loan_id, balance_after
      FROM payments
     WHERE date_paid <= $1
     ORDER BY loan_id, date_paid DESC, id DESC
  ),
  written_off AS (
    SELECT aggregate_id AS loan_id
      FROM domain_events
     WHERE event_type = 'loan.written_off'
       AND occurred_at::date <= $1
  ),
  cumulative AS (
    SELECT s.loan_id, s.due_date,
           sum(s.total_due) OVER (
             PARTITION BY s.loan_id ORDER BY s.month_number
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
           ) AS cumulative_due
      FROM repayment_schedules s
  ),
  arrears AS (
    -- The earliest instalment whose cumulative demand exceeded what had been
    -- received by the reporting date is the one the loan is in arrears from.
    SELECT c.loan_id, MAX($1::date - c.due_date) AS days_overdue
      FROM cumulative c
      LEFT JOIN received r ON r.loan_id = c.loan_id
     WHERE c.due_date < $1
       AND c.cumulative_due > COALESCE(r.total, 0)
     GROUP BY c.loan_id
  )
  SELECT l.id AS loan_id,
         l.client_id,
         c.sector_code,
         c.district_code,
         c.date_of_birth,
         c.gender,
         p.bot_loan_type,
         t.provisioning_schedule,
         COALESCE(lb.balance_after, l.principal) AS outstanding,
         l.monthly_rate,
         l.interest_method,
         COALESCE(a.days_overdue, 0) AS days_overdue
    FROM loans l
    JOIN clients c ON c.id = l.client_id
    JOIN loan_products p ON p.id = l.product_id
    JOIN reference.loan_types t ON t.code = p.bot_loan_type
    LEFT JOIN latest_balance lb ON lb.loan_id = l.id
    LEFT JOIN arrears a ON a.loan_id = l.id
   WHERE l.disbursement_date IS NOT NULL
     AND l.disbursement_date <= $1
     AND l.id NOT IN (SELECT loan_id FROM written_off)
     AND COALESCE(lb.balance_after, l.principal) > 0`;

/** Everything one compilation needs. */
export interface PortfolioSnapshot {
  readonly sectorCodes: readonly string[];
  readonly loanTypeCodes: readonly string[];
  readonly districts: readonly DistrictInHierarchy[];
  readonly classifiedExposures: readonly ClassifiedExposure[];
  readonly rateExposures: readonly RateExposure[];
  readonly disbursements: readonly Disbursement[];
  readonly geographic: readonly GeographicExposure[];
  readonly presence: readonly DistrictPresence[];
  readonly writeOffs: readonly SectorWriteOff[];
  /** When classifications were last recomputed, for the freshness gate. */
  readonly classificationsUpdatedAt: Date | null;
  /** Active branches with no BOT district, which MSP2-10 cannot place. */
  readonly unlocatedBranchCount: number;

  /** MSP2-02's line taxonomy, and the entries recorded against it. */
  readonly msp2_02Lines: readonly Msp2_02Line[];
  readonly financeEntries: readonly FinanceEntry[];
  /** MSP2-07's four sections, and MSP2-08's single column. */
  readonly holdings: readonly CounterpartyHolding[];
  readonly agentBankingCodes: readonly string[];
  readonly agentBankingBalances: readonly AgentBankingBalance[];

  /** MSP2-01 and MSP2-05's taxonomies, and the figures entered against them. */
  readonly msp2_01Lines: readonly StatementLine[];
  readonly msp2_05Lines: readonly StatementLine[];
  readonly enteredMsp2_01: ReadonlyMap<number, Money>;
  readonly enteredMsp2_05: ReadonlyMap<number, Money>;
}

export interface ReportRepository {
  snapshot(
    institutionId: string,
    userId: string,
    period: ReportingPeriod,
    /** Earliest entry date the year-to-date column covers, `YYYY-MM-DD`. */
    fiscalYearStart: string,
  ): Promise<PortfolioSnapshot>;
}

export class PostgresReportRepository implements ReportRepository {
  public constructor(private readonly database: Database) {}

  public async snapshot(
    institutionId: string,
    userId: string,
    period: ReportingPeriod,
    fiscalYearStart: string,
  ): Promise<PortfolioSnapshot> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const [sectors, loanTypes, districts, bands] = await Promise.all([
        // Ordered by BOT's own serial number, not alphabetically. Every MSP2
        // form has a fixed number of rows in a fixed order and the EDI
        // validator reads them by position, so the taxonomy order *is* the form
        // layout — sorting by code would file every figure one row out.
        client.query<{ code: string }>('SELECT code FROM reference.sectors ORDER BY sno'),
        client.query<{ code: string }>('SELECT code FROM reference.loan_types ORDER BY sno'),
        client.query<{ code: string; region_code: string }>(
          `SELECT d.code, d.region_code
             FROM reference.districts d
             JOIN reference.regions r ON r.code = d.region_code
            ORDER BY r.sort_order, d.sort_order`,
        ),
        // Only the schedules in force at the period end.
        //
        // Provisioning rates are versioned because BOT can revise them, and a
        // return for a past quarter must be reproducible with the rates that
        // applied then (§11.1). A loan whose schedule was not in force on the
        // reporting date comes back with no band, which the readiness gate
        // refuses — rather than being provisioned at a rate BOT had withdrawn.
        client.query<BandRow>(
          `SELECT b.schedule_code, b.classification, b.min_days_overdue,
                  b.max_days_overdue, b.provision_rate
             FROM reference.provisioning_bands b
             JOIN reference.provisioning_schedules s ON s.code = b.schedule_code
            WHERE s.effective_from <= $1
              AND (s.effective_to IS NULL OR s.effective_to > $1)`,
          [period.endDate],
        ),
      ]);

      const bandsBySchedule = new Map<string, ProvisioningBand[]>();
      for (const row of bands.rows) {
        const schedule = bandsBySchedule.get(row.schedule_code) ?? [];
        schedule.push({
          classification: row.classification,
          minDaysOverdue: row.min_days_overdue,
          maxDaysOverdue: row.max_days_overdue,
          // Bands are stored as fractions (0.2500); the domain works in
          // percentages, and mixing the two is the hundred-fold error the
          // separate types exist to prevent.
          provisionRate: Percentage.fromFraction(row.provision_rate),
        });
        bandsBySchedule.set(row.schedule_code, schedule);
      }

      const exposures = await client.query<ExposureRow>(EXPOSURES_AS_AT, [period.endDate]);

      const classifiedExposures: ClassifiedExposure[] = [];
      const rateExposures: RateExposure[] = [];
      // One entry per borrower per district. MSP2-10 counts borrowers rather
      // than loans, so two loans held by one person in one district are one row
      // with a loan count of two — not two rows.
      const geographic = new Map<string, GeographicExposure>();

      for (const row of exposures.rows) {
        const schedule = bandsBySchedule.get(row.provisioning_schedule) ?? [];
        const result =
          schedule.length === 0 ? null : classifyByDaysOverdue(row.days_overdue, schedule);

        classifiedExposures.push({
          sectorCode: row.sector_code,
          clientId: row.client_id,
          outstanding: Money.fromDatabaseValue(row.outstanding),
          // `null` when no band covers the loan — BOT's housing schedule
          // defines nothing below 91 days. Carried through rather than
          // defaulted, so the compiler can refuse rather than under-report.
          classification: result?.classified === true ? result.classification : null,
          provisionRate: result?.classified === true ? result.provisionRate : null,
        });

        rateExposures.push({
          botLoanType: row.bot_loan_type,
          clientId: row.client_id,
          outstanding: Money.fromDatabaseValue(row.outstanding),
          monthlyRate: Rate.ofMonthlyFraction(row.monthly_rate),
          interestMethod: row.interest_method,
        });

        const outstanding = Money.fromDatabaseValue(row.outstanding);
        const key = `${row.district_code} ${row.client_id}`;
        const existing = geographic.get(key);

        geographic.set(
          key,
          existing === undefined
            ? {
                districtCode: row.district_code,
                clientId: row.client_id,
                dateOfBirth: formatDateOnly(row.date_of_birth),
                gender: row.gender,
                loanCount: 1,
                outstanding,
              }
            : {
                ...existing,
                loanCount: existing.loanCount + 1,
                outstanding: existing.outstanding.plus(outstanding),
              },
        );
      }

      const [disbursed, presence, writeOffs, health, unlocated, lines, entries, balances] =
        await Promise.all([
          client.query<{ sector_code: string; gender: Gender; principal: string }>(
            `SELECT c.sector_code, c.gender, l.principal
             FROM loans l JOIN clients c ON c.id = l.client_id
            WHERE l.disbursement_date BETWEEN $1 AND $2`,
            [period.startDate, period.endDate],
          ),
          // Branches counted where the branch is, and staff counted where their
          // branch is. Grouping by the districts a branch's *clients* live in
          // would count one Arusha branch four times over — once per district it
          // lends into — and file four branches where there is one.
          client.query<{ district_code: string; branch_count: string; employee_count: string }>(
            `SELECT b.district_code,
                  count(DISTINCT b.id)::text AS branch_count,
                  count(DISTINCT u.id)::text AS employee_count
             FROM branches b
             LEFT JOIN users u ON u.branch_id = b.id AND u.status = 'active'
            WHERE b.status = 'active'
              AND b.district_code IS NOT NULL
            GROUP BY b.district_code`,
          ),
          client.query<{ sector_code: string; amount: string }>(
            // The only record of what a write-off was worth and when it happened.
            // The domain-event seam was built in stage 8 for a ledger that does
            // not exist yet; this is its first real consumer.
            `SELECT c.sector_code, sum((e.payload->>'outstanding')::numeric) AS amount
             FROM domain_events e
             JOIN loans l ON l.id = e.aggregate_id
             JOIN clients c ON c.id = l.client_id
            WHERE e.event_type = 'loan.written_off'
              AND e.occurred_at::date BETWEEN $1 AND $2
            GROUP BY c.sector_code`,
            [period.startDate, period.endDate],
          ),
          client.query<{ classifications_updated_at: Date | null }>(
            `SELECT classifications_updated_at FROM system_health WHERE institution_id = $1`,
            [institutionId],
          ),
          client.query<{ count: string }>(
            `SELECT count(*)::text AS count
             FROM branches
            WHERE status = 'active' AND district_code IS NULL`,
          ),
          client.query<{
            sno: number;
            label: string;
            is_computed: boolean;
            entry_direction: 'income' | 'expense' | null;
          }>(
            `SELECT sno, label, is_computed, entry_direction
             FROM reference.form_lines WHERE form_code = 'MSP2-02' ORDER BY sno`,
          ),
          // From the start of the fiscal year, because MSP2-02's second column
          // is year-to-date. The quarter column is cut from the same rows by the
          // compiler, which is only possible because entries carry a date.
          client.query<{
            sno: number;
            direction: 'income' | 'expense';
            amount: string;
            entry_date: Date;
          }>(
            `SELECT sno, direction, amount, entry_date
             FROM finance_entries
            WHERE entry_date BETWEEN $1 AND $2`,
            [fiscalYearStart, period.endDate],
          ),
          client.query<{
            holding_kind: HoldingKind;
            counterparty: string;
            institution_code: string | null;
            currency_code: string;
            deposit_balance_tzs: string;
            borrowing_balance_tzs: string;
            agent_banking_balance: string;
          }>(
            `SELECT a.holding_kind,
                  COALESCE(f.name, a.counterparty_name) AS counterparty,
                  a.institution_code,
                  a.currency_code,
                  v.deposit_balance_tzs,
                  v.borrowing_balance_tzs,
                  v.agent_banking_balance
             FROM bank_account_balances v
             JOIN bank_accounts a ON a.id = v.bank_account_id
             LEFT JOIN reference.financial_institutions f ON f.code = a.institution_code
            WHERE v.year = $1 AND v.quarter = $2`,
            [period.year, period.quarter],
          ),
        ]);

      const [agentBankingCodes, statementLines, enteredLines] = await Promise.all([
        client.query<{ code: string }>(
          `SELECT code FROM reference.financial_institutions
            WHERE in_agent_banking_list ORDER BY sort_order`,
        ),
        client.query<{
          form_code: string;
          sno: number;
          label: string;
          is_computed: boolean;
          accepts_statement_entry: boolean | null;
        }>(
          `SELECT form_code, sno, label, is_computed, accepts_statement_entry
             FROM reference.form_lines
            WHERE form_code IN ('MSP2-01', 'MSP2-05')
            ORDER BY form_code, sno`,
        ),
        client.query<{ form_code: string; sno: number; amount: string }>(
          `SELECT form_code, sno, amount
             FROM financial_statement_lines
            WHERE year = $1 AND quarter = $2`,
          [period.year, period.quarter],
        ),
      ]);

      const linesFor = (formCode: string): StatementLine[] =>
        statementLines.rows
          .filter((row) => row.form_code === formCode)
          .map((row) => ({
            sno: row.sno,
            label: row.label,
            isComputed: row.is_computed,
            acceptsEntry: row.accepts_statement_entry === true,
          }));

      const enteredFor = (formCode: string): Map<number, Money> =>
        new Map(
          enteredLines.rows
            .filter((row) => row.form_code === formCode)
            .map((row) => [row.sno, Money.fromDatabaseValue(row.amount)]),
        );

      return {
        sectorCodes: sectors.rows.map((row) => row.code),
        loanTypeCodes: loanTypes.rows.map((row) => row.code),
        districts: districts.rows.map((row) => ({ code: row.code, regionCode: row.region_code })),
        classifiedExposures,
        rateExposures,
        disbursements: disbursed.rows.map((row) => ({
          sectorCode: row.sector_code,
          gender: row.gender,
          principal: Money.fromDatabaseValue(row.principal),
        })),
        geographic: [...geographic.values()],
        presence: presence.rows.map((row) => ({
          districtCode: row.district_code,
          branchCount: Number(row.branch_count),
          employeeCount: Number(row.employee_count),
          // Zero until savings exist (stage 15). Explicitly zero rather than
          // absent, so the validator can warn that BOT ties this to MSP2-01.
          compulsorySavings: Money.zero(),
        })),
        writeOffs: writeOffs.rows.map((row) => ({
          sectorCode: row.sector_code,
          amount: Money.fromDatabaseValue(row.amount),
        })),
        classificationsUpdatedAt: health.rows[0]?.classifications_updated_at ?? null,
        unlocatedBranchCount: Number(unlocated.rows[0]?.count ?? '0'),
        msp2_02Lines: lines.rows.map((row) => ({
          sno: row.sno,
          label: row.label,
          isComputed: row.is_computed,
          entryDirection: row.entry_direction,
        })),
        financeEntries: entries.rows.map((row) => ({
          sno: row.sno,
          direction: row.direction,
          amount: Money.fromDatabaseValue(row.amount),
          entryDate: formatDateOnly(row.entry_date),
        })),
        // A TZS account fills BOT's shilling column and a foreign one fills the
        // equivalent column beside it. Which column a balance lands in is
        // decided by the account's currency, not by a second field somebody
        // could set to disagree with it.
        holdings: balances.rows.map((row) => {
          const inTzs = row.currency_code === 'TZS';
          const deposit = Money.fromDatabaseValue(row.deposit_balance_tzs);
          const borrowing = Money.fromDatabaseValue(row.borrowing_balance_tzs);

          return {
            kind: row.holding_kind,
            counterparty: row.counterparty,
            depositTzs: inTzs ? deposit : Money.zero(),
            borrowingTzs: inTzs ? borrowing : Money.zero(),
            depositForeignTzsEquivalent: inTzs ? Money.zero() : deposit,
            borrowingForeignTzsEquivalent: inTzs ? Money.zero() : borrowing,
          };
        }),
        agentBankingCodes: agentBankingCodes.rows.map((row) => row.code),
        agentBankingBalances: balances.rows
          .filter((row) => row.institution_code !== null)
          .map((row) => ({
            institutionCode: row.institution_code ?? '',
            balance: Money.fromDatabaseValue(row.agent_banking_balance),
          })),
        msp2_01Lines: linesFor('MSP2-01'),
        msp2_05Lines: linesFor('MSP2-05'),
        enteredMsp2_01: enteredFor('MSP2-01'),
        enteredMsp2_05: enteredFor('MSP2-05'),
      };
    });
  }
}

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
