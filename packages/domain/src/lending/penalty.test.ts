import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { accruePenalty, type OverdueInstalment, type PenaltyTerms } from './penalty.js';

/**
 * Penalty accrual, in §13.1's confirmed shape.
 *
 * No figure here is a default. Every rate and grace period is the test's own,
 * chosen to make the arithmetic legible — the institution's values are still
 * outstanding, and a suite that hard-coded a plausible one would read as though
 * the question had been answered.
 */

const PRINCIPAL = Money.of('1000000.00');

const terms = (overrides: Partial<PenaltyTerms> = {}): PenaltyTerms => ({
  dailyRate: '0.0010',
  graceDays: 7,
  capFraction: null,
  ...overrides,
});

const overdue = (outstanding: string, dueDate: string): OverdueInstalment => ({
  outstanding: Money.of(outstanding),
  dueDate,
});

describe('accruePenalty', () => {
  it('charges nothing inside the grace period', () => {
    // Seven days' grace, seven days elapsed: the seventh day is the last free
    // one, so nothing is chargeable yet.
    const accrual = accruePenalty(
      [overdue('100000.00', '2026-03-01')],
      terms(),
      PRINCIPAL,
      '2026-03-08',
    );

    expect(accrual.total.isZero()).toBe(true);
    expect(accrual.chargeableDays).toEqual([0]);
  });

  it('charges from the first day after grace ends', () => {
    const accrual = accruePenalty(
      [overdue('100000.00', '2026-03-01')],
      terms(),
      PRINCIPAL,
      '2026-03-09',
    );

    // One chargeable day at 0.1% of 100,000.
    expect(accrual.chargeableDays).toEqual([1]);
    expect(accrual.total.toString()).toBe('100.00');
  });

  it('accrues simply, not compounded', () => {
    const accrual = accruePenalty(
      [overdue('100000.00', '2026-03-01')],
      terms(),
      PRINCIPAL,
      '2026-04-08',
    );

    // 38 days elapsed, 7 of grace: 31 chargeable days on an unchanging base.
    // Compounded at 0.1% daily this would be 3,147.42 rather than 3,100.
    expect(accrual.chargeableDays).toEqual([31]);
    expect(accrual.total.toString()).toBe('3100.00');
  });

  it('rounds once over the whole period, not once per day', () => {
    // A base whose daily charge is a third of a cent. Rounded per day it would
    // come to 10 × 0.01 = 0.10; rounded once it is 0.03, which is what the
    // agreement's own arithmetic gives.
    const accrual = accruePenalty(
      [overdue('3.33', '2026-03-01')],
      terms({ dailyRate: '0.0010', graceDays: 0 }),
      PRINCIPAL,
      '2026-03-11',
    );

    expect(accrual.chargeableDays).toEqual([10]);
    expect(accrual.total.toString()).toBe('0.03');
  });

  it('charges each overdue instalment on its own due date', () => {
    // The base is the overdue instalment, so two missed instalments accrue
    // separately from when each fell due — not on a combined arrears figure
    // from the earliest date.
    const accrual = accruePenalty(
      [overdue('50000.00', '2026-03-01'), overdue('50000.00', '2026-04-01')],
      terms({ graceDays: 0 }),
      PRINCIPAL,
      '2026-04-11',
    );

    expect(accrual.chargeableDays).toEqual([41, 10]);
    // 50,000 × 0.001 × 41 = 2,050 and × 10 = 500.
    expect(accrual.total.toString()).toBe('2550.00');
  });

  it('ignores an instalment that has been paid off', () => {
    const accrual = accruePenalty(
      [overdue('0.00', '2026-01-01'), overdue('20000.00', '2026-03-01')],
      terms({ graceDays: 0 }),
      PRINCIPAL,
      '2026-03-11',
    );

    expect(accrual.total.toString()).toBe('200.00');
  });

  it('stops at the cap and says what the cap removed', () => {
    const accrual = accruePenalty(
      [overdue('500000.00', '2026-01-01')],
      terms({ graceDays: 0, capFraction: '0.1000' }),
      PRINCIPAL,
      '2026-12-31',
    );

    // 364 days × 0.1% × 500,000 = 182,000, capped at 10% of 1,000,000.
    expect(accrual.total.toString()).toBe('100000.00');
    expect(accrual.capped.toString()).toBe('82000.00');
  });

  it('leaves an accrual below the cap untouched', () => {
    const accrual = accruePenalty(
      [overdue('10000.00', '2026-03-01')],
      terms({ graceDays: 0, capFraction: '0.1000' }),
      PRINCIPAL,
      '2026-03-11',
    );

    expect(accrual.total.toString()).toBe('100.00');
    expect(accrual.capped.isZero()).toBe(true);
  });

  it('answers as at a past date rather than as at today', () => {
    // Re-running the accrual must not change a figure already reported. The
    // same instalments, read to two dates, give two answers and both stay true.
    const instalments = [overdue('100000.00', '2026-03-01')];

    expect(
      accruePenalty(instalments, terms({ graceDays: 0 }), PRINCIPAL, '2026-03-11').total.toString(),
    ).toBe('1000.00');
    expect(
      accruePenalty(instalments, terms({ graceDays: 0 }), PRINCIPAL, '2026-03-21').total.toString(),
    ).toBe('2000.00');
  });

  it('charges nothing before the due date', () => {
    const accrual = accruePenalty(
      [overdue('100000.00', '2026-05-01')],
      terms({ graceDays: 0 }),
      PRINCIPAL,
      '2026-04-01',
    );

    expect(accrual.total.isZero()).toBe(true);
  });

  it('refuses a grace period that is not whole days', () => {
    expect(() =>
      accruePenalty(
        [overdue('1000.00', '2026-03-01')],
        terms({ graceDays: 1.5 }),
        PRINCIPAL,
        '2026-04-01',
      ),
    ).toThrow(DomainValidationError);
  });

  it('refuses to cap against a principal of nothing', () => {
    expect(() =>
      accruePenalty(
        [overdue('1000.00', '2026-03-01')],
        terms({ graceDays: 0, capFraction: '0.1000' }),
        Money.zero(),
        '2026-04-01',
      ),
    ).toThrow(DomainValidationError);
  });
});
