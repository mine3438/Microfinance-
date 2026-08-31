import { Decimal } from 'decimal.js';
import { afterEach, describe, expect, it } from 'vitest';

import { Dec, ROUND_DOWN, ROUND_HALF_UP, assertNotFloat, toDecimal } from './decimal.js';
import { Money } from './money.js';

describe('toDecimal', () => {
  it('accepts a decimal string exactly', () => {
    expect(toDecimal('1234.56', 'test').toFixed()).toBe('1234.56');
  });

  it('accepts an existing decimal unchanged', () => {
    const value = new Dec('7.25');
    expect(toDecimal(value, 'test')).toBe(value);
  });

  it('trims surrounding whitespace', () => {
    expect(toDecimal('  42.00  ', 'test').toFixed()).toBe('42');
  });

  it.each(['', '   ', 'abc', '1.2.3', '12,34', '1e', '--5'])('rejects %j', (input) => {
    expect(() => toDecimal(input, 'test')).toThrow(TypeError);
  });

  it.each(['Infinity', '-Infinity', 'NaN'])('rejects non-finite %j', (input) => {
    expect(() => toDecimal(input, 'test')).toThrow(/not finite|not a valid/);
  });

  it('names the calling context in the message, so failures are traceable', () => {
    expect(() => toDecimal('nope', 'Money.of')).toThrow(/^Money\.of:/);
  });
});

describe('assertNotFloat', () => {
  it('rejects a JavaScript number', () => {
    expect(() => {
      assertNotFloat(1234.56, 'test');
    }).toThrow(/never travel as a float/);
  });

  it('rejects even an integral number, since the type is the problem', () => {
    expect(() => {
      assertNotFloat(100, 'test');
    }).toThrow(TypeError);
  });

  it.each([
    ['string', '1.00'],
    ['null', null],
    ['undefined', undefined],
    ['object', {}],
  ])('permits %s, leaving its handling to the caller', (_label, value) => {
    expect(() => {
      assertNotFloat(value, 'test');
    }).not.toThrow();
  });
});

describe('the private Decimal constructor', () => {
  afterEach(() => {
    Decimal.set({ rounding: Decimal.ROUND_HALF_UP, precision: 20, toExpNeg: -7, toExpPos: 21 });
  });

  it('is insulated from global decimal.js reconfiguration', () => {
    // The reason for cloning: any dependency can call Decimal.set(), and without
    // a private constructor that would silently change how money rounds.
    Decimal.set({ rounding: Decimal.ROUND_DOWN });

    expect(Money.round('1.005').toDatabaseValue()).toBe('1.01');
  });

  it('is insulated from a global precision change', () => {
    Decimal.set({ precision: 3 });

    // 40 significant digits are configured locally; a global precision of 3
    // would truncate this division badly.
    expect(new Dec('1').dividedBy('3').toFixed(20)).toBe('0.33333333333333333333');
  });

  it('never renders in exponential notation, which NUMERIC will not accept', () => {
    expect(new Dec('9999999999999.99').toFixed()).toBe('9999999999999.99');
    expect(new Dec('0.0000000001').toFixed()).toBe('0.0000000001');
  });

  it('exposes half-up and down rounding as distinct modes', () => {
    expect(new Dec('1.005').toDecimalPlaces(2, ROUND_HALF_UP).toFixed(2)).toBe('1.01');
    expect(new Dec('1.009').toDecimalPlaces(2, ROUND_DOWN).toFixed(2)).toBe('1.00');
  });
});
