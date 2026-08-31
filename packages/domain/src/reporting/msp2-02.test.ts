import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { type FinanceEntry, type Msp2_02Line } from '../finance/entry.js';
import { compileMsp2_02 } from './msp2-02.js';
import { reportingPeriod } from './period.js';

const Q1 = reportingPeriod(2026, 1);
const Q2 = reportingPeriod(2026, 2);
const CALENDAR_YEAR = '2026-01-01';

/**
 * The MSP2-02 taxonomy, as `reference.form_lines` seeds it.
 *
 * Written out rather than abbreviated, because the compiler's contract is that
 * it refuses a taxonomy that does not match BOT's structure — and a fixture
 * that quietly omitted a line would test the refusal instead of the form.
 */
const COMPUTED = new Set([1, 7, 13, 16, 23, 40, 42]);
const INCOME = new Set([2, 3, 4, 5, 6, 17, 18, 19, 20, 21, 22]);

const LINES: readonly Msp2_02Line[] = Array.from({ length: 42 }, (_, index) => {
  const sno = index + 1;
  const isComputed = COMPUTED.has(sno);
  return {
    sno,
    label: `Line ${String(sno)}`,
    isComputed,
    entryDirection: isComputed ? null : INCOME.has(sno) ? 'income' : 'expense',
  };
});

const entry = (
  sno: number,
  amount: string,
  entryDate: string,
  direction: 'income' | 'expense' = INCOME.has(sno) ? 'income' : 'expense',
): FinanceEntry => ({ sno, direction, amount: Money.of(amount), entryDate });

const rowFor = (
  form: { rows: readonly { sno: number; quarterAmount: Money; yearToDateAmount: Money }[] },
  sno: number,
): { quarter: string; yearToDate: string } => {
  const row = form.rows.find((candidate) => candidate.sno === sno);
  if (row === undefined) {
    throw new Error(`No row for Sno ${String(sno)}`);
  }
  return {
    quarter: row.quarterAmount.toDatabaseValue(),
    yearToDate: row.yearToDateAmount.toDatabaseValue(),
  };
};

describe('compileMsp2_02', () => {
  it('prints every line BOT publishes, including the ones with nothing on them', () => {
    const form = compileMsp2_02({
      lines: LINES,
      entries: [],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    expect(form.rows).toHaveLength(42);
    expect(rowFor(form, 24)).toEqual({ quarter: '0.00', yearToDate: '0.00' });
  });

  it('sums entries onto the line they were recorded against', () => {
    const form = compileMsp2_02({
      lines: LINES,
      entries: [
        entry(2, '1500000.00', '2026-01-15'),
        entry(2, '2250000.50', '2026-02-20'),
        entry(24, '900000.00', '2026-03-01'),
      ],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    expect(rowFor(form, 2).quarter).toBe('3750000.50');
    expect(rowFor(form, 24).quarter).toBe('900000.00');
  });

  it('derives every subtotal BOT computes', () => {
    const form = compileMsp2_02({
      lines: LINES,
      entries: [
        entry(2, '5000000.00', '2026-01-10'), // interest income
        entry(8, '1000000.00', '2026-01-11'), // interest expense
        entry(17, '400000.00', '2026-02-10'), // non-interest income (commissions)
        entry(24, '1200000.00', '2026-02-11'), // non-interest expense (salaries)
        entry(14, '300000.00', '2026-03-05'), // bad debts written off
        entry(15, '200000.00', '2026-03-05'), // provision charge
        entry(41, '150000.00', '2026-03-31'), // income tax provision
      ],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    expect(rowFor(form, 1).quarter).toBe('5000000.00');
    expect(rowFor(form, 7).quarter).toBe('1000000.00');
    // Net interest income = 1 less 2
    expect(rowFor(form, 13).quarter).toBe('4000000.00');
    expect(rowFor(form, 16).quarter).toBe('400000.00');
    expect(rowFor(form, 23).quarter).toBe('1200000.00');
    // Before tax = 3 + 6 less 4, 5 and 7 = 4,000,000 + 400,000 − 1,700,000
    expect(rowFor(form, 40).quarter).toBe('2700000.00');
    // After tax = 8 less 9
    expect(rowFor(form, 42).quarter).toBe('2550000.00');
  });

  it('reports a loss as a negative figure rather than clamping it at zero', () => {
    // An institution whose interest expense exceeds its interest income files a
    // negative Sno13, and one that spends more than it earns files a negative
    // Sno42. Flooring either at zero would report a profit that was not made.
    const form = compileMsp2_02({
      lines: LINES,
      entries: [entry(2, '100000.00', '2026-01-10'), entry(8, '450000.00', '2026-01-11')],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    expect(rowFor(form, 13).quarter).toBe('-350000.00');
    expect(rowFor(form, 42).quarter).toBe('-350000.00');
  });

  it('excludes an entry dated outside the quarter from the quarter column', () => {
    const form = compileMsp2_02({
      lines: LINES,
      entries: [entry(2, '1000000.00', '2026-01-15'), entry(2, '9000000.00', '2026-04-02')],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    // The April entry belongs to Q2 and to no part of a Q1 return, in either
    // column: the year-to-date window ends at the quarter end.
    expect(rowFor(form, 2)).toEqual({ quarter: '1000000.00', yearToDate: '1000000.00' });
  });

  it('accumulates earlier quarters of the fiscal year into the year-to-date column', () => {
    const form = compileMsp2_02({
      lines: LINES,
      entries: [
        entry(2, '1000000.00', '2026-02-15'), // Q1
        entry(2, '2000000.00', '2026-05-15'), // Q2
      ],
      period: Q2,
      fiscalYearStart: CALENDAR_YEAR,
    });

    expect(rowFor(form, 2)).toEqual({ quarter: '2000000.00', yearToDate: '3000000.00' });
  });

  it('makes the two columns equal in the first quarter of the fiscal year', () => {
    // The identity an institution checks first. It holds by construction only
    // because the year-to-date window is inclusive of the quarter.
    const form = compileMsp2_02({
      lines: LINES,
      entries: [entry(2, '1234567.89', '2026-03-30')],
      period: Q1,
      fiscalYearStart: CALENDAR_YEAR,
    });

    const row = rowFor(form, 2);
    expect(row.yearToDate).toBe(row.quarter);
  });

  it('follows a fiscal year that does not start in January', () => {
    // A July fiscal year puts the January quarter in the *previous* year, so
    // its year-to-date column reaches back to the preceding July. §11.8 is
    // unsettled, which is why the boundary is a required parameter.
    const form = compileMsp2_02({
      lines: LINES,
      entries: [
        entry(2, '500000.00', '2025-08-10'), // inside a July fiscal year
        entry(2, '700000.00', '2026-02-10'), // the reporting quarter
      ],
      period: Q1,
      fiscalYearStart: '2025-07-01',
    });

    expect(rowFor(form, 2)).toEqual({ quarter: '700000.00', yearToDate: '1200000.00' });
    expect(form.yearToDateFrom).toBe('2025-07-01');
    expect(form.yearToDateTo).toBe('2026-03-31');
  });

  it('refuses a fiscal year that begins after the quarter it reports', () => {
    expect(() =>
      compileMsp2_02({
        lines: LINES,
        entries: [],
        period: Q1,
        fiscalYearStart: '2026-07-01',
      }),
    ).toThrow(DomainValidationError);
  });

  it('refuses an entry against a line BOT computes', () => {
    expect(() =>
      compileMsp2_02({
        lines: LINES,
        entries: [entry(23, '100.00', '2026-01-05', 'expense')],
        period: Q1,
        fiscalYearStart: CALENDAR_YEAR,
      }),
    ).toThrow(/computes rather than accepting entry/);
  });

  it('refuses an entry recorded on the wrong side of the statement', () => {
    expect(() =>
      compileMsp2_02({
        lines: LINES,
        entries: [entry(24, '100.00', '2026-01-05', 'income')],
        period: Q1,
        fiscalYearStart: CALENDAR_YEAR,
      }),
    ).toThrow(/which is expense/);
  });

  it('refuses a taxonomy whose structure is not the one BOT published', () => {
    // A revised template that renumbered a subtotal would otherwise produce a
    // form whose totals no longer describe the rows above them.
    const revised = LINES.map((line) =>
      line.sno === 13 ? { ...line, isComputed: false, entryDirection: 'income' as const } : line,
    );

    expect(() =>
      compileMsp2_02({
        lines: revised,
        entries: [],
        period: Q1,
        fiscalYearStart: CALENDAR_YEAR,
      }),
    ).toThrow(/may have been revised/);
  });

  it('refuses to compile without the taxonomy at all', () => {
    expect(() =>
      compileMsp2_02({ lines: [], entries: [], period: Q1, fiscalYearStart: CALENDAR_YEAR }),
    ).toThrow(DomainValidationError);
  });
});
