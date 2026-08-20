import { Money, Percentage, Rate } from '@mfi/money';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type FinanceEntry, type Msp2_02Line } from '../finance/entry.js';
import { classifyByDaysOverdue, type ProvisioningBand } from '../portfolio/classification.js';
import { compileMsp2_02 } from './msp2-02.js';
import { compileMsp2_04, type RateExposure } from './msp2-04.js';
import { compileMsp2_10, type GeographicExposure } from './msp2-10.js';
import { reportingPeriod } from './period.js';

/**
 * The unresolved questions, pinned.
 *
 * Every test here guards a question nobody has answered — §11.2, §11.4, §11.5,
 * §11.8 and the loan-fee definition. None of them asserts what the *right*
 * answer is, because none of them knows. What they assert is that the system is
 * still visibly not answering it.
 *
 * That is a different and narrower property than correctness, and it needs its
 * own tests because it fails silently. A hidden `new Date()`, a default
 * substituted for a required parameter, a gap folded into the nearest bucket —
 * none of these throws. Each one just quietly converts "we do not know" into a
 * figure on a return filed with the Bank of Tanzania.
 */

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// §11.4 — the age-band reference date
// ---------------------------------------------------------------------------

const DISTRICTS = [{ code: 'ARU-CC', regionCode: 'ARUSHA' }];

const borrower = (overrides: Partial<GeographicExposure> = {}): GeographicExposure => ({
  districtCode: 'ARU-CC',
  clientId: 'client-1',
  dateOfBirth: '1990-06-15',
  gender: 'female',
  loanCount: 1,
  outstanding: Money.of('400000'),
  ...overrides,
});

describe('§11.4 — age bands never fall back to today', () => {
  it('gives the same answer whatever the system clock says', () => {
    // The failure this guards is not an exception. If anything in the age-band
    // path read the clock instead of `asAt`, a return for Q1 2026 would report
    // different demographics depending on the day it was compiled — and a
    // return refiled a year later would silently disagree with the one on file.
    const request = {
      districts: DISTRICTS,
      exposures: [borrower({ dateOfBirth: '1990-06-15' })],
      presence: [],
      asAt: new Date('2026-03-31T00:00:00Z'),
    };

    vi.useFakeTimers();

    vi.setSystemTime(new Date('2026-04-01T00:00:00Z'));
    const compiledSoonAfter = compileMsp2_10(request);

    vi.setSystemTime(new Date('2035-01-01T00:00:00Z'));
    const compiledNineYearsLater = compileMsp2_10(request);

    expect(compiledNineYearsLater.districts[0]?.cells).toEqual(
      compiledSoonAfter.districts[0]?.cells,
    );

    // Born June 1990, measured March 2026: 35, so the lower band — and still
    // the lower band when compiled in 2035, because the reference date governs
    // and the clock does not.
    expect(compiledSoonAfter.districts[0]?.cells.up_to_35_female.borrowerCount).toBe(1);
  });

  it('reports a different band for a different reference date, so the parameter is real', () => {
    // The companion property. A parameter that is accepted and ignored looks
    // identical to one that is used, until the day the answer matters.
    const born = borrower({ dateOfBirth: '1990-06-15' });

    const before = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [born],
      presence: [],
      asAt: new Date('2026-03-31T00:00:00Z'),
    });
    const after = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [born],
      presence: [],
      asAt: new Date('2026-09-30T00:00:00Z'),
    });

    expect(before.districts[0]?.cells.up_to_35_female.borrowerCount).toBe(1);
    expect(after.districts[0]?.cells.above_35_female.borrowerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §11.2 — annualisation convention
// ---------------------------------------------------------------------------

const TYPES = ['business_micro_loans'];

const rateExposure = (overrides: Partial<RateExposure> = {}): RateExposure => ({
  botLoanType: 'business_micro_loans',
  clientId: 'client-1',
  interestMethod: 'reducing_balance',
  monthlyRate: Rate.ofMonthlyFraction('0.05'),
  outstanding: Money.of('1000000'),
  ...overrides,
});

describe('§11.2 — the annualisation convention stays visible', () => {
  it('applies the convention asked for, and the two differ materially', () => {
    const simple = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] });
    const effective = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [rateExposure()],
      annualisation: 'effective',
    });

    // 5% a month: 60% simple, 79.59% effective. Nearly twenty percentage
    // points, which is why guessing on the institution's behalf is not an
    // option.
    expect(simple.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('60.00');
    expect(effective.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('79.59');
  });

  it('prints which convention produced the figures', () => {
    // Whichever answer BOT eventually gives, a return already filed must say
    // which convention it used. Otherwise the figures cannot be re-derived.
    expect(
      compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] }).annualisation,
    ).toBe('simple');
    expect(
      compileMsp2_04({
        loanTypeCodes: TYPES,
        exposures: [rateExposure()],
        annualisation: 'effective',
      }).annualisation,
    ).toBe('effective');
  });

  it('is deterministic — the same input compiles to the same figures', () => {
    const once = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] });
    const twice = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] });

    expect(twice.rows[0]?.reducingBalance.lowest?.toFixed(6)).toBe(
      once.rows[0]?.reducingBalance.lowest?.toFixed(6),
    );
    expect(twice.annualisation).toBe(once.annualisation);
  });

  it('does not read the clock', () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const january = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] });

    vi.setSystemTime(new Date('2031-12-31T00:00:00Z'));
    const yearsLater = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [rateExposure()] });

    expect(yearsLater.rows[0]?.reducingBalance.lowest?.toFixed(6)).toBe(
      january.rows[0]?.reducingBalance.lowest?.toFixed(6),
    );
  });
});

// ---------------------------------------------------------------------------
// §11.5 — housing loans below 91 days
// ---------------------------------------------------------------------------

/** BOT's housing microfinance schedule. It begins at 91 days. */
const HOUSING: readonly ProvisioningBand[] = [
  {
    classification: 'substandard',
    minDaysOverdue: 91,
    maxDaysOverdue: 180,
    provisionRate: Percentage.of('25'),
  },
  {
    classification: 'doubtful',
    minDaysOverdue: 181,
    maxDaysOverdue: 365,
    provisionRate: Percentage.of('50'),
  },
  {
    classification: 'loss',
    minDaysOverdue: 366,
    maxDaysOverdue: null,
    provisionRate: Percentage.of('100'),
  },
];

describe('§11.5 — a housing loan under 91 days is never called Current', () => {
  it.each([0, 1, 45, 89, 90])('refuses to classify one %i days overdue', (days) => {
    const result = classifyByDaysOverdue(days, HOUSING);

    expect(result.classified).toBe(false);
  });

  it('names the gap rather than reporting a classification', () => {
    const result = classifyByDaysOverdue(30, HOUSING);

    // The refusal has to reach an operator. A silent `current` would understate
    // provisions on MSP2-03 and make the book look healthier than it is —
    // which is the same understatement the classification gate refuses whole
    // returns over.
    expect(result.classified).toBe(false);
    if (!result.classified) {
      expect(result.reason).toBe('no_band_covers_days');
      expect(result.message).toContain('11.5');
    }
  });

  it('classifies normally once BOT’s schedule actually starts', () => {
    const result = classifyByDaysOverdue(91, HOUSING);

    expect(result.classified).toBe(true);
    if (result.classified) {
      expect(result.classification).toBe('substandard');
    }
  });
});

// ---------------------------------------------------------------------------
// §11.8 — the year-to-date window is stated, not implied
// ---------------------------------------------------------------------------

/** BOT's forty-two lines, seven of which its own template computes. */
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

const entry = (entryDate: string, amount = '1000000'): FinanceEntry => ({
  sno: 2,
  direction: 'income',
  amount: Money.of(amount),
  entryDate,
});

describe('§11.8 — the compiled form states the window it used', () => {
  it('reports the fiscal year start it was given, not one it chose', () => {
    const form = compileMsp2_02({
      lines: LINES,
      period: reportingPeriod(2026, 1),
      entries: [entry('2026-02-15')],
      fiscalYearStart: '2025-07-01',
    });

    // Without this on the form, a reader cannot tell a nine-month year-to-date
    // column from a three-month one, and the two are not distinguishable from
    // the figures alone.
    expect(form.yearToDateFrom).toBe('2025-07-01');
    expect(form.yearToDateTo).toBe('2026-03-31');
  });

  it('exposes a window longer than a year rather than normalising it away', () => {
    // A December fiscal year makes Q4 straddle the boundary. Whether an
    // institution may declare such a fiscal year is the unanswered half of
    // §11.8, so the window is reported as it is — thirteen months, visibly —
    // rather than silently trimmed to something that looks tidier.
    const form = compileMsp2_02({
      lines: LINES,
      period: reportingPeriod(2026, 4),
      entries: [entry('2026-11-30')],
      fiscalYearStart: '2025-12-01',
    });

    expect(form.yearToDateFrom).toBe('2025-12-01');
    expect(form.yearToDateTo).toBe('2026-12-31');
  });

  it('counts into the year-to-date column from the stated start, not from January', () => {
    // The property the window description is claiming. An entry in December
    // 2025 belongs to a December fiscal year's Q4 2026 column and to no
    // calendar-2026 one, so this is the figure that would move if the window
    // were silently normalised.
    const form = compileMsp2_02({
      lines: LINES,
      period: reportingPeriod(2026, 4),
      entries: [entry('2025-12-15', '700000'), entry('2026-11-30', '300000')],
      fiscalYearStart: '2025-12-01',
    });

    const row = form.rows.find((candidate) => candidate.sno === 2);

    expect(row?.quarterAmount.toDatabaseValue()).toBe('300000.00');
    expect(row?.yearToDateAmount.toDatabaseValue()).toBe('1000000.00');
  });
});
