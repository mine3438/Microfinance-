import { Money, Rate } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { generateSchedule } from '../lending/schedule.js';
import {
  ALLOCATION_BUCKETS,
  DOCUMENTED_ALLOCATION_ORDER,
  allocatePayment,
  amountApplied,
  balanceAfter,
  type AllocationBucket,
} from './allocation.js';

const money = (value: string): Money => Money.of(value);

describe('the documented order', () => {
  it('applies interest first, then principal', () => {
    // TRD §4 describes the recorded behaviour as interest-first,
    // principal-second. These are the two figures the schedule engine's own
    // golden vectors produce for the first instalment of a 1,000,000 loan at
    // 5% over 12 months on a reducing balance.
    const allocation = allocatePayment({
      amountPaid: money('112825.41'),
      outstanding: { interest: money('50000.00'), principal: money('1000000.00') },
    });

    expect(amountApplied(allocation, 'interest').toDatabaseValue()).toBe('50000.00');
    expect(amountApplied(allocation, 'principal').toDatabaseValue()).toBe('62825.41');
    expect(allocation.unallocated.isZero()).toBe(true);
  });

  it('covers only what is owed when the payment is short', () => {
    const allocation = allocatePayment({
      amountPaid: money('30000.00'),
      outstanding: { interest: money('50000.00'), principal: money('1000000.00') },
    });

    expect(amountApplied(allocation, 'interest').toDatabaseValue()).toBe('30000.00');
    expect(amountApplied(allocation, 'principal').isZero()).toBe(true);
  });

  it('names only the two buckets the documentation covers', () => {
    // Penalties and fees exist in the type so the open question is visible, but
    // where they sit in the order is not documented and is not assumed here.
    expect([...DOCUMENTED_ALLOCATION_ORDER]).toEqual(['interest', 'principal']);
  });
});

describe('the invariant', () => {
  it('always accounts for every shilling paid', () => {
    // A split that loses money produces a balance nobody can reconcile, and
    // reconciling a borrower's account by hand is what this product exists to
    // stop.
    const cases: { paid: string; interest: string; principal: string }[] = [
      { paid: '0.01', interest: '0.00', principal: '1000000.00' },
      { paid: '112825.41', interest: '50000.00', principal: '1000000.00' },
      { paid: '999999.99', interest: '333.33', principal: '500000.00' },
      { paid: '1.00', interest: '0.99', principal: '0.02' },
      { paid: '9999999999999.99', interest: '1.00', principal: '2.00' },
    ];

    for (const testCase of cases) {
      const allocation = allocatePayment({
        amountPaid: money(testCase.paid),
        outstanding: { interest: money(testCase.interest), principal: money(testCase.principal) },
      });

      const total = Money.sum([...allocation.applied.values()]).plus(allocation.unallocated);
      expect(total.toDatabaseValue()).toBe(money(testCase.paid).toDatabaseValue());
    }
  });

  it('never applies more to a bucket than it owes', () => {
    const allocation = allocatePayment({
      amountPaid: money('500000.00'),
      outstanding: { interest: money('1000.00'), principal: money('2000.00') },
    });

    expect(amountApplied(allocation, 'interest').toDatabaseValue()).toBe('1000.00');
    expect(amountApplied(allocation, 'principal').toDatabaseValue()).toBe('2000.00');
  });
});

describe('paying more than is owed', () => {
  it('records the excess rather than absorbing it', () => {
    // The final instalment of the reducing-balance golden vector, overpaid.
    const allocation = allocatePayment({
      amountPaid: money('200000.00'),
      outstanding: { interest: money('5372.64'), principal: money('107452.79') },
    });

    expect(amountApplied(allocation, 'interest').toDatabaseValue()).toBe('5372.64');
    expect(amountApplied(allocation, 'principal').toDatabaseValue()).toBe('107452.79');
    expect(allocation.unallocated.toDatabaseValue()).toBe('87174.57');
  });

  it('leaves the whole payment unallocated when nothing is owed', () => {
    // Silently keeping it would answer the open question about excess funds
    // (§13.8) on the institution's behalf.
    const allocation = allocatePayment({
      amountPaid: money('5000.00'),
      outstanding: { interest: Money.zero(), principal: Money.zero() },
    });

    expect(allocation.unallocated.toDatabaseValue()).toBe('5000.00');
  });

  it('settles a loan exactly when the payment matches what is owed', () => {
    const allocation = allocatePayment({
      amountPaid: money('112825.43'),
      outstanding: { interest: money('5372.64'), principal: money('107452.79') },
    });

    expect(allocation.unallocated.isZero()).toBe(true);
  });
});

describe('a configurable order', () => {
  it('accepts an order that includes penalties and fees', () => {
    // What §13.2 proposes but has not confirmed. The engine can express it; the
    // decision to adopt it is the institution's.
    const allocation = allocatePayment({
      amountPaid: money('10000.00'),
      outstanding: {
        penalty: money('1500.00'),
        fee: money('500.00'),
        interest: money('3000.00'),
        principal: money('100000.00'),
      },
      order: ['penalty', 'fee', 'interest', 'principal'],
    });

    expect(amountApplied(allocation, 'penalty').toDatabaseValue()).toBe('1500.00');
    expect(amountApplied(allocation, 'fee').toDatabaseValue()).toBe('500.00');
    expect(amountApplied(allocation, 'interest').toDatabaseValue()).toBe('3000.00');
    expect(amountApplied(allocation, 'principal').toDatabaseValue()).toBe('5000.00');
  });

  it('changes the outcome when the order changes', () => {
    // Why the order is a decision and not a detail: the same payment against
    // the same debts settles different things depending on it, and which debt
    // is settled first is what the borrower is charged on next period.
    const outstanding = {
      penalty: money('4000.00'),
      interest: money('3000.00'),
      principal: money('100000.00'),
    };

    const penaltyFirst = allocatePayment({
      amountPaid: money('5000.00'),
      outstanding,
      order: ['penalty', 'interest', 'principal'],
    });
    const interestFirst = allocatePayment({
      amountPaid: money('5000.00'),
      outstanding,
      order: ['interest', 'penalty', 'principal'],
    });

    expect(amountApplied(penaltyFirst, 'penalty').toDatabaseValue()).toBe('4000.00');
    expect(amountApplied(interestFirst, 'penalty').toDatabaseValue()).toBe('2000.00');
  });

  it('names every bucket the system can allocate to', () => {
    expect([...ALLOCATION_BUCKETS]).toEqual(['penalty', 'fee', 'interest', 'principal']);
  });
});

describe('rejected requests', () => {
  it('refuses a zero payment', () => {
    expect(() =>
      allocatePayment({ amountPaid: Money.zero(), outstanding: { interest: money('1.00') } }),
    ).toThrow(DomainValidationError);
  });

  it('refuses a negative payment, and says how to undo one instead', () => {
    // A negative payment would make the payment record mean two different
    // things depending on its sign. Reversals are explicit.
    expect(() =>
      allocatePayment({ amountPaid: money('-100.00'), outstanding: { interest: money('1.00') } }),
    ).toThrow(/record a reversal/);
  });

  it('refuses an empty order', () => {
    expect(() =>
      allocatePayment({ amountPaid: money('100.00'), outstanding: {}, order: [] }),
    ).toThrow(/at least one bucket/);
  });

  it('refuses an order that repeats a bucket', () => {
    expect(() =>
      allocatePayment({
        amountPaid: money('100.00'),
        outstanding: { interest: money('50.00') },
        order: ['interest', 'principal', 'interest'] as AllocationBucket[],
      }),
    ).toThrow(/more than once/);
  });

  it('refuses an order that cannot reach something owed', () => {
    // Silently ignoring a debt the order omits would understate what the
    // borrower still owes.
    expect(() =>
      allocatePayment({
        amountPaid: money('100.00'),
        outstanding: { penalty: money('50.00'), interest: money('10.00') },
        order: ['interest', 'principal'],
      }),
    ).toThrow(/could never reach it/);
  });

  it('refuses a negative outstanding amount', () => {
    expect(() =>
      allocatePayment({
        amountPaid: money('100.00'),
        outstanding: { interest: money('-10.00'), principal: money('100.00') },
      }),
    ).toThrow(/negative balance is a defect upstream/);
  });
});

describe('the resulting balance', () => {
  it('falls by the principal applied and nothing else', () => {
    // Interest, penalties and fees are charges the payment settles. Paying them
    // does not reduce what was borrowed.
    const allocation = allocatePayment({
      amountPaid: money('112825.41'),
      outstanding: { interest: money('50000.00'), principal: money('1000000.00') },
    });

    expect(balanceAfter(money('1000000.00'), allocation).toDatabaseValue()).toBe('937174.59');
  });

  it('reaches exactly zero on a final payment', () => {
    const allocation = allocatePayment({
      amountPaid: money('112825.43'),
      outstanding: { interest: money('5372.64'), principal: money('107452.79') },
    });

    expect(balanceAfter(money('107452.79'), allocation).isZero()).toBe(true);
  });

  it('refuses to repay more principal than is owed', () => {
    const allocation = allocatePayment({
      amountPaid: money('500.00'),
      outstanding: { interest: Money.zero(), principal: money('500.00') },
    });

    expect(() => balanceAfter(money('100.00'), allocation)).toThrow(
      /cannot repay more principal than is owed/,
    );
  });

  it('reproduces a whole loan closing at exactly zero', () => {
    // Driven by the schedule engine rather than by transcribed figures, so this
    // also proves the two agree: a schedule the allocator cannot settle exactly
    // would be a schedule no borrower could ever clear.
    const schedule = generateSchedule({
      principal: money('1000000.00'),
      monthlyRate: Rate.ofMonthlyFraction('0.05'),
      termMonths: 12,
      method: 'reducing_balance',
      disbursementDate: new Date('2026-01-15T00:00:00.000Z'),
    });

    let balance = money('1000000.00');
    let interestPaid = Money.zero();

    for (const instalment of schedule.instalments) {
      const allocation = allocatePayment({
        amountPaid: instalment.totalDue,
        outstanding: { interest: instalment.interestDue, principal: balance },
      });

      expect(allocation.unallocated.isZero()).toBe(true);
      interestPaid = interestPaid.plus(amountApplied(allocation, 'interest'));
      balance = balanceAfter(balance, allocation);
    }

    expect(balance.isZero()).toBe(true);
    expect(interestPaid.toDatabaseValue()).toBe(schedule.totalInterest.toDatabaseValue());
    expect(interestPaid.toDatabaseValue()).toBe('353904.94');
  });
});
