import { Database } from '@mfi/db';

import { ConfigurationError, loadEnvironment } from '../config/environment.js';
import { PostgresClassificationRepository } from '../modules/portfolio/classification-repository.js';

/**
 * The scheduled overdue classification.
 *
 * This is the process a cron entry or systemd timer runs, once a day, ahead of
 * anyone opening the reports screen. It exists because of R5 in the project
 * analysis: the system being replaced had this job, scheduled by a `pg_cron`
 * line left commented out, and so no loan's classification ever changed after
 * creation. A loan forty days overdue reported "Current" to the dashboard and
 * to the Bank of Tanzania for as long as the system ran.
 *
 * Three decisions follow from that being a *silent* failure.
 *
 * **It exits non-zero when anything fails.** A scheduler that cannot tell
 * success from failure is the commented-out cron line again in a different
 * costume. One institution failing does not stop the others — the rest of the
 * book still needs classifying — but the process still ends unsuccessfully so
 * the run is not recorded as clean.
 *
 * **It reports loans it could not classify.** A run that touches every loan and
 * leaves forty of them unclassifiable has not made the return fileable, because
 * the readiness gate refuses on that count. Printing "done" would be true and
 * useless.
 *
 * **It says what it did on stdout, every time.** A job whose only output is
 * silence gives an operator nothing to notice the absence of.
 */
export async function runClassification(): Promise<number> {
  let environment;
  try {
    environment = loadEnvironment();
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(error.message);
      return 78; // EX_CONFIG
    }
    throw error;
  }

  const database = Database.fromConnectionString(environment.DATABASE_URL, {
    applicationRole: environment.DATABASE_APPLICATION_ROLE,
  });

  try {
    await database.verifyReadiness();

    const classification = new PostgresClassificationRepository(database);
    const institutionIds = await classification.listInstitutionIds();

    if (institutionIds.length === 0) {
      // Not an error, but not silence either: an empty run is indistinguishable
      // from a broken one unless it says so.
      console.log('Classification: no institutions to classify.');
      return 0;
    }

    let failures = 0;
    let unclassifiableTotal = 0;

    for (const institutionId of institutionIds) {
      try {
        // The job acts as the system rather than as a person, so it passes the
        // institution's own identifier as the acting user. Nothing in the
        // classification writes an audit row attributed to a human.
        const run = await classification.reclassify(institutionId, institutionId);
        unclassifiableTotal += run.unclassifiableLoanCount;

        console.log(
          run.unclassifiableLoanCount === 0
            ? `Classified ${institutionId}.`
            : `Classified ${institutionId} — ${String(run.unclassifiableLoanCount)} loan(s) ` +
                'no provisioning band covers. Their returns cannot be filed until §11.5 is resolved.',
        );
      } catch (error: unknown) {
        failures += 1;
        console.error(
          `Failed to classify ${institutionId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    console.log(
      `Classification finished: ${String(institutionIds.length - failures)} of ` +
        `${String(institutionIds.length)} institution(s), ` +
        `${String(unclassifiableTotal)} loan(s) unclassifiable.`,
    );

    return failures === 0 ? 0 : 1;
  } finally {
    await database.close();
  }
}
