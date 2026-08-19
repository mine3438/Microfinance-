import { type OverdueClassification, type PortfolioSummary } from '@mfi/contracts';
import { type Database } from '@mfi/db';
import { OVERDUE_CLASSIFICATIONS, nonPerformingRatio } from '@mfi/domain';
import { Money } from '@mfi/money';

/**
 * Running the overdue classification.
 *
 * The work itself is `update_overdue_classifications()`, a database function
 * that has existed since migration 0011: it recomputes every active loan's days
 * overdue, places each in a provisioning band, stamps `system_health`, and
 * returns the number of loans no band covers. What was missing was anything
 * that called it.
 *
 * That absence is precisely the defect this system was built to replace. The
 * predecessor scheduled its classification job with a `pg_cron` line left
 * commented out, so no loan's classification ever changed after creation and a
 * loan forty days overdue kept reporting "Current" to the Bank of Tanzania
 * (00-PROJECT-ANALYSIS.md R5). Nothing crashed; the numbers simply were not
 * true.
 *
 * So there are two callers rather than one, and both matter. The CLI is what a
 * scheduler runs unattended. The endpoint is what an operator uses when the
 * reports screen tells them the figures are stale — because a refusal that
 * cannot be acted on from the screen that raised it sends people to a database
 * console, which is how the previous build's job came to be run by hand and
 * then forgotten.
 */

/** What one institution's run did. */
export interface ClassificationRun {
  readonly institutionId: string;
  /**
   * Loans no provisioning band covers, left unclassified rather than defaulted.
   *
   * Not incidental: BOT's housing microfinance schedule begins at 91 days and
   * defines nothing below it (02-BOT-REPORTING-SPEC.md §11.5), so a housing
   * loan less overdue than that has no classification BOT has issued. Placing
   * it in `current` would understate provisions and file a wrong MSP2-03, so
   * the job counts it and the readiness gate refuses on the count.
   */
  readonly unclassifiableLoanCount: number;
}

export interface ClassificationRepository {
  /** The book by BOT's five classes, as at the last run. */
  summary(institutionId: string, userId: string): Promise<PortfolioSummary>;
  /** Reclassify one institution's active loans. */
  reclassify(institutionId: string, userId: string, asAt?: string): Promise<ClassificationRun>;
  /**
   * Every institution the job should cover.
   *
   * Not tenant-scoped, and it cannot be: the scheduled run has no institution
   * to scope to — covering all of them is the whole job. It returns
   * identifiers only, so nothing crosses a tenant boundary here beyond the
   * fact that an institution exists.
   */
  listInstitutionIds(): Promise<string[]>;
}

export class PostgresClassificationRepository implements ClassificationRepository {
  public constructor(private readonly database: Database) {}

  public async reclassify(
    institutionId: string,
    userId: string,
    asAt?: string,
  ): Promise<ClassificationRun> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // `asAt` defaults in the function rather than here, so an unattended run
      // takes the database's own date rather than the application server's —
      // two clocks that can disagree across a midnight boundary.
      const result =
        asAt === undefined
          ? await client.query<{ unclassifiable: number }>(
              'SELECT update_overdue_classifications($1) AS unclassifiable',
              [institutionId],
            )
          : await client.query<{ unclassifiable: number }>(
              'SELECT update_overdue_classifications($1, $2::date) AS unclassifiable',
              [institutionId, asAt],
            );

      return {
        institutionId,
        unclassifiableLoanCount: result.rows[0]?.unclassifiable ?? 0,
      };
    });
  }

  /**
   * The loan book by classification, as it stands now.
   *
   * **The only reader of `loans.overdue_class` in the system.** Until this
   * existed, the classification job wrote three columns nothing consumed: the
   * MSP2 compilers deliberately reconstruct classification point-in-time
   * instead, because a return for a quarter that closed six weeks ago must
   * describe the book as it stood then rather than today.
   *
   * The health stamp comes back with the figures rather than beside them,
   * because these numbers are exactly as old as the last run and a screen that
   * cannot say so is R5 — a dashboard showing a stopped job's last answer as
   * though it were current.
   *
   * Loans the job could not classify are counted separately, never folded into
   * `current`. BOT has no column for them (§11.5) and quietly calling them
   * performing is how a book looks healthier than it is.
   */
  public async summary(institutionId: string, userId: string): Promise<PortfolioSummary> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const byClass = await client.query<{
        overdue_class: OverdueClassification | null;
        loan_count: string;
        outstanding: string;
      }>(
        `SELECT overdue_class,
                count(*) AS loan_count,
                COALESCE(sum(COALESCE(outstanding_balance, principal)), 0) AS outstanding
           FROM loans
          WHERE status = 'active'
          GROUP BY overdue_class`,
      );

      const health = await client.query<{
        classifications_updated_at: Date | null;
      }>('SELECT classifications_updated_at FROM system_health');

      const outstandingByClass = new Map<OverdueClassification, Money>();
      const countByClass = new Map<OverdueClassification, number>();
      let unclassifiedLoanCount = 0;

      for (const row of byClass.rows) {
        const count = Number.parseInt(row.loan_count, 10);
        if (row.overdue_class === null) {
          // Either never classified or covered by no band. Both are "not on a
          // BOT column", and neither may be reported as performing.
          unclassifiedLoanCount += count;
          continue;
        }
        outstandingByClass.set(row.overdue_class, Money.fromDatabaseValue(row.outstanding));
        countByClass.set(row.overdue_class, count);
      }

      const classes = OVERDUE_CLASSIFICATIONS.map((classification) => ({
        classification,
        loanCount: countByClass.get(classification) ?? 0,
        outstanding: (outstandingByClass.get(classification) ?? Money.zero()).toDatabaseValue(),
      }));

      // Through the domain's own function, which is MSP2-03 line 73's
      // definition — not a second implementation of the same ratio.
      const portfolio = Object.fromEntries(
        OVERDUE_CLASSIFICATIONS.map((classification) => [
          classification,
          outstandingByClass.get(classification) ?? Money.zero(),
        ]),
      ) as Record<OverdueClassification, Money>;

      const totalOutstanding = Money.sum(Object.values(portfolio));

      return {
        classes,
        totalOutstanding: totalOutstanding.toDatabaseValue(),
        totalLoans: classes.reduce((total, row) => total + row.loanCount, 0),
        nonPerformingRatio: nonPerformingRatio(portfolio).toString(),
        classificationsUpdatedAt: health.rows[0]?.classifications_updated_at?.toISOString() ?? null,
        unclassifiedLoanCount,
      };
    });
  }

  public async listInstitutionIds(): Promise<string[]> {
    return this.database.withTransaction(async (client) => {
      // Through the function rather than the table. `withTransaction` does not
      // step down to `mfi_app`, so a plain SELECT here reads everything in
      // development and CI — where the connection is a superuser and row-level
      // security does not apply — and nothing in production, where the
      // application connects as `mfi_app` and the tenancy policy evaluates
      // false with no tenant set. The job would have reported success having
      // classified nothing. Migration 0024 explains the alternative that was
      // rejected.
      const rows = await client.query<{ institution_id: string }>(
        'SELECT institution_id FROM institution_ids_for_classification()',
      );
      return rows.rows.map((row) => row.institution_id);
    });
  }
}
