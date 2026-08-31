import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import { type FinanceEntry, type Msp2_02Line } from '../finance/entry.js';
import { periodContains, type ReportingPeriod } from './period.js';

/**
 * MSP2-02 — Statement of Income and Expense.
 *
 * Forty-two lines and **two columns**: the quarter, and the year to date. The
 * second column is why entries are dated rather than bucketed by quarter — the
 * same rows have to aggregate two ways, and a quarter somebody typed cannot be
 * re-cut into a longer window.
 *
 * Seven of the forty-two lines are computed by BOT's template rather than
 * entered. Their composition is written out below, mirroring the formulas
 * seeded in `reference.form_lines.formula`, and the compiler refuses to
 * produce a form whose supplied lines do not match it. A template revision
 * therefore fails loudly rather than reporting subtotals that no longer
 * describe the rows above them.
 */

/** A computed line, and the lines it is made of. */
interface Composition {
  readonly sno: number;
  /** Lines added into this one. */
  readonly plus: readonly number[];
  /** Lines subtracted from it. */
  readonly minus: readonly number[];
}

/**
 * BOT's own arithmetic, by Sno.
 *
 * Ordered so that every line a later entry depends on has been computed by the
 * time it is needed — Sno40 reads Sno13, Sno16 and Sno23, and Sno42 reads
 * Sno40.
 */
const COMPOSITION: readonly Composition[] = Object.freeze([
  // 1. Interest income = a..e
  { sno: 1, plus: [2, 3, 4, 5, 6], minus: [] },
  // 2. Interest expense = a..e
  { sno: 7, plus: [8, 9, 10, 11, 12], minus: [] },
  // 3. Net interest income = 1 less 2
  { sno: 13, plus: [1], minus: [7] },
  // 6. Non-interest income = a..f
  { sno: 16, plus: [17, 18, 19, 20, 21, 22], minus: [] },
  // 7. Non-interest expenses = a..p
  { sno: 23, plus: [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39], minus: [] },
  // 8. Net income before tax = 3 + 6 less 4, 5 and 7
  { sno: 40, plus: [13, 16], minus: [14, 15, 23] },
  // 10. Net income after tax = 8 less 9
  { sno: 42, plus: [40], minus: [41] },
]);

export interface Msp2_02Row {
  readonly sno: number;
  readonly label: string;
  readonly isComputed: boolean;
  /** The reporting quarter alone. */
  readonly quarterAmount: Money;
  /** The fiscal year so far, inclusive of the quarter. */
  readonly yearToDateAmount: Money;
}

export interface Msp2_02 {
  readonly rows: readonly Msp2_02Row[];
  /** The window the year-to-date column covers, so a reader can check it. */
  readonly yearToDateFrom: string;
  readonly yearToDateTo: string;
}

export interface Msp2_02Request {
  /** Every MSP2-02 line BOT publishes, in Sno order. */
  readonly lines: readonly Msp2_02Line[];
  /** Entries from the start of the fiscal year to the end of the quarter. */
  readonly entries: readonly FinanceEntry[];
  readonly period: ReportingPeriod;
  /**
   * First day of the fiscal year the quarter falls in, `YYYY-MM-DD`.
   *
   * Required, never defaulted. Whether BOT's year-to-date column follows the
   * calendar year or an institution's own fiscal year is unsettled
   * (02-BOT-REPORTING-SPEC.md §11.8), and a default would answer that silently
   * in every return the system files.
   */
  readonly fiscalYearStart: string;
}

/**
 * Compile the form.
 *
 * @throws {DomainValidationError} when the supplied lines do not match BOT's
 * published structure, or an entry names a line that does not accept it.
 */
export function compileMsp2_02(request: Msp2_02Request): Msp2_02 {
  if (request.lines.length === 0) {
    throw new DomainValidationError(
      'MSP2-02 cannot be compiled without its line taxonomy. Seed BOT reference data first.',
    );
  }

  if (request.fiscalYearStart > request.period.endDate) {
    throw new DomainValidationError(
      `The fiscal year starting ${request.fiscalYearStart} begins after the quarter ending ` +
        `${request.period.endDate}, so the year-to-date column would cover nothing.`,
    );
  }

  const byLine = new Map(request.lines.map((line) => [line.sno, line]));

  for (const rule of COMPOSITION) {
    const line = byLine.get(rule.sno);
    if (line?.isComputed !== true) {
      throw new DomainValidationError(
        `MSP2-02 line ${String(rule.sno)} is expected to be computed from other lines, but the ` +
          'supplied taxonomy does not describe it that way. BOT’s template may have been revised.',
      );
    }
    for (const referenced of [...rule.plus, ...rule.minus]) {
      if (!byLine.has(referenced)) {
        throw new DomainValidationError(
          `MSP2-02 line ${String(rule.sno)} is composed from line ${String(referenced)}, which ` +
            'the supplied taxonomy does not contain.',
        );
      }
    }
  }

  for (const entry of request.entries) {
    const line = byLine.get(entry.sno);
    if (line === undefined) {
      throw new DomainValidationError(
        `An entry references MSP2-02 line ${String(entry.sno)}, which BOT does not publish.`,
      );
    }
    if (line.entryDirection === null) {
      throw new DomainValidationError(
        `An entry references MSP2-02 line ${String(entry.sno)}, which BOT computes rather than ` +
          'accepting entry on.',
      );
    }
    if (line.entryDirection !== entry.direction) {
      throw new DomainValidationError(
        `An entry recorded as ${entry.direction} references MSP2-02 line ${String(entry.sno)}, ` +
          `which is ${line.entryDirection}.`,
      );
    }
  }

  const inQuarter = request.entries.filter((entry) =>
    periodContains(request.period, entry.entryDate),
  );
  // Inclusive of the quarter, so the year-to-date column of Q1 equals its
  // quarter column — which is the identity an institution checks first.
  const inYear = request.entries.filter(
    (entry) =>
      entry.entryDate >= request.fiscalYearStart && entry.entryDate <= request.period.endDate,
  );

  const quarter = totalsByLine(inQuarter);
  const yearToDate = totalsByLine(inYear);

  applyComposition(quarter);
  applyComposition(yearToDate);

  return {
    rows: request.lines.map((line) => ({
      sno: line.sno,
      label: line.label,
      isComputed: line.isComputed,
      quarterAmount: quarter.get(line.sno) ?? Money.zero(),
      yearToDateAmount: yearToDate.get(line.sno) ?? Money.zero(),
    })),
    yearToDateFrom: request.fiscalYearStart,
    yearToDateTo: request.period.endDate,
  };
}

/** Sum the entered lines. Computed lines are absent until filled in below. */
function totalsByLine(entries: readonly FinanceEntry[]): Map<number, Money> {
  const totals = new Map<number, Money>();

  for (const entry of entries) {
    totals.set(entry.sno, (totals.get(entry.sno) ?? Money.zero()).plus(entry.amount));
  }

  return totals;
}

/**
 * Fill in the computed lines from the entered ones.
 *
 * Subtotals are derived from the rows above them rather than summed
 * independently, because BOT validates that the two agree — and a figure
 * arrived at two ways is a figure that can disagree with itself.
 */
function applyComposition(totals: Map<number, Money>): void {
  for (const rule of COMPOSITION) {
    const added = Money.sum(rule.plus.map((sno) => totals.get(sno) ?? Money.zero()));
    const subtracted = Money.sum(rule.minus.map((sno) => totals.get(sno) ?? Money.zero()));

    // Can be negative, and legitimately so: an institution whose interest
    // expense exceeds its interest income reports a negative Sno13, and a loss
    // is a negative Sno42.
    totals.set(rule.sno, added.minus(subtracted));
  }
}
