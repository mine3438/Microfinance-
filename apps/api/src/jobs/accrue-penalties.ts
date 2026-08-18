import { PostgresPenaltyRepository } from '../modules/penalties/penalty-repository.js';
import { runJob } from './run-for-every-institution.js';

/**
 * The scheduled penalty accrual.
 *
 * The same defect as the classification job had, found the same way and worth
 * stating plainly: `POST /penalties/accrual` existed, and nothing ran it. A
 * borrower's penalty would have accrued only on the days somebody happened to
 * press a button.
 *
 * It is more dangerous than the classification gap in one respect and less in
 * another, and both are worth being precise about.
 *
 * **Less:** penalty balances reach no BOT return. Nothing on MSP2-01 through
 * MSP2-10 carries them, so an un-accrued book files a correct return. There is
 * no filing gate here, and adding one would be inventing a rule BOT has not
 * written.
 *
 * **More:** because no return depends on it, nothing refuses. Classification
 * going stale stops the reports screen with a red panel somebody has to answer.
 * Penalty accrual going stale produces no symptom at all — the arrears on every
 * borrower's account are simply lower than the agreement says, indefinitely,
 * and the first person to notice is a borrower who was charged the right amount
 * after a gap and asks why it jumped.
 *
 * The accrual itself is idempotent by date: each loan carries a watermark and
 * the run charges only the days between it and the date asked for. Running
 * twice on a Tuesday charges nothing the second time, and a book left
 * un-accrued for a week is caught up in one run to the same figure as seven
 * daily ones. That is what makes a missed night recoverable rather than lost.
 */
export async function runPenaltyAccrual(): Promise<number> {
  // The database's date, not this process's: a job fired at 00:05 in one zone
  // against a server in another must not accrue a day that has not started
  // where the loans live. `accrueTo` takes a date, so it is read from the
  // database inside the run.
  return runJob({
    name: 'Penalty accrual',
    institutionIds: (database) => new PostgresPenaltyRepository(database).listInstitutionIds(),
    forInstitution: async (institutionId, database) => {
      const today = await database.withTransaction(async (client) => {
        const rows = await client.query<{ today: string }>(
          "SELECT to_char(CURRENT_DATE, 'YYYY-MM-DD') AS today",
        );
        return rows.rows[0]?.today ?? '';
      });

      const outcome = await new PostgresPenaltyRepository(database).accrueTo(
        institutionId,
        institutionId,
        today,
      );

      return {
        summary:
          `Accrued penalty for ${institutionId} to ${today}: ` +
          `${String(outcome.loansConsidered)} loan(s) considered, ` +
          `${outcome.charged.toString()} charged.`,
      };
    },
  });
}
