import { Database } from '@mfi/db';

import { ConfigurationError, loadEnvironment } from '../config/environment.js';

/**
 * The shape every scheduled job in this system has.
 *
 * Both jobs — classification and penalty accrual — do the same four things
 * around their own one line of work: read configuration, confirm the database
 * is usable, walk every institution, and report. The part worth writing once is
 * not the walking; it is the failure semantics, which are easy to get subtly
 * different and expensive to get wrong.
 *
 * - **One institution failing does not stop the others.** A cluster where one
 *   tenant has a broken book must still have the rest of its work done.
 * - **The process still exits non-zero if anything failed.** A scheduler that
 *   cannot tell success from failure is the commented-out `pg_cron` line that
 *   sank the previous system (00-PROJECT-ANALYSIS.md R5) wearing a different
 *   costume.
 * - **Every run says what it did**, including a run that found nothing to do.
 *   A job whose only output is silence gives an operator nothing to notice the
 *   absence of, which is exactly how the original defect stayed invisible.
 */

/** What a job did for one institution, as a line an operator can read. */
export interface InstitutionOutcome {
  /** One line for the log. Written whether or not anything moved. */
  readonly summary: string;
  /**
   * Whether this institution still needs attention after a successful run.
   *
   * Distinct from failure. A classification run that leaves loans no
   * provisioning band covers has succeeded and still not made the return
   * fileable, and a report that said only "done" would mislead.
   */
  readonly needsAttention?: boolean;
}

export interface JobDefinition {
  /** Named in the output, so two jobs in one log are distinguishable. */
  readonly name: string;
  readonly forInstitution: (
    institutionId: string,
    database: Database,
  ) => Promise<InstitutionOutcome>;
  readonly institutionIds: (database: Database) => Promise<string[]>;
}

/**
 * Run one job across every institution of an already-open database.
 *
 * Takes the database rather than opening one, which is what makes the failure
 * semantics above testable at all: a function that reads `process.env` and
 * connects can only be exercised by a test willing to arrange both. Opening the
 * database is {@link runJob}'s business, and nothing else in this codebase
 * reads configuration outside `composition.ts` either.
 *
 * @returns 0 when every institution succeeded, 1 when any failed.
 */
export async function runForEveryInstitution(
  job: JobDefinition,
  database: Database,
): Promise<number> {
  {
    const institutionIds = await job.institutionIds(database);

    if (institutionIds.length === 0) {
      console.log(`${job.name}: no institutions to process.`);
      return 0;
    }

    let failures = 0;
    let needingAttention = 0;

    for (const institutionId of institutionIds) {
      try {
        const outcome = await job.forInstitution(institutionId, database);
        if (outcome.needsAttention === true) {
          needingAttention += 1;
        }
        console.log(outcome.summary);
      } catch (error: unknown) {
        failures += 1;
        console.error(
          `${job.name}: failed for ${institutionId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    const attention =
      needingAttention === 0
        ? ''
        : ` ${String(needingAttention)} institution(s) still need attention.`;

    console.log(
      `${job.name} finished: ${String(institutionIds.length - failures)} of ` +
        `${String(institutionIds.length)} institution(s) processed.${attention}`,
    );

    return failures === 0 ? 0 : 1;
  }
}

/**
 * Open the database, run a job across it, and close.
 *
 * The entry point a scheduled process calls. Configuration failure is 78
 * (EX_CONFIG) so a scheduler can tell "this host is misconfigured" from "this
 * run found a broken book".
 */
export async function runJob(job: JobDefinition): Promise<number> {
  let environment;
  try {
    environment = loadEnvironment();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      // Written to stderr rather than the logger, which is configured from the
      // configuration that just failed to load.
      console.error(error.message);
      return 78;
    }
    throw error;
  }

  const database = Database.fromConnectionString(environment.DATABASE_URL, {
    applicationRole: environment.DATABASE_APPLICATION_ROLE,
  });

  try {
    await database.verifyReadiness();
    return await runForEveryInstitution(job, database);
  } finally {
    await database.close();
  }
}
