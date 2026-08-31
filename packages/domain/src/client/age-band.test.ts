import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  AGE_BAND_LABELS,
  AGE_BAND_THRESHOLD_YEARS,
  ageBandAt,
  completedYearsBetween,
} from './age-band.js';
import { parseGender } from './gender.js';

const date = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

describe('completed years', () => {
  it('counts a birthday that has passed this year', () => {
    expect(completedYearsBetween(date('1990-03-15'), date('2026-08-07'))).toBe(36);
  });

  it('does not count a birthday still to come this year', () => {
    expect(completedYearsBetween(date('1990-12-15'), date('2026-08-07'))).toBe(35);
  });

  it('counts the birthday itself', () => {
    expect(completedYearsBetween(date('1991-08-07'), date('2026-08-07'))).toBe(35);
  });

  it('does not count the day before the birthday', () => {
    expect(completedYearsBetween(date('1991-08-07'), date('2026-08-06'))).toBe(34);
  });

  it('handles a leap-day birth correctly in a non-leap year', () => {
    // Elapsed-milliseconds arithmetic divided by 365.25 gets this wrong, and
    // being wrong by a day either side of a birthday is enough to move a
    // borrower between bands on a quarter boundary.
    expect(completedYearsBetween(date('2000-02-29'), date('2026-02-28'))).toBe(25);
    expect(completedYearsBetween(date('2000-02-29'), date('2026-03-01'))).toBe(26);
  });

  it('returns zero for someone born today', () => {
    expect(completedYearsBetween(date('2026-08-07'), date('2026-08-07'))).toBe(0);
  });
});

describe('MSP2-10 age bands', () => {
  it('places someone under 35 in the lower band', () => {
    expect(ageBandAt(date('2000-01-01'), date('2026-08-07'))).toBe('up_to_35');
  });

  it('places someone over 35 in the upper band', () => {
    expect(ageBandAt(date('1980-01-01'), date('2026-08-07'))).toBe('above_35');
  });

  it('places exactly 35 in the lower band, matching BOT’s wording', () => {
    // The column reads "Up to 35 Years", which includes 35.
    expect(ageBandAt(date('1991-08-07'), date('2026-08-07'))).toBe('up_to_35');
  });

  it('moves to the upper band the day after turning 36', () => {
    expect(ageBandAt(date('1990-08-07'), date('2026-08-07'))).toBe('above_35');
  });

  it('uses the threshold the constant declares', () => {
    const thirtyFifthBirthday = date('2026-08-07');
    const bornThen = date(`${String(2026 - AGE_BAND_THRESHOLD_YEARS)}-08-07`);

    expect(ageBandAt(bornThen, thirtyFifthBirthday)).toBe('up_to_35');
  });

  it('rejects a reference date before the birth date', () => {
    expect(() => ageBandAt(date('2000-01-01'), date('1999-01-01'))).toThrow(DomainValidationError);
  });

  it('labels the bands as BOT’s column headers word them', () => {
    expect(AGE_BAND_LABELS.up_to_35).toBe('Up to 35 Years');
    expect(AGE_BAND_LABELS.above_35).toBe('Above 35 Years');
  });
});

describe('the reference date is the caller’s choice', () => {
  it('can place the same borrower in either band depending on the date used', () => {
    // This is the open question in 02-BOT-REPORTING-SPEC.md §11.4 made concrete.
    // BOT's template does not say whether age is taken at disbursement or as at
    // quarter end, and for anyone who crosses 35 during the life of a loan the
    // two produce different returns. The function requires the date rather than
    // choosing one silently, so the decision is visible at every call site.
    const dateOfBirth = date('1990-06-01');
    const atDisbursement = date('2025-01-15');
    const atQuarterEnd = date('2026-12-31');

    expect(ageBandAt(dateOfBirth, atDisbursement)).toBe('up_to_35');
    expect(ageBandAt(dateOfBirth, atQuarterEnd)).toBe('above_35');
  });
});

describe('the reporting cross-tabulation', () => {
  it('produces the four buckets MSP2-10 crosses age with gender into', () => {
    const borrowers = [
      { dateOfBirth: date('2000-01-01'), gender: 'female' },
      { dateOfBirth: date('2000-01-01'), gender: 'male' },
      { dateOfBirth: date('1970-01-01'), gender: 'female' },
      { dateOfBirth: date('1970-01-01'), gender: 'male' },
    ];
    const asAt = date('2026-12-31');

    const buckets = borrowers.map(
      (borrower) => `${ageBandAt(borrower.dateOfBirth, asAt)}:${parseGender(borrower.gender)}`,
    );

    expect(new Set(buckets)).toEqual(
      new Set(['up_to_35:female', 'up_to_35:male', 'above_35:female', 'above_35:male']),
    );
  });
});
