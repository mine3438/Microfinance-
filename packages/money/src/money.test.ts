import { describe, expect, it } from 'vitest';

import { TZS, type Currency } from './currency.js';
import { Dec, ROUND_DOWN } from './decimal.js';
import { CurrencyMismatchError, PrecisionError } from './errors.js';
import { Money } from './money.js';
import { Percentage } from './percentage.js';
import { Rate } from './rate.js';

/** A second currency, used only to prove mixing is refused. */
const USD: Currency = Object.freeze({ code: 'USD', scale: 2 });

describe('Money.of', () => {
  it('accepts a value already at the currency scale', () => {
    expect(Money.of('1234.56').toDatabaseValue()).toBe('1234.56');
  });

  it('accepts fewer decimal places and pads on output', () => {
    expect(Money.of('1234').toDatabaseValue()).toBe('1234.00');
    expect(Money.of('1234.5').toDatabaseValue()).toBe('1234.50');
  });

  it('refuses excess precision rather than rounding silently', () => {
    // Rounding has a monetary consequence, so it must be written out.
    expect(() => Money.of('1234.567')).toThrow(PrecisionError);
  });

  it('refuses a JavaScript number', () => {
    // @ts-expect-error — the type forbids it; this proves the runtime does too.
    expect(() => Money.of(1234.56)).toThrow(/never travel as a float/);
  });

  it('accepts negative amounts, which reversals and adjustments need', () => {
    expect(Money.of('-500.25').toDatabaseValue()).toBe('-500.25');
  });

  it('handles the largest value NUMERIC(15,2) can store', () => {
    expect(Money.of('9999999999999.99').toDatabaseValue()).toBe('9999999999999.99');
  });
});

describe('Money.round', () => {
  it('rounds half up by default', () => {
    expect(Money.round('1.005').toDatabaseValue()).toBe('1.01');
    expect(Money.round('1.004').toDatabaseValue()).toBe('1.00');
  });

  it('rounds half away from zero for negatives', () => {
    expect(Money.round('-1.005').toDatabaseValue()).toBe('-1.01');
  });

  it('honours an explicit rounding mode', () => {
    expect(Money.round('1.999', TZS, ROUND_DOWN).toDatabaseValue()).toBe('1.99');
  });

  it('rounds a value that a float could not represent correctly', () => {
    // As a double, 2.675 is 2.67499999999999982236431605997495353221893310546875,
    // so float arithmetic rounds it to 2.67. Exact decimal gives 2.68.
    expect(Money.round('2.675').toDatabaseValue()).toBe('2.68');
    expect(Number((2.675).toFixed(2))).toBe(2.67);
  });
});

describe('Money.fromDatabaseValue', () => {
  it('reads the string form Postgres returns for NUMERIC', () => {
    expect(Money.fromDatabaseValue('1234.56').toDatabaseValue()).toBe('1234.56');
  });

  it('throws when handed a number, catching a misconfigured driver at first read', () => {
    // The failure this guards: a driver told to parse NUMERIC with parseFloat
    // turns every balance in the system into a double, silently.
    expect(() => Money.fromDatabaseValue(1234.56)).toThrow(/never travel as a float/);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('throws on %s rather than assuming zero', (_label, value) => {
    expect(() => Money.fromDatabaseValue(value)).toThrow(/null or undefined/);
  });

  it('throws on other unexpected driver types', () => {
    expect(() => Money.fromDatabaseValue({ toString: () => '1.00' })).toThrow(/expected a string/);
  });
});

describe('Money arithmetic', () => {
  it('adds without binary floating-point error', () => {
    // The canonical demonstration: as doubles this is 0.30000000000000004.
    expect(Money.of('0.10').plus(Money.of('0.20')).toDatabaseValue()).toBe('0.30');
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it('subtracts exactly', () => {
    expect(Money.of('1000000.00').minus(Money.of('999999.99')).toDatabaseValue()).toBe('0.01');
  });

  it('accumulates a hundred additions without drift', () => {
    let total = Money.zero();
    for (let index = 0; index < 100; index += 1) {
      total = total.plus(Money.of('0.01'));
    }
    expect(total.toDatabaseValue()).toBe('1.00');
  });

  it('negates and takes absolute value', () => {
    expect(Money.of('50.00').negated().toDatabaseValue()).toBe('-50.00');
    expect(Money.of('-50.00').abs().toDatabaseValue()).toBe('50.00');
  });

  it('multiplies and rounds to scale', () => {
    expect(Money.of('1000000.00').times('0.05').toDatabaseValue()).toBe('50000.00');
    expect(Money.of('100.00').times('0.333').toDatabaseValue()).toBe('33.30');
  });

  it('multiplies exactly when asked, for intermediate steps', () => {
    expect(Money.of('100.00').timesExact('0.3333').toFixed()).toBe('33.33');
    expect(Money.of('1.00').timesExact('0.123456789').toFixed()).toBe('0.123456789');
  });

  it('divides and rounds to scale', () => {
    expect(Money.of('100.00').dividedBy('3').toDatabaseValue()).toBe('33.33');
  });

  it('refuses division by zero', () => {
    expect(() => Money.of('100.00').dividedBy('0')).toThrow(RangeError);
    expect(() => Money.of('100.00').dividedByExact('0')).toThrow(RangeError);
  });

  it('refuses to mix currencies', () => {
    expect(() => Money.of('10.00', TZS).plus(Money.of('10.00', USD))).toThrow(
      CurrencyMismatchError,
    );
  });
});

describe('Money and rates', () => {
  it('computes one period of interest', () => {
    const principal = Money.of('1000000.00');
    const rate = Rate.ofMonthlyFraction('0.05');

    expect(principal.applyRate(rate).toDatabaseValue()).toBe('50000.00');
  });

  it('computes interest exactly for intermediate use', () => {
    const principal = Money.of('333333.33');
    const rate = Rate.ofMonthlyFraction('0.0125');

    expect(principal.applyRateExact(rate).toFixed()).toBe('4166.666625');
  });

  it('applies a percentage', () => {
    expect(Money.of('1234567.89').applyPercentage(Percentage.of('25')).toDatabaseValue()).toBe(
      '308641.97',
    );
  });
});

describe('Money comparison', () => {
  const small = Money.of('10.00');
  const large = Money.of('20.00');

  it('orders values', () => {
    expect(small.lessThan(large)).toBe(true);
    expect(large.greaterThan(small)).toBe(true);
    expect(small.lessThanOrEqual(Money.of('10.00'))).toBe(true);
    expect(small.greaterThanOrEqual(Money.of('10.00'))).toBe(true);
    expect(small.compare(large)).toBeLessThan(0);
  });

  it('treats equal amounts in the same currency as equal', () => {
    expect(Money.of('10.00').equals(Money.of('10.0'))).toBe(true);
  });

  it('treats equal amounts in different currencies as unequal, without throwing', () => {
    expect(Money.of('10.00', TZS).equals(Money.of('10.00', USD))).toBe(false);
  });

  it('refuses to order across currencies', () => {
    expect(() => Money.of('10.00', TZS).lessThan(Money.of('10.00', USD))).toThrow(
      CurrencyMismatchError,
    );
  });

  it('reports sign', () => {
    expect(Money.zero().isZero()).toBe(true);
    expect(Money.of('0.01').isPositive()).toBe(true);
    expect(Money.of('-0.01').isNegative()).toBe(true);
    expect(Money.zero().isPositive()).toBe(false);
    expect(Money.zero().isNegative()).toBe(false);
  });
});

describe('Money aggregation', () => {
  it('sums a list exactly', () => {
    const values = ['0.01', '0.02', '0.03', '0.04'].map((value) => Money.of(value));
    expect(Money.sum(values).toDatabaseValue()).toBe('0.10');
  });

  it('sums an empty list to zero', () => {
    expect(Money.sum([]).toDatabaseValue()).toBe('0.00');
  });

  it('selects minimum and maximum', () => {
    expect(Money.min(Money.of('5.00'), Money.of('3.00')).toDatabaseValue()).toBe('3.00');
    expect(Money.max(Money.of('5.00'), Money.of('3.00')).toDatabaseValue()).toBe('5.00');
  });
});

describe('Money serialisation', () => {
  it('renders at fixed scale', () => {
    expect(Money.of('5').toString()).toBe('5.00');
  });

  it('serialises to JSON as a string, never a number', () => {
    const encoded = JSON.stringify({ balance: Money.of('1234.56') });

    expect(encoded).toBe('{"balance":"1234.56"}');
    // A JSON number would be parsed back into a double by every parser,
    // undoing exactness at the first API boundary it crosses.
    expect(encoded).not.toContain('1234.56,');
    expect(JSON.parse(encoded)).toEqual({ balance: '1234.56' });
  });

  it('never renders large values in exponential notation', () => {
    expect(Money.of('9999999999999.99').toDatabaseValue()).toBe('9999999999999.99');
  });
});

describe('Money immutability', () => {
  it('leaves the original unchanged after arithmetic', () => {
    const original = Money.of('100.00');
    original.plus(Money.of('50.00'));
    original.times('2');
    original.negated();

    expect(original.toDatabaseValue()).toBe('100.00');
  });

  it('accepts a Dec as input without aliasing it', () => {
    const input = new Dec('100.00');
    const money = Money.of(input);

    expect(money.toDatabaseValue()).toBe('100.00');
  });
});
