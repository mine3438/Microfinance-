import { describe, expect, it } from 'vitest';

import { AllocationError } from './errors.js';
import { Money } from './money.js';

/**
 * Deterministic pseudo-random generator.
 *
 * The property tests below need many varied inputs, but a test that fails only
 * on some runs is worse than no test — nobody can reproduce it. A fixed-seed
 * LCG gives breadth of input with an identical sequence on every run and in CI.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // Numerical Recipes LCG constants.
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('Money.distribute', () => {
  it('splits evenly when the amount divides cleanly', () => {
    const parts = Money.of('99.00').distribute(3);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['33.00', '33.00', '33.00']);
  });

  it('gives the leftover minor unit to the earliest part', () => {
    // 100.00 into three is 33.333…; naive rounding would produce three 33.33s
    // and lose a cent. Largest-remainder puts it on the first part.
    const parts = Money.of('100.00').distribute(3);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['33.34', '33.33', '33.33']);
    expect(Money.sum(parts).toDatabaseValue()).toBe('100.00');
  });

  it('spreads several leftover units across the earliest parts', () => {
    // 5 minor units across 3: one each, then 2 left to distribute.
    const parts = Money.of('0.05').distribute(3);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['0.02', '0.02', '0.01']);
    expect(Money.sum(parts).toDatabaseValue()).toBe('0.05');
  });

  it('handles a single part', () => {
    expect(Money.of('123.45').distribute(1)[0]?.toDatabaseValue()).toBe('123.45');
  });

  it('handles more parts than minor units, giving zeros to the remainder', () => {
    const parts = Money.of('0.02').distribute(5);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual([
      '0.01',
      '0.01',
      '0.00',
      '0.00',
      '0.00',
    ]);
    expect(Money.sum(parts).toDatabaseValue()).toBe('0.02');
  });

  it('distributes a negative amount without losing a unit', () => {
    const parts = Money.of('-100.00').distribute(3);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['-33.34', '-33.33', '-33.33']);
    expect(Money.sum(parts).toDatabaseValue()).toBe('-100.00');
  });

  it('distributes zero as zeros', () => {
    const parts = Money.zero().distribute(4);

    expect(Money.sum(parts).toDatabaseValue()).toBe('0.00');
    expect(parts.every((part) => part.isZero())).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN])('rejects a parts count of %j', (parts) => {
    expect(() => Money.of('10.00').distribute(parts)).toThrow(AllocationError);
  });
});

describe('Money.allocate', () => {
  it('splits by weight', () => {
    const parts = Money.of('100.00').allocate(['1', '3']);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['25.00', '75.00']);
  });

  it('splits by uneven weights and still sums exactly', () => {
    const parts = Money.of('1000.00').allocate(['1', '1', '1', '1', '1', '1', '1']);

    expect(Money.sum(parts).toDatabaseValue()).toBe('1000.00');
    expect(parts.map((part) => part.toDatabaseValue())).toEqual([
      '142.86',
      '142.86',
      '142.86',
      '142.86',
      '142.86',
      '142.85',
      '142.85',
    ]);
  });

  it('permits a zero weight, allocating nothing to it', () => {
    const parts = Money.of('100.00').allocate(['1', '0', '1']);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['50.00', '0.00', '50.00']);
  });

  it('accepts fractional weights', () => {
    const parts = Money.of('100.00').allocate(['0.5', '0.25', '0.25']);

    expect(parts.map((part) => part.toDatabaseValue())).toEqual(['50.00', '25.00', '25.00']);
  });

  it('is deterministic — the same inputs give byte-identical output', () => {
    const first = Money.of('1000.00').allocate(['1', '1', '1']);
    const second = Money.of('1000.00').allocate(['1', '1', '1']);

    expect(first.map((part) => part.toDatabaseValue())).toEqual(
      second.map((part) => part.toDatabaseValue()),
    );
  });

  it('rejects an empty weight list', () => {
    expect(() => Money.of('100.00').allocate([])).toThrow(AllocationError);
  });

  it('rejects weights summing to zero, which define no split', () => {
    expect(() => Money.of('100.00').allocate(['0', '0'])).toThrow(/sum to zero/);
  });

  it('rejects a negative weight', () => {
    expect(() => Money.of('100.00').allocate(['1', '-1'])).toThrow(/negative/);
  });

  it('rejects a float weight', () => {
    // @ts-expect-error — the type forbids it; this proves the runtime does too.
    expect(() => Money.of('100.00').allocate([0.5, 0.5])).toThrow(/never travel as a float/);
  });
});

describe('allocation invariants', () => {
  const random = seededRandom(20_260_807);

  /** Random amount up to ten million, at two decimal places. */
  const randomAmount = (): Money =>
    Money.of((Math.floor(random() * 1_000_000_000) / 100).toFixed(2));

  it('parts always sum to exactly the original amount (500 cases)', () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const amount = randomAmount();
      const partCount = 1 + Math.floor(random() * 24);
      const weights = Array.from({ length: partCount }, () =>
        String(1 + Math.floor(random() * 100)),
      );

      const parts = amount.allocate(weights);

      expect(Money.sum(parts).toDatabaseValue()).toBe(amount.toDatabaseValue());
    }
  });

  it('distribute always sums to exactly the original amount (500 cases)', () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const amount = randomAmount();
      const parts = amount.distribute(1 + Math.floor(random() * 36));

      expect(Money.sum(parts).toDatabaseValue()).toBe(amount.toDatabaseValue());
    }
  });

  it('every part is representable at the currency scale (500 cases)', () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const parts = randomAmount().distribute(1 + Math.floor(random() * 12));

      for (const part of parts) {
        // A part that is not exactly representable would throw on re-entry.
        expect(() => Money.of(part.toDatabaseValue())).not.toThrow();
        expect(part.toDatabaseValue()).toMatch(/^-?\d+\.\d{2}$/);
      }
    }
  });

  it('parts never differ by more than one minor unit under equal weights (500 cases)', () => {
    for (let iteration = 0; iteration < 500; iteration += 1) {
      const parts = randomAmount().distribute(2 + Math.floor(random() * 24));
      const sorted = [...parts].sort((left, right) => left.compare(right));
      const smallest = sorted[0];
      const largest = sorted[sorted.length - 1];

      expect(smallest).toBeDefined();
      expect(largest).toBeDefined();
      if (smallest !== undefined && largest !== undefined) {
        expect(largest.minus(smallest).lessThanOrEqual(Money.of('0.01'))).toBe(true);
      }
    }
  });
});
