import { DomainValidationError } from '../errors.js';

/**
 * The two age bands MSP2-10 reports against.
 *
 * BOT's geographical return splits borrowers, loan counts and outstanding
 * amounts by `Up to 35 Years` and `Above 35 Years`, crossed with gender. There
 * is no third band and no unknown column, so every borrower must fall into one.
 */
export type AgeBand = 'up_to_35' | 'above_35';

/** The boundary between the two bands. */
export const AGE_BAND_THRESHOLD_YEARS = 35;

/** Human-readable labels, worded as BOT's column headers are. */
export const AGE_BAND_LABELS: Readonly<Record<AgeBand, string>> = Object.freeze({
  up_to_35: 'Up to 35 Years',
  above_35: 'Above 35 Years',
});

/**
 * Completed years between two dates.
 *
 * Counts birthdays reached, not elapsed milliseconds divided by 365.25 — the
 * approximation is wrong for anyone born on 29 February and off by a day either
 * side of a birthday for everyone else, which is enough to move a borrower
 * between bands on a quarter boundary.
 */
export function completedYearsBetween(dateOfBirth: Date, asAt: Date): number {
  let years = asAt.getUTCFullYear() - dateOfBirth.getUTCFullYear();

  const monthDelta = asAt.getUTCMonth() - dateOfBirth.getUTCMonth();
  const dayDelta = asAt.getUTCDate() - dateOfBirth.getUTCDate();

  if (monthDelta < 0 || (monthDelta === 0 && dayDelta < 0)) {
    years -= 1;
  }

  return years;
}

/**
 * Which MSP2-10 band a borrower falls into.
 *
 * **The reference date is the caller's decision, deliberately.** BOT's template
 * does not state whether age is taken at disbursement or as at the quarter-end
 * reporting date, and the two produce different returns for anyone who crosses
 * 35 during the life of a loan. That is recorded as an open question in
 * `02-BOT-REPORTING-SPEC.md` §11.4. Rather than pick silently, this function
 * requires the date to be passed, so the choice is visible at every call site
 * and changes in one place when the answer arrives.
 *
 * `Up to 35` is inclusive of exactly 35, matching the wording of BOT's column.
 *
 * @throws {DomainValidationError} when the reference date precedes the birth date.
 */
export function ageBandAt(dateOfBirth: Date, asAt: Date): AgeBand {
  const years = completedYearsBetween(dateOfBirth, asAt);

  if (years < 0) {
    throw new DomainValidationError(
      `Reference date ${asAt.toISOString().slice(0, 10)} precedes the date of birth ` +
        `${dateOfBirth.toISOString().slice(0, 10)}.`,
    );
  }

  return years <= AGE_BAND_THRESHOLD_YEARS ? 'up_to_35' : 'above_35';
}
