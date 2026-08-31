import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { formatPeriod, periodContaining, periodContains, reportingPeriod } from './period.js';

describe('reportingPeriod', () => {
  it.each([
    [1, '2026-01-01', '2026-03-31'],
    [2, '2026-04-01', '2026-06-30'],
    [3, '2026-07-01', '2026-09-30'],
    [4, '2026-10-01', '2026-12-31'],
  ])('bounds Q%i correctly', (quarter, startDate, endDate) => {
    const period = reportingPeriod(2026, quarter);

    expect(period.startDate).toBe(startDate);
    expect(period.endDate).toBe(endDate);
  });

  it('gets February right in a leap year', () => {
    // Derived from day zero of the following month rather than a table of
    // month lengths, so the leap rule is the calendar's and not ours.
    expect(reportingPeriod(2024, 1).endDate).toBe('2024-03-31');
    expect(reportingPeriod(2024, 1).startDate).toBe('2024-01-01');
  });

  it.each([0, 5, -1, 1.5])('refuses quarter %s', (quarter) => {
    expect(() => reportingPeriod(2026, quarter)).toThrow(DomainValidationError);
  });

  it.each([1999, 0, -2026, 2026.5])('refuses year %s', (year) => {
    expect(() => reportingPeriod(year, 1)).toThrow(DomainValidationError);
  });
});

describe('periodContaining', () => {
  it.each([
    ['2026-01-01', 1],
    ['2026-03-31', 1],
    ['2026-04-01', 2],
    ['2026-09-30', 3],
    ['2026-12-31', 4],
  ])('places %s in Q%i', (date, quarter) => {
    expect(periodContaining(date).quarter).toBe(quarter);
  });

  it('refuses something that is not a calendar date', () => {
    expect(() => periodContaining('not-a-date')).toThrow(DomainValidationError);
  });
});

describe('periodContains', () => {
  const q1 = reportingPeriod(2026, 1);

  it('includes both boundaries', () => {
    // Inclusive at both ends. A payment received on 31 March belongs to Q1, and
    // an exclusive end would drop the busiest day of the quarter.
    expect(periodContains(q1, '2026-01-01')).toBe(true);
    expect(periodContains(q1, '2026-03-31')).toBe(true);
  });

  it('excludes the days either side', () => {
    expect(periodContains(q1, '2025-12-31')).toBe(false);
    expect(periodContains(q1, '2026-04-01')).toBe(false);
  });
});

describe('formatPeriod', () => {
  it('renders a period as BOT names it', () => {
    expect(formatPeriod(reportingPeriod(2026, 3))).toBe('2026-Q3');
  });
});
