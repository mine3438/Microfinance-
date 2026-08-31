import { DomainValidationError } from '../errors.js';

/** Days in `month` (0-indexed) of `year`, accounting for leap years. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Add whole months to a date, clamping to the end of the target month.
 *
 * A loan disbursed on the 31st has no 31st to fall due on in February. Adding
 * months naively rolls over — 31 January plus one month becomes 3 March — which
 * puts an instalment in the wrong month and, at quarter boundaries, in the
 * wrong BOT return.
 *
 * Every due date is computed from the original anchor rather than by stepping
 * from the previous instalment. Stepping accumulates the clamp: 31 January
 * clamped to 28 February would then produce 28 March, 28 April, and so on,
 * silently moving every remaining due date three days earlier for the life of
 * the loan.
 */
export function addMonthsFromAnchor(anchor: Date, monthsToAdd: number): Date {
  if (!Number.isInteger(monthsToAdd)) {
    throw new DomainValidationError(
      `Months to add must be a whole number, received ${String(monthsToAdd)}.`,
    );
  }

  const anchorDay = anchor.getUTCDate();
  const targetMonthIndex = anchor.getUTCMonth() + monthsToAdd;

  const targetYear = anchor.getUTCFullYear() + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;

  const day = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));

  return new Date(Date.UTC(targetYear, targetMonth, day));
}

/**
 * Monthly due dates for a loan, one per instalment.
 *
 * The first falls one month after disbursement, which is the convention the
 * previous system used and the one borrowers are quoted.
 */
export function monthlyDueDates(disbursementDate: Date, termMonths: number): Date[] {
  return Array.from({ length: termMonths }, (_unused, index) =>
    addMonthsFromAnchor(disbursementDate, index + 1),
  );
}
