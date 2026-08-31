import { describe, expect, it } from 'vitest';

import { RateRangeError } from './errors.js';
import { Percentage } from './percentage.js';
import { Rate } from './rate.js';

describe('Percentage', () => {
  it('holds a percentage the way people write it', () => {
    expect(Percentage.of('5').toString()).toBe('5');
  });

  it('converts to a fraction', () => {
    expect(Percentage.of('5').toFraction().toFixed()).toBe('0.05');
    expect(Percentage.of('100').toFraction().toFixed()).toBe('1');
    expect(Percentage.of('0.5').toFraction().toFixed()).toBe('0.005');
  });

  it('builds from a fraction', () => {
    expect(Percentage.fromFraction('0.05').toString()).toBe('5');
    expect(Percentage.fromFraction('1').toString()).toBe('100');
  });

  it('round-trips through a fraction without loss', () => {
    for (const value of ['5', '12.5', '0.25', '79.585633']) {
      expect(Percentage.fromFraction(Percentage.of(value).toFraction()).toString()).toBe(value);
    }
  });

  it('rounds only when asked', () => {
    expect(Percentage.of('79.585632602212915').toFixed(4)).toBe('79.5856');
    expect(Percentage.of('79.585632602212915').toFixed(2)).toBe('79.59');
  });

  it('reports sign and compares', () => {
    expect(Percentage.zero().isZero()).toBe(true);
    expect(Percentage.of('-1').isNegative()).toBe(true);
    expect(Percentage.of('4').lessThan(Percentage.of('5'))).toBe(true);
    expect(Percentage.of('6').greaterThan(Percentage.of('5'))).toBe(true);
    expect(Percentage.of('5').equals(Percentage.of('5.0'))).toBe(true);
  });

  it('serialises as a string', () => {
    expect(JSON.stringify({ rate: Percentage.of('5') })).toBe('{"rate":"5"}');
  });

  it('refuses a JavaScript number', () => {
    // @ts-expect-error — the type forbids it; this proves the runtime does too.
    expect(() => Percentage.of(5)).toThrow(/never travel as a float/);
  });
});

describe('Rate construction', () => {
  it('holds a monthly fraction', () => {
    expect(Rate.ofMonthlyFraction('0.05').monthlyFraction().toFixed()).toBe('0.05');
  });

  it('builds from a monthly percentage', () => {
    expect(Rate.ofMonthlyPercentage(Percentage.of('5')).monthlyFraction().toFixed()).toBe('0.05');
  });

  it('permits zero, leaving the "no free loans" rule to the loan product', () => {
    expect(Rate.zero().isZero()).toBe(true);
    expect(Rate.ofMonthlyFraction('0').isZero()).toBe(true);
  });

  it('refuses a negative rate', () => {
    expect(() => Rate.ofMonthlyFraction('-0.01')).toThrow(RateRangeError);
  });

  it('refuses more precision than NUMERIC(6,4) stores', () => {
    // Accepting it would mean the value silently changes on write.
    expect(() => Rate.ofMonthlyFraction('0.05125')).toThrow(/decimal places/);
    expect(Rate.ofMonthlyFraction('0.0512').toDatabaseValue()).toBe('0.0512');
  });

  it('refuses a value too large for NUMERIC(6,4)', () => {
    expect(() => Rate.ofMonthlyFraction('100')).toThrow(/too large/);
    expect(() => Rate.ofMonthlyFraction('99.9999')).not.toThrow();
  });

  it('refuses a JavaScript number', () => {
    // @ts-expect-error — the type forbids it; this proves the runtime does too.
    expect(() => Rate.ofMonthlyFraction(0.05)).toThrow(/never travel as a float/);
  });

  it('renders at the stored scale', () => {
    expect(Rate.ofMonthlyFraction('0.05').toDatabaseValue()).toBe('0.0500');
    expect(Rate.ofMonthlyFraction('0.05').toString()).toBe('0.05');
  });
});

describe('Rate annualisation', () => {
  const fivePercentMonthly = Rate.ofMonthlyFraction('0.05');

  it('converts to a monthly percentage', () => {
    expect(fivePercentMonthly.toMonthlyPercentage().toString()).toBe('5');
  });

  it('annualises simply by default', () => {
    // DEFAULT_ANNUALISATION is 'simple'; recorded in 01-ARCHITECTURE.md §16.1
    // as pending confirmation against an accepted BOT filing.
    expect(fivePercentMonthly.toAnnualPercentage().toString()).toBe('60');
  });

  it('annualises simply when asked explicitly', () => {
    expect(fivePercentMonthly.toAnnualPercentage('simple').toString()).toBe('60');
  });

  it('annualises effectively when asked', () => {
    // (1.05^12 − 1) × 100, verified independently: 79.5856326022129150390625
    expect(fivePercentMonthly.toAnnualPercentage('effective').toFixed(6)).toBe('79.585633');
    expect(fivePercentMonthly.toAnnualPercentage('effective').toFixed(4)).toBe('79.5856');
  });

  it('shows why the convention has to be a decision, not an assumption', () => {
    // A 19.6-point spread on the same loan. Reporting the wrong one is a
    // materially wrong regulatory filing, not a rounding quibble.
    const simple = fivePercentMonthly.toAnnualPercentage('simple');
    const effective = fivePercentMonthly.toAnnualPercentage('effective');

    expect(effective.greaterThan(simple)).toBe(true);
    expect(effective.toDecimal().minus(simple.toDecimal()).toFixed(2)).toBe('19.59');
  });

  it('annualises zero to zero under both conventions', () => {
    expect(Rate.zero().toAnnualPercentage('simple').toString()).toBe('0');
    expect(Rate.zero().toAnnualPercentage('effective').toString()).toBe('0');
  });

  it.each([
    ['0.01', '12', '12.682503'],
    ['0.02', '24', '26.824179'],
    ['0.025', '30', '34.488882'],
    ['0.1', '120', '213.842838'],
  ])('annualises %s monthly to %s%% simple and %s%% effective', (monthly, simple, effective) => {
    const rate = Rate.ofMonthlyFraction(monthly);

    expect(rate.toAnnualPercentage('simple').toString()).toBe(simple);
    expect(rate.toAnnualPercentage('effective').toFixed(6)).toBe(effective);
  });
});

describe('Rate comparison', () => {
  it('orders and compares rates', () => {
    const low = Rate.ofMonthlyFraction('0.01');
    const high = Rate.ofMonthlyFraction('0.05');

    expect(low.lessThan(high)).toBe(true);
    expect(high.greaterThan(low)).toBe(true);
    expect(low.equals(Rate.ofMonthlyFraction('0.0100'))).toBe(true);
  });

  it('serialises as a string', () => {
    expect(JSON.stringify({ rate: Rate.ofMonthlyFraction('0.05') })).toBe('{"rate":"0.05"}');
  });
});
