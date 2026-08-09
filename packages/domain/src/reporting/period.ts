import { DomainValidationError } from '../errors.js';

/**
 * The quarter a return covers.
 *
 * Every MSP2 form is quarterly, and every figure on one is either a balance
 * *as at* the quarter end or a movement *during* the quarter. Getting that
 * distinction wrong is not a rounding error — it is reporting a snapshot where
 * a flow belongs, which no validation rule in BOT's template would catch
 * because both are numbers of the right shape.
 *
 * So a period is a value with both boundaries on it, and each compiler states
 * which one it uses.
 */
export const QUARTERS = [1, 2, 3, 4] as const;

export type Quarter = (typeof QUARTERS)[number];

/** Earliest year a return may be filed for, as a guard against a typed figure. */
const EARLIEST_YEAR = 2000;

export interface ReportingPeriod {
  readonly year: number;
  readonly quarter: Quarter;
  /** First day of the quarter, inclusive. `YYYY-MM-DD`. */
  readonly startDate: string;
  /** Last day of the quarter, inclusive. `YYYY-MM-DD`. */
  readonly endDate: string;
}

/** Whether a number is one of BOT's four quarters. */
export function isQuarter(value: number): value is Quarter {
  return (QUARTERS as readonly number[]).includes(value);
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/**
 * Build the calendar quarter a return covers.
 *
 * **Calendar, not fiscal.** MSP2-02 carries a year-to-date column and whether
 * that follows the calendar year or an institution's own fiscal year is an open
 * question (02-BOT-REPORTING-SPEC.md §11.8). The quarterly boundaries
 * themselves are not in doubt — BOT's forms are filed for calendar quarters —
 * so this function is safe to write and the fiscal-year question only bites on
 * MSP2-02, which is not built.
 *
 * @throws {DomainValidationError} for a quarter or year outside what can be filed.
 */
export function reportingPeriod(year: number, quarter: number): ReportingPeriod {
  if (!Number.isInteger(year) || year < EARLIEST_YEAR || year > 9999) {
    throw new DomainValidationError(
      `A reporting year must be a whole year from ${String(EARLIEST_YEAR)} onwards, received ${String(year)}.`,
    );
  }
  if (!isQuarter(quarter)) {
    throw new DomainValidationError(
      `A reporting quarter must be 1, 2, 3 or 4, received ${String(quarter)}.`,
    );
  }

  const startMonth = (quarter - 1) * 3 + 1;
  const endMonth = startMonth + 2;

  return {
    year,
    quarter,
    startDate: `${pad(year, 4)}-${pad(startMonth, 2)}-01`,
    // Day zero of the following month is the last day of this one, which gets
    // the quarter ends right — 31 March, 30 June, 30 September, 31 December —
    // without a table of month lengths or a leap-year rule.
    endDate: `${pad(year, 4)}-${pad(endMonth, 2)}-${pad(new Date(Date.UTC(year, endMonth, 0)).getUTCDate(), 2)}`,
  };
}

/** The period containing a given date. */
export function periodContaining(isoDate: string): ReportingPeriod {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(isoDate);
  if (match === null) {
    throw new DomainValidationError(`Expected a calendar date, received "${isoDate}".`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const quarter = Math.ceil(month / 3);

  return reportingPeriod(year, quarter);
}

/** `2026-Q1`, for a filename or a heading. */
export function formatPeriod(period: ReportingPeriod): string {
  return `${pad(period.year, 4)}-Q${String(period.quarter)}`;
}

/** Whether a calendar date falls within the period, inclusive of both ends. */
export function periodContains(period: ReportingPeriod, isoDate: string): boolean {
  return isoDate >= period.startDate && isoDate <= period.endDate;
}
