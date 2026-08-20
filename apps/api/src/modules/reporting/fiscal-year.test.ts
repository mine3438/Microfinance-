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
  it('treats a mid-quarter start month by the quarter it falls in', () => {
    // April, May and June are all in Q2. A fiscal year starting in May means
    // Q2 2026 (April–June) begins after 1 May 2025 and before 1 May 2026, so
    // it belongs to the year that began in May 2025.
    expect(fiscalYearStartFor(period(2026, 2), 5)).toBe('2025-05-01');
    expect(fiscalYearStartFor(period(2026, 3), 5)).toBe('2026-05-01');
  });

  it('handles a December start, where only Q4 is in the current year', () => {
    expect(fiscalYearStartFor(period(2026, 1), 12)).toBe('2025-12-01');
    expect(fiscalYearStartFor(period(2026, 3), 12)).toBe('2025-12-01');
    expect(fiscalYearStartFor(period(2026, 4), 12)).toBe('2026-12-01');
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
    // move it. Stated as a test because "check the leap years" is the kind of
    // requirement that gets answered with a shrug otherwise.
    expect(fiscalYearStartFor(period(2024, 1), 2)).toBe('2024-02-01');
    expect(fiscalYearStartFor(period(2023, 1), 2)).toBe('2023-02-01');
  });
});
