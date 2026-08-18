import { type Database } from '@mfi/db';

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
