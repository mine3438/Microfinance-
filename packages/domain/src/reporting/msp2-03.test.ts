import { Money, Percentage } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { compileMsp2_03, type ClassifiedExposure, type Msp2_03Request } from './msp2-03.js';

const SECTORS = ['agriculture', 'trade', 'education'];

const exposure = (overrides: Partial<ClassifiedExposure> = {}): ClassifiedExposure => ({
  sectorCode: 'agriculture',
  clientId: 'client-1',
  outstanding: Money.of('1000000'),
  classification: 'current',
  provisionRate: Percentage.of('1'),
  ...overrides,
});

const request = (overrides: Partial<Msp2_03Request> = {}): Msp2_03Request => ({
  sectorCodes: SECTORS,
  exposures: [],
  writeOffs: [],
  collateral: [],
  ...overrides,
});

describe('compileMsp2_03', () => {
  it('produces a row for every published sector, including those with no lending', () => {
    const form = compileMsp2_03(request({ exposures: [exposure()] }));

    // BOT's template has a fixed twenty-two rows and the validator reads by
    // position. An omitted row is not an empty row — it shifts every row
    // beneath it.
    expect(form.rows.map((row) => row.sectorCode)).toEqual(SECTORS);
    expect(form.rows[1]?.totalOutstanding.toDatabaseValue()).toBe('0.00');
  });

  it('places outstanding in the classification bucket the loan was classified into', () => {
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ classification: 'current', outstanding: Money.of('500000') }),
          exposure({
            classification: 'loss',
            outstanding: Money.of('200000'),
            provisionRate: Percentage.of('100'),
            clientId: 'client-2',
          }),
        ],
      }),
    );

    const agriculture = form.rows[0]!;
    expect(agriculture.outstandingByClass.current.toDatabaseValue()).toBe('500000.00');
    expect(agriculture.outstandingByClass.loss.toDatabaseValue()).toBe('200000.00');
    expect(agriculture.totalOutstanding.toDatabaseValue()).toBe('700000.00');
  });

  it('applies each loan’s own provision rate rather than one rate per sector', () => {
    // Current is 1% and Loss is 100%. A sector holding both must provision each
    // at its own rate — 500,000 × 1% + 200,000 × 100% = 205,000.
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({
            classification: 'current',
            outstanding: Money.of('500000'),
            provisionRate: Percentage.of('1'),
          }),
          exposure({
            classification: 'loss',
            outstanding: Money.of('200000'),
            provisionRate: Percentage.of('100'),
            clientId: 'client-2',
          }),
        ],
      }),
    );

    expect(form.rows[0]?.grossProvision.toDatabaseValue()).toBe('205000.00');
  });

  it('counts borrowers, not loans', () => {
    // BOT ties this count to MSP2-04's. One borrower with three loans is one
    // borrower, and counting loans would break the cross-form rule.
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ clientId: 'client-1' }),
          exposure({ clientId: 'client-1' }),
          exposure({ clientId: 'client-2' }),
        ],
      }),
    );

    expect(form.rows[0]?.borrowerCount).toBe(2);
  });

  it('deducts collateral from the gross provision', () => {
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({
            classification: 'loss',
            outstanding: Money.of('1000000'),
            provisionRate: Percentage.of('100'),
          }),
        ],
        collateral: [{ sectorCode: 'agriculture', amount: Money.of('300000') }],
      }),
    );

    expect(form.rows[0]?.grossProvision.toDatabaseValue()).toBe('1000000.00');
    expect(form.rows[0]?.netProvision.toDatabaseValue()).toBe('700000.00');
    expect(form.rows[0]?.netAmount.toDatabaseValue()).toBe('300000.00');
  });

  it('floors the net provision at zero rather than letting it go negative', () => {
    // Collateral above the provision reduces it to nothing. A negative
    // provision would *add* to the loan book on MSP2-01, which is the opposite
    // of what holding security means.
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ outstanding: Money.of('100000'), provisionRate: Percentage.of('1') }),
        ],
        collateral: [{ sectorCode: 'agriculture', amount: Money.of('999999') }],
      }),
    );

    expect(form.rows[0]?.netProvision.toDatabaseValue()).toBe('0.00');
  });

  it('carries write-offs as a movement, separate from the balances', () => {
    const form = compileMsp2_03(
      request({
        exposures: [exposure()],
        writeOffs: [{ sectorCode: 'trade', amount: Money.of('45000') }],
      }),
    );

    expect(form.rows[1]?.writtenOffDuringPeriod.toDatabaseValue()).toBe('45000.00');
    // A write-off during the quarter does not appear in the outstanding
    // balance as at the quarter end — the loan is gone from the book.
    expect(form.rows[1]?.totalOutstanding.toDatabaseValue()).toBe('0.00');
  });

  it('computes the non-performing ratio from the three non-performing classes', () => {
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ classification: 'current', outstanding: Money.of('600000') }),
          exposure({
            classification: 'substandard',
            outstanding: Money.of('200000'),
            provisionRate: Percentage.of('25'),
            clientId: 'c2',
          }),
          exposure({
            classification: 'doubtful',
            outstanding: Money.of('100000'),
            provisionRate: Percentage.of('50'),
            clientId: 'c3',
          }),
          exposure({
            classification: 'loss',
            outstanding: Money.of('100000'),
            provisionRate: Percentage.of('100'),
            clientId: 'c4',
          }),
        ],
      }),
    );

    // (200,000 + 100,000 + 100,000) ÷ 1,000,000 × 100 = 40%.
    expect(form.nonPerformingRatio.toFixed(2)).toBe('40.00');
  });

  it('reports a nought ratio for an empty book rather than dividing by zero', () => {
    expect(compileMsp2_03(request()).nonPerformingRatio.toFixed(2)).toBe('0.00');
  });

  it('counts an unclassifiable loan and places it in no bucket', () => {
    // BOT's housing schedule begins at 91 days and defines nothing below it, so
    // a housing loan less overdue has no classification BOT has given. There is
    // no unclassified column, so folding it into `current` would understate the
    // provision on a signed return.
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ outstanding: Money.of('400000') }),
          exposure({
            clientId: 'housing-borrower',
            outstanding: Money.of('900000'),
            classification: null,
            provisionRate: null,
          }),
        ],
      }),
    );

    expect(form.unclassifiableLoanCount).toBe(1);
    expect(form.rows[0]?.totalOutstanding.toDatabaseValue()).toBe('400000.00');
    // And it is not silently counted as a borrower either.
    expect(form.rows[0]?.borrowerCount).toBe(1);
  });

  it('totals every column across the sectors', () => {
    const form = compileMsp2_03(
      request({
        exposures: [
          exposure({ sectorCode: 'agriculture', outstanding: Money.of('300000') }),
          exposure({ sectorCode: 'trade', outstanding: Money.of('700000'), clientId: 'c2' }),
        ],
      }),
    );

    expect(form.total.totalOutstanding.toDatabaseValue()).toBe('1000000.00');
    expect(form.total.borrowerCount).toBe(2);
  });

  it('refuses an exposure in a sector BOT does not publish', () => {
    // The loan book and the taxonomy have diverged. Dropping the exposure would
    // under-report the portfolio to the regulator.
    expect(() =>
      compileMsp2_03(request({ exposures: [exposure({ sectorCode: 'invented' })] })),
    ).toThrow(/not one BOT publishes/);
  });

  it('refuses to compile without the taxonomy', () => {
    expect(() => compileMsp2_03(request({ sectorCodes: [] }))).toThrow(DomainValidationError);
  });
});
