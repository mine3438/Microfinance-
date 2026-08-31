import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { compileMsp2_10, type GeographicExposure } from './msp2-10.js';

const DISTRICTS = [
  { code: 'ARU-CC', regionCode: 'ARUSHA' },
  { code: 'ARU-DC', regionCode: 'ARUSHA' },
  { code: 'DSM-IL', regionCode: 'DAR' },
];

const AS_AT = new Date('2026-03-31T00:00:00Z');

const exposure = (overrides: Partial<GeographicExposure> = {}): GeographicExposure => ({
  districtCode: 'ARU-CC',
  clientId: 'client-1',
  dateOfBirth: '1995-01-01',
  gender: 'female',
  loanCount: 1,
  outstanding: Money.of('400000'),
  ...overrides,
});

describe('compileMsp2_10', () => {
  it('places a borrower in the age band as at the reporting date', () => {
    // Born 1995, measured at March 2026: 31 years old.
    const form = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [exposure({ dateOfBirth: '1995-01-01' })],
      presence: [],
      asAt: AS_AT,
    });

    expect(form.districts[0]?.cells.up_to_35_female.borrowerCount).toBe(1);
    expect(form.districts[0]?.cells.above_35_female.borrowerCount).toBe(0);
  });

  it('moves a borrower between bands on the reference date, which is why it is required', () => {
    // Born 31 March 1990: exactly 36 at the quarter end, 35 the day before.
    // §11.4 asks whether BOT wants the band at disbursement or at reporting;
    // a default would answer that silently in every return filed.
    const born = '1990-03-31';

    const atQuarterEnd = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [exposure({ dateOfBirth: born })],
      presence: [],
      asAt: new Date('2026-03-31T00:00:00Z'),
    });
    const aYearEarlier = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [exposure({ dateOfBirth: born })],
      presence: [],
      asAt: new Date('2025-03-31T00:00:00Z'),
    });

    expect(atQuarterEnd.districts[0]?.cells.above_35_female.borrowerCount).toBe(1);
    expect(aYearEarlier.districts[0]?.cells.up_to_35_female.borrowerCount).toBe(1);
  });

  it('splits by age band and gender into twelve measure columns', () => {
    const form = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [
        exposure({ dateOfBirth: '2000-01-01', gender: 'female', outstanding: Money.of('100000') }),
        exposure({
          dateOfBirth: '1970-01-01',
          gender: 'male',
          clientId: 'c2',
          outstanding: Money.of('200000'),
          loanCount: 3,
        }),
      ],
      presence: [],
      asAt: AS_AT,
    });

    const row = form.districts[0]!;
    expect(row.cells.up_to_35_female.outstanding.toDatabaseValue()).toBe('100000.00');
    expect(row.cells.above_35_male.loanCount).toBe(3);
    expect(row.totalBorrowers).toBe(2);
    expect(row.totalOutstanding.toDatabaseValue()).toBe('300000.00');
  });

  it('carries branch and employee presence per district', () => {
    // Reporting branches per district is impossible without modelling
    // branches, which PRD §4.2 had put out of scope. The form requires it.
    const form = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [],
      presence: [
        {
          districtCode: 'ARU-CC',
          branchCount: 2,
          employeeCount: 11,
          compulsorySavings: Money.of('750000'),
        },
      ],
      asAt: AS_AT,
    });

    expect(form.districts[0]?.branchCount).toBe(2);
    expect(form.districts[0]?.employeeCount).toBe(11);
    expect(form.districts[0]?.compulsorySavings.toDatabaseValue()).toBe('750000.00');
  });

  it('subtotals by region and sums to a grand total', () => {
    const form = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [
        exposure({ districtCode: 'ARU-CC', outstanding: Money.of('100000') }),
        exposure({ districtCode: 'ARU-DC', outstanding: Money.of('200000'), clientId: 'c2' }),
        exposure({ districtCode: 'DSM-IL', outstanding: Money.of('700000'), clientId: 'c3' }),
      ],
      presence: [],
      asAt: AS_AT,
    });

    const arusha = form.regions.find((region) => region.regionCode === 'ARUSHA');
    expect(arusha?.totalOutstanding.toDatabaseValue()).toBe('300000.00');
    expect(form.grandTotal.totalOutstanding.toDatabaseValue()).toBe('1000000.00');
    expect(form.grandTotal.totalBorrowers).toBe(3);
  });

  it('produces a row for every published district', () => {
    const form = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [],
      presence: [],
      asAt: AS_AT,
    });

    expect(form.districts.map((row) => row.districtCode)).toEqual(DISTRICTS.map((d) => d.code));
  });

  it('refuses a district BOT does not publish', () => {
    expect(() =>
      compileMsp2_10({
        districts: DISTRICTS,
        exposures: [exposure({ districtCode: 'invented' })],
        presence: [],
        asAt: AS_AT,
      }),
    ).toThrow(/not one BOT publishes/);
  });
});
