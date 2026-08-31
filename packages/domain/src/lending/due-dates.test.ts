import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { addMonthsFromAnchor, monthlyDueDates } from './due-dates.js';

const utc = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date): string => date.toISOString().slice(0, 10);

describe('adding months', () => {
  it('keeps the day of month where it exists', () => {
    expect(iso(addMonthsFromAnchor(utc('2026-01-15'), 1))).toBe('2026-02-15');
  });

  it('clamps to the end of a shorter month rather than rolling over', () => {
    // Naive addition turns 31 January into 3 March, putting the instalment in
    // the wrong month and, at a quarter boundary, in the wrong BOT return.
    expect(iso(addMonthsFromAnchor(utc('2026-01-31'), 1))).toBe('2026-02-28');
  });

  it('clamps to 29 February in a leap year', () => {
    expect(iso(addMonthsFromAnchor(utc('2028-01-31'), 1))).toBe('2028-02-29');
  });

  it('crosses a year boundary', () => {
    expect(iso(addMonthsFromAnchor(utc('2026-11-30'), 3))).toBe('2027-02-28');
  });

  it('handles a whole year', () => {
    expect(iso(addMonthsFromAnchor(utc('2026-06-15'), 12))).toBe('2027-06-15');
  });

  it('rejects a fractional number of months', () => {
    expect(() => addMonthsFromAnchor(utc('2026-01-15'), 1.5)).toThrow(DomainValidationError);
  });
});

describe('monthly due dates', () => {
  it('starts one month after disbursement', () => {
    const dates = monthlyDueDates(utc('2026-01-15'), 3);

    expect(dates.map(iso)).toEqual(['2026-02-15', '2026-03-15', '2026-04-15']);
  });

  it('produces one date per instalment', () => {
    expect(monthlyDueDates(utc('2026-01-15'), 24)).toHaveLength(24);
  });

  it('recovers the anchor day after a clamped month, rather than drifting', () => {
    // Every date is computed from the original anchor. Stepping from the
    // previous due date instead would clamp 31 January to 28 February and then
    // carry 28 forward for the life of the loan, moving every remaining
    // instalment three days earlier.
    const dates = monthlyDueDates(utc('2026-01-31'), 4);

    expect(dates.map(iso)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']);
  });

  it('returns nothing for a zero-length term', () => {
    expect(monthlyDueDates(utc('2026-01-15'), 0)).toEqual([]);
  });
});
