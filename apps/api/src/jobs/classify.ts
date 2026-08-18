import { PostgresClassificationRepository } from '../modules/portfolio/classification-repository.js';
import { runJob } from './run-for-every-institution.js';

/**
 * The scheduled overdue classification.
 *
 * This is the process a cron entry or systemd timer runs, once a day, ahead of
 * anyone opening the reports screen. It exists because of R5 in the project
 * analysis: the system being replaced had this job, scheduled by a `pg_cron`
 * line left commented out, so no loan's classification ever changed after
 * creation. A loan forty days overdue reported "Current" to the dashboard and
 * to the Bank of Tanzania for as long as the system ran.
 *
 * The failure semantics that follow from that being a *silent* failure live in
 * `run-for-every-institution.ts`, which both scheduled jobs share.
 */
export async function runClassification(): Promise<number> {
  return runJob({
    name: 'Classification',
    institutionIds: (database) =>
      new PostgresClassificationRepository(database).listInstitutionIds(),
    forInstitution: async (institutionId, database) => {
      // The job acts as the system rather than as a person, so it passes the
      // institution's own identifier as the acting user.
      const run = await new PostgresClassificationRepository(database).reclassify(
        institutionId,
        institutionId,
      );

      return run.unclassifiableLoanCount === 0
        ? { summary: `Classified ${institutionId}.` }
        : {
            summary:
              `Classified ${institutionId} — ${String(run.unclassifiableLoanCount)} loan(s) ` +
              'no provisioning band covers. Their returns cannot be filed until §11.5 is resolved.',
            needsAttention: true,
          };
    },
  });
}
