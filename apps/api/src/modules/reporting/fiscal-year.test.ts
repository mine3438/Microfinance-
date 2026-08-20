import { describe, expect, it } from 'vitest';

import { reportingPeriod } from '@mfi/domain';

import { fiscalYearStartFor } from './use-cases.js';

/**
 * Which fiscal year a quarter belongs to.
 *
 * §11.8 does not say whether BOT reads MSP2-02's year-to-date column as the
 * calendar year or the institution's own. That is why the start month is a
 * parameter rather than a constant, why January is a *stated* default rather
 * than an assumption buried in the compiler, and why the window actually used
 * comes back on the compiled form.
 *
 * These tests pin the derivation so the parameter cannot quietly stop
 * mattering. A regression here does not throw — it silently files a return
 * whose year-to-date column covers the wrong nine months.
 */

const period = reportingPeriod;

describe('a calendar fiscal year', () => {
  it.each([
    [1, '2026-01-01'],
    [2, '2026-01-01'],
    [3, '2026-01-01'],
    [4, '2026-01-01'],
  ])('puts Q%i in the year that began in January', (quarter, expected) => {
    expect(fiscalYearStartFor(period(2026, quarter), 1)).toBe(expected);
  });
});

describe('a July fiscal year', () => {
  it.each([
    // Q1 and Q2 of 2026 fall *before* July 2026, so they belong to the year
    // that began in July 2025. Getting this backwards is the whole risk: it
    // would report six months of the wrong year as year-to-date.
    [1, '2025-07-01'],
    [2, '2025-07-01'],
    [3, '2026-07-01'],
    [4, '2026-07-01'],
  ])('puts Q%i in the year beginning %s', (quarter, expected) => {
    expect(fiscalYearStartFor(period(2026, quarter), 7)).toBe(expected);
  });

  it('changes year exactly at the quarter containing the start month', () => {
    // July is the first month of Q3, so Q3 is the first quarter of the new
    // fiscal year and Q2 is the last of the old one. The boundary is inclusive
    // at the start.
    expect(fiscalYearStartFor(period(2026, 2), 7)).toBe('2025-07-01');
    expect(fiscalYearStartFor(period(2026, 3), 7)).toBe('2026-07-01');
  });
});

describe('start months that do not begin a quarter', () => {
  /**
   * The rule, stated by `fiscalYearStartFor` itself: the most recent occurrence
   * of the start month on or before **the first month of the quarter**. So a
   * quarter is placed by where it starts, not by where it ends.
   */
  it('places a quarter by its first month', () => {
    // Q2 2026 is April–June. A May fiscal year: the most recent 1 May on or
    // before 1 April 2026 is 1 May 2025.
    expect(fiscalYearStartFor(period(2026, 2), 5)).toBe('2025-05-01');
    // Q3 2026 is July–September, which starts after 1 May 2026.
    expect(fiscalYearStartFor(period(2026, 3), 5)).toBe('2026-05-01');
  });

  it('places every quarter of a December fiscal year by its first month', () => {
    // Q4 2026 starts in October, and the most recent 1 December on or before
    // October 2026 is 1 December 2025 — even though the quarter itself runs
    // into December 2026. See the straddle test below.
    expect(fiscalYearStartFor(period(2026, 1), 12)).toBe('2025-12-01');
    expect(fiscalYearStartFor(period(2026, 3), 12)).toBe('2025-12-01');
    expect(fiscalYearStartFor(period(2026, 4), 12)).toBe('2025-12-01');
  });

  it('produces a window longer than a year when the start month straddles a quarter', () => {
    // Recorded rather than corrected. A fiscal year that does not begin on a
    // quarter boundary makes some quarter span the boundary, and this rule then
    // yields a year-to-date window of more than twelve months: for Q4 2026 with
    // a December start, 2025-12-01 through 2026-12-31 — thirteen months.
    //
    // Whether an institution may even declare such a fiscal year is part of
    // §11.8, which is unanswered, so the behaviour is left exactly as it is and
    // pinned here. Changing it would mean choosing a rule for non-aligned
    // fiscal years that nobody has stated. The window used is reported on the
    // compiled form as `yearToDateFrom`, so it is visible rather than implied.
    const start = fiscalYearStartFor(period(2026, 4), 12);
    const quarterEnd = period(2026, 4).endDate;

    expect(start).toBe('2025-12-01');
    expect(quarterEnd).toBe('2026-12-31');

    // A quarter-aligned start month cannot do this: every quarter sits wholly
    // inside one fiscal year.
    for (const aligned of [1, 4, 7, 10]) {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        const from = fiscalYearStartFor(period(2026, quarter), aligned);
        const to = period(2026, quarter).endDate;
        const months =
          (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
          (Number(to.slice(5, 7)) - Number(from.slice(5, 7))) +
          1;
        expect(months).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('the date it produces', () => {
  it('is always the first of a month, so no quarter is half-counted', () => {
    for (let month = 1; month <= 12; month += 1) {
      for (let quarter = 1; quarter <= 4; quarter += 1) {
        expect(fiscalYearStartFor(period(2026, quarter), month)).toMatch(/^\d{4}-\d{2}-01$/);
      }
    }
  });

  it('pads the month, so string comparison against a date column is correct', () => {
    // `compileMsp2_02` filters entries with `entryDate >= fiscalYearStart` as
    // strings. `2026-7-01` would sort after `2026-10-01`, silently excluding a
    // quarter of the year.
    expect(fiscalYearStartFor(period(2026, 3), 7)).toBe('2026-07-01');
    expect(fiscalYearStartFor(period(2026, 3), 7) < '2026-10-01').toBe(true);
  });

  it('is unaffected by a leap year, because it never names 29 February', () => {
    // The start is always the first of a month, so February's length cannot
    // move it, in a leap year or out of one. Q1 starts in January, which
    // precedes 1 February, so both land on the previous year's February.
    expect(fiscalYearStartFor(period(2024, 1), 2)).toBe('2023-02-01');
    expect(fiscalYearStartFor(period(2023, 1), 2)).toBe('2022-02-01');

    // And the quarter that begins on the boundary lands on its own year, leap
    // or not — 2024 is a leap year, 2023 is not, and the answers have the same
    // shape.
    expect(fiscalYearStartFor(period(2024, 2), 2)).toBe('2024-02-01');
    expect(fiscalYearStartFor(period(2023, 2), 2)).toBe('2023-02-01');
  });
});
