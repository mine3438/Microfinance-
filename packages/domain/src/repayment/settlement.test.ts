import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { endOfMonth, quoteSettlement, type ScheduledInterest } from './settlement.js';

/**
 * Settling early.
 *
 * The rule under test is the institution's, approved and recorded as SETTLE-01
 * through SETTLE-04: principal, plus interest through the settlement month,
 * plus every accrued penalty, with no discount.
 *
 * Almost everything here is about **month granularity**, because that is the
 * part a reasonable implementation gets wrong by being too clever. Prorating
 * August by days would look more precise and would be the wrong answer.
 */

/** Wrapped rather than aliased: `Money.of` detached from `Money` loses its receiver. */
const money = (amount: string): Money => Money.of(amount);

/** Ten monthly instalments of 20,000 interest each, from January 2026. */
const schedule: readonly ScheduledInterest[] = Array.from({ length: 10 }, (_, index) => ({
  dueDate: `2026-${String(index + 1).padStart(2, '0')}-15`,
  interestDue: money('20000'),
}));

const quote = (settlementDate: string, overrides: Record<string, Money> = {}) =>
  quoteSettlement({
    settlementDate,
    outstandingPrincipal: overrides['principal'] ?? money('600000'),
    penaltyOutstanding: overrides['penalty'] ?? money('0'),
    schedule,
    interestAlreadyPaid: overrides['paid'] ?? money('0'),
  });

describe('endOfMonth', () => {
  it.each([
    ['2026-08-10', '2026-08-31'],
    ['2026-02-01', '2026-02-28'],
    ['2024-02-05', '2024-02-29'],
    ['2026-04-30', '2026-04-30'],
    ['2026-12-25', '2026-12-31'],
  ])('takes %s through to %s', (date, expected) => {
    expect(endOfMonth(date)).toBe(expected);
  });

  it('refuses a date it cannot reduce to a month', () => {
    expect(() => endOfMonth('10 August 2026')).toThrow(DomainValidationError);
  });
});

describe('month granularity', () => {
  it('charges the same whatever day of the month settlement falls on', () => {
    // The approved rule, stated as the property that proves it. If anything
    // prorated by day, these three would differ.
    const first = quote('2026-08-01');
    const middle = quote('2026-08-10');
    const last = quote('2026-08-31');

    expect(middle.total.toDatabaseValue()).toBe(first.total.toDatabaseValue());
    expect(last.total.toDatabaseValue()).toBe(first.total.toDatabaseValue());
  });

  it('includes the settlement month and excludes the months after it', () => {
    // Settling in August: January through August is eight instalments of
    // 20,000. September and October are not charged.
    const settled = quote('2026-08-10');

    expect(settled.interest.toDatabaseValue()).toBe('160000.00');
    expect(settled.interestNotCharged.toDatabaseValue()).toBe('40000.00');
    expect(settled.chargedThrough).toBe('2026-08-31');
  });

  it('includes an instalment falling later in the settlement month', () => {
    // The August instalment is due on the 15th; settlement is on the 1st. The
    // whole month counts, so it is charged even though its due date has not
    // arrived.
    expect(quote('2026-08-01').interest.toDatabaseValue()).toBe('160000.00');
  });

  it('moves by exactly one instalment when settlement moves by one month', () => {
    expect(quote('2026-07-31').interest.toDatabaseValue()).toBe('140000.00');
    expect(quote('2026-08-01').interest.toDatabaseValue()).toBe('160000.00');
  });
});

describe('what the borrower pays', () => {
  it('is principal plus chargeable interest plus every penalty', () => {
    const settled = quote('2026-08-10', {
      principal: money('600000'),
      penalty: money('20000'),
    });

    expect(settled.principal.toDatabaseValue()).toBe('600000.00');
    expect(settled.interest.toDatabaseValue()).toBe('160000.00');
    expect(settled.penalty.toDatabaseValue()).toBe('20000.00');
    expect(settled.total.toDatabaseValue()).toBe('780000.00');
  });

  it('applies no discount — the parts are exactly the total', () => {
    const settled = quote('2026-08-10', { penalty: money('20000') });

    const parts = Money.sum([settled.principal, settled.interest, settled.penalty]);
    expect(parts.toDatabaseValue()).toBe(settled.total.toDatabaseValue());
  });

  it('does not waive penalties', () => {
    // Explicit, because "settle and we will drop the penalties" is a plausible
    // commercial gesture and is not the approved rule.
    const settled = quote('2026-08-10', { penalty: money('37500') });

    expect(settled.penalty.toDatabaseValue()).toBe('37500.00');
    expect(settled.total.toDatabaseValue()).toBe('797500.00');
  });

  it('credits interest already paid', () => {
    // Eight instalments chargeable, three already paid: five to go.
    const settled = quote('2026-08-10', { paid: money('60000') });

    expect(settled.interest.toDatabaseValue()).toBe('100000.00');
  });

  it('never charges negative interest when more has been paid than is chargeable', () => {
    // A borrower ahead on interest is ahead. Letting this go negative would
    // quietly reduce the principal they still owe.
    const settled = quote('2026-02-10', { paid: money('500000') });

    expect(settled.interest.toDatabaseValue()).toBe('0.00');
    expect(settled.total.toDatabaseValue()).toBe('600000.00');
  });
});

describe('settling in the final month', () => {
  it('charges the whole schedule and waives nothing', () => {
    const settled = quote('2026-10-20');

    expect(settled.interest.toDatabaseValue()).toBe('200000.00');
    expect(settled.interestNotCharged.toDatabaseValue()).toBe('0.00');
  });

  it('charges nothing beyond the schedule when settlement is after maturity', () => {
    const settled = quote('2027-03-01');

    expect(settled.interest.toDatabaseValue()).toBe('200000.00');
    expect(settled.interestNotCharged.toDatabaseValue()).toBe('0.00');
  });
});

describe('refusals', () => {
  it('refuses a negative principal', () => {
    expect(() =>
      quoteSettlement({
        settlementDate: '2026-08-10',
        outstandingPrincipal: money('-1'),
        penaltyOutstanding: money('0'),
        schedule,
        interestAlreadyPaid: money('0'),
      }),
    ).toThrow(DomainValidationError);
  });

  it('refuses a negative penalty', () => {
    expect(() =>
      quoteSettlement({
        settlementDate: '2026-08-10',
        outstandingPrincipal: money('1000'),
        penaltyOutstanding: money('-1'),
        schedule,
        interestAlreadyPaid: money('0'),
      }),
    ).toThrow(DomainValidationError);
  });

  it('refuses a schedule due date it cannot compare', () => {
    expect(() =>
      quoteSettlement({
        settlementDate: '2026-08-10',
        outstandingPrincipal: money('1000'),
        penaltyOutstanding: money('0'),
        schedule: [{ dueDate: '15/08/2026', interestDue: money('1') }],
        interestAlreadyPaid: money('0'),
      }),
    ).toThrow(DomainValidationError);
  });
});
