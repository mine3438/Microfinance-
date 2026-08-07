import { describe, expect, it } from 'vitest';

import { Money } from './money.js';
import { Percentage } from './percentage.js';
import { Rate } from './rate.js';

/**
 * Fixed vectors, checked by hand against an independent decimal implementation
 * rather than against this code.
 *
 * A test that asserts whatever the implementation currently produces locks in
 * bugs as thoroughly as it locks in correctness. Every expected value here was
 * computed separately, and the BOT-derived ones trace to
 * `02-BOT-REPORTING-SPEC.md`, which was read from BOT's own template.
 */

describe('why exact decimals, demonstrated', () => {
  it('binary floating point cannot add tenths', () => {
    expect(0.1 + 0.2).toBe(0.30000000000000004);
    expect(Money.of('0.10').plus(Money.of('0.20')).toDatabaseValue()).toBe('0.30');
  });

  it('binary floating point cannot represent 2.675, so it rounds down', () => {
    expect((2.675).toFixed(2)).toBe('2.67');
    expect(Money.round('2.675').toDatabaseValue()).toBe('2.68');
  });

  it('binary floating point drifts over a repayment schedule', () => {
    // Twelve instalments of 833.33 plus a 0.04 residual, as a schedule would run.
    let floatTotal = 0;
    for (let index = 0; index < 12; index += 1) {
      floatTotal += 833.33;
    }
    expect(floatTotal).not.toBe(9999.96);

    let exactTotal = Money.zero();
    for (let index = 0; index < 12; index += 1) {
      exactTotal = exactTotal.plus(Money.of('833.33'));
    }
    expect(exactTotal.toDatabaseValue()).toBe('9999.96');
  });

  it('binary floating point loses shillings on a large portfolio', () => {
    // A thousand loans of 1,234,567.89 — a plausible Tier II book.
    let floatTotal = 0;
    for (let index = 0; index < 1000; index += 1) {
      floatTotal += 1_234_567.89;
    }
    expect(floatTotal).not.toBe(1_234_567_890);

    const exactTotal = Money.sum(Array.from({ length: 1000 }, () => Money.of('1234567.89')));
    expect(exactTotal.toDatabaseValue()).toBe('1234567890.00');
  });
});

describe('BOT provisioning rates (02-BOT-REPORTING-SPEC.md §4.1)', () => {
  const outstanding = Money.of('1234567.89');

  it.each([
    ['Current', '0-5 days', '1', '12345.68'],
    ['ESM', '6-30 days', '5', '61728.39'],
    ['Substandard', '31-60 days', '25', '308641.97'],
    ['Doubtful', '61-90 days', '50', '617283.95'],
    ['Loss', 'over 90 days', '100', '1234567.89'],
  ])('%s (%s) provisions at %s%%', (_class, _band, rate, expected) => {
    expect(outstanding.applyPercentage(Percentage.of(rate)).toDatabaseValue()).toBe(expected);
  });

  it('applies the separate housing microfinance schedule', () => {
    // Housing loans classify on a longer scale: 91-180 at 25%, 181-360 at 50%,
    // beyond 360 at 100%. A 100-days-overdue housing loan provisions at 25%,
    // where any other loan at 100 days provisions at 100%.
    const housingAt100Days = outstanding.applyPercentage(Percentage.of('25'));
    const standardAt100Days = outstanding.applyPercentage(Percentage.of('100'));

    expect(housingAt100Days.toDatabaseValue()).toBe('308641.97');
    expect(standardAt100Days.toDatabaseValue()).toBe('1234567.89');
    expect(housingAt100Days.lessThan(standardAt100Days)).toBe(true);
  });

  it('nets provisions against collateral, as MSP2-03 line 70 requires', () => {
    const provision = outstanding.applyPercentage(Percentage.of('50'));
    const compulsorySavings = Money.of('100000.00');

    expect(provision.minus(compulsorySavings).toDatabaseValue()).toBe('517283.95');
  });
});

describe('BOT prudential ratios', () => {
  it('computes the MSP2-05 five percent minimum liquid asset requirement', () => {
    const totalAssets = Money.of('850000000.00');
    const required = totalAssets.applyPercentage(Percentage.of('5'));

    expect(required.toDatabaseValue()).toBe('42500000.00');
  });

  it('identifies a liquid asset deficiency', () => {
    const totalAssets = Money.of('850000000.00');
    const available = Money.of('30000000.00');
    const required = totalAssets.applyPercentage(Percentage.of('5'));

    expect(available.minus(required).toDatabaseValue()).toBe('-12500000.00');
    expect(available.lessThan(required)).toBe(true);
  });

  it('computes the MSP2-03 non-performing loan ratio', () => {
    // NPL = (Substandard + Doubtful + Loss) / Total Outstanding × 100.
    const substandard = Money.of('12000000.00');
    const doubtful = Money.of('8000000.00');
    const loss = Money.of('5000000.00');
    const total = Money.of('250000000.00');

    const nonPerforming = Money.sum([substandard, doubtful, loss]);
    const ratio = Percentage.fromFraction(nonPerforming.dividedByExact(total.toDatabaseValue()));

    expect(nonPerforming.toDatabaseValue()).toBe('25000000.00');
    expect(ratio.toFixed(2)).toBe('10.00');
  });
});

describe('interest vectors', () => {
  it('computes flat-rate interest for one period', () => {
    // Flat: interest = principal × monthly rate, constant every period.
    const principal = Money.of('1000000.00');
    const rate = Rate.ofMonthlyFraction('0.05');

    expect(principal.applyRate(rate).toDatabaseValue()).toBe('50000.00');
  });

  it('keeps a flat-rate schedule summing exactly to the total interest', () => {
    const principal = Money.of('1000000.00');
    const rate = Rate.ofMonthlyFraction('0.025');
    const term = 7;

    const perPeriod = principal.applyRate(rate);
    const total = Money.sum(Array.from({ length: term }, () => perPeriod));

    expect(perPeriod.toDatabaseValue()).toBe('25000.00');
    expect(total.toDatabaseValue()).toBe('175000.00');
  });

  it('splits a principal into a schedule that closes at exactly zero', () => {
    // The property that matters: a loan must not finish owing a stray shilling.
    const principal = Money.of('1000000.00');
    const instalments = principal.distribute(7);

    expect(Money.sum(instalments).toDatabaseValue()).toBe('1000000.00');
    expect(principal.minus(Money.sum(instalments)).isZero()).toBe(true);
    expect(instalments[0]?.toDatabaseValue()).toBe('142857.15');
    expect(instalments[6]?.toDatabaseValue()).toBe('142857.14');
  });

  it('computes reducing-balance interest that falls each period', () => {
    const rate = Rate.ofMonthlyFraction('0.03');
    let balance = Money.of('500000.00');

    const first = balance.applyRate(rate);
    balance = balance.minus(Money.of('100000.00'));
    const second = balance.applyRate(rate);

    expect(first.toDatabaseValue()).toBe('15000.00');
    expect(second.toDatabaseValue()).toBe('12000.00');
    expect(second.lessThan(first)).toBe(true);
  });
});

describe('NUMERIC(15,2) boundaries', () => {
  it('holds the largest storable value', () => {
    expect(Money.of('9999999999999.99').toDatabaseValue()).toBe('9999999999999.99');
  });

  it('holds the smallest non-zero value', () => {
    expect(Money.of('0.01').toDatabaseValue()).toBe('0.01');
  });

  it('holds the largest negative value', () => {
    expect(Money.of('-9999999999999.99').toDatabaseValue()).toBe('-9999999999999.99');
  });

  it('renders every magnitude without exponential notation', () => {
    for (const value of ['0.01', '1', '1000000', '9999999999999.99']) {
      expect(Money.of(value).toDatabaseValue()).not.toMatch(/e/i);
    }
  });
});
