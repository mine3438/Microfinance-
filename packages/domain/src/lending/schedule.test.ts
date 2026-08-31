import { Money, Rate } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  MAXIMUM_TERM_MONTHS,
  generateSchedule,
  isInterestMethod,
  type InterestMethod,
  type ScheduleRequest,
} from './schedule.js';

/**
 * Expected schedules were computed against an independent decimal
 * implementation before this engine was written, not read back out of it. A
 * test that asserts whatever the code currently produces locks in a wrong
 * amortisation as firmly as a right one, and a wrong schedule is a borrower
 * paying the wrong instalment for a year.
 */

const DISBURSED = new Date('2026-01-15T00:00:00.000Z');

const request = (overrides: Partial<ScheduleRequest> = {}): ScheduleRequest => ({
  principal: Money.of('1000000.00'),
  monthlyRate: Rate.ofMonthlyFraction('0.05'),
  termMonths: 12,
  method: 'flat',
  disbursementDate: DISBURSED,
  ...overrides,
});

describe('flat rate', () => {
  const schedule = generateSchedule(request({ method: 'flat' }));

  it('charges the same interest every period, on the original principal', () => {
    const interest = schedule.instalments.map((row) => row.interestDue.toDatabaseValue());

    expect(new Set(interest)).toEqual(new Set(['50000.00']));
  });

  it('splits principal evenly except in the terminal period', () => {
    expect(schedule.instalments[0]?.principalDue.toDatabaseValue()).toBe('83333.33');
    expect(schedule.instalments[10]?.principalDue.toDatabaseValue()).toBe('83333.33');
    // The final instalment absorbs the rounding residual: 1,000,000 does not
    // divide by twelve, and the borrower was quoted the earlier figure.
    expect(schedule.instalments[11]?.principalDue.toDatabaseValue()).toBe('83333.37');
  });

  it('totals to the figures computed independently', () => {
    expect(schedule.totalPrincipal.toDatabaseValue()).toBe('1000000.00');
    expect(schedule.totalInterest.toDatabaseValue()).toBe('600000.00');
    expect(schedule.totalRepayable.toDatabaseValue()).toBe('1600000.00');
  });

  it('closes at exactly zero', () => {
    expect(schedule.instalments.at(-1)?.closingBalance.isZero()).toBe(true);
  });
});

describe('reducing balance', () => {
  const schedule = generateSchedule(request({ method: 'reducing_balance' }));

  it('matches the annuity payment computed independently', () => {
    // P × r ÷ (1 − (1 + r)^−n) = 112825.4100208…, rounding to 112825.41.
    expect(schedule.instalments[0]?.totalDue.toDatabaseValue()).toBe('112825.41');
  });

  it('reproduces the first two periods exactly', () => {
    expect(schedule.instalments[0]?.principalDue.toDatabaseValue()).toBe('62825.41');
    expect(schedule.instalments[0]?.interestDue.toDatabaseValue()).toBe('50000.00');
    expect(schedule.instalments[0]?.closingBalance.toDatabaseValue()).toBe('937174.59');

    expect(schedule.instalments[1]?.principalDue.toDatabaseValue()).toBe('65966.68');
    expect(schedule.instalments[1]?.interestDue.toDatabaseValue()).toBe('46858.73');
    expect(schedule.instalments[1]?.closingBalance.toDatabaseValue()).toBe('871207.91');
  });

  it('reproduces the terminal period exactly', () => {
    const last = schedule.instalments.at(-1);

    expect(last?.principalDue.toDatabaseValue()).toBe('107452.79');
    expect(last?.interestDue.toDatabaseValue()).toBe('5372.64');
    // Slightly above the level payment, because the terminal period closes the
    // balance rather than paying the quoted instalment and leaving a remainder.
    expect(last?.totalDue.toDatabaseValue()).toBe('112825.43');
    expect(last?.closingBalance.isZero()).toBe(true);
  });

  it('totals to the figures computed independently', () => {
    expect(schedule.totalPrincipal.toDatabaseValue()).toBe('1000000.00');
    expect(schedule.totalInterest.toDatabaseValue()).toBe('353904.94');
    expect(schedule.totalRepayable.toDatabaseValue()).toBe('1353904.94');
  });

  it('charges less interest than the same rate charged flat', () => {
    // Roughly 41% less over this term. It is the single most consequential
    // difference between the two methods for a borrower, and the reason
    // MSP2-04 reports them in separate columns rather than blending them.
    const flat = generateSchedule(request({ method: 'flat' }));

    expect(schedule.totalInterest.lessThan(flat.totalInterest)).toBe(true);
  });

  it('reduces interest every period as the balance falls', () => {
    for (let index = 1; index < schedule.instalments.length; index += 1) {
      const previous = schedule.instalments[index - 1];
      const current = schedule.instalments[index];
      expect(current?.interestDue.lessThan(previous?.interestDue ?? Money.zero())).toBe(true);
    }
  });

  it('handles an awkward rate and term', () => {
    // 100,000 at 3.75% over 7 months, verified independently.
    const awkward = generateSchedule({
      principal: Money.of('100000.00'),
      monthlyRate: Rate.ofMonthlyFraction('0.0375'),
      termMonths: 7,
      method: 'reducing_balance',
      disbursementDate: DISBURSED,
    });

    expect(awkward.instalments[0]?.totalDue.toDatabaseValue()).toBe('16507.37');
    expect(awkward.instalments.at(-1)?.principalDue.toDatabaseValue()).toBe('15910.72');
    expect(awkward.totalPrincipal.toDatabaseValue()).toBe('100000.00');
    expect(awkward.totalInterest.toDatabaseValue()).toBe('15551.59');
    expect(awkward.instalments.at(-1)?.closingBalance.isZero()).toBe(true);
  });
});

describe('the invariant that matters', () => {
  const methods: InterestMethod[] = ['flat', 'reducing_balance'];
  const principals = ['1.00', '999.99', '100000.00', '1234567.89', '9999999.99'];
  const rates = ['0', '0.0001', '0.0125', '0.05', '0.1'];
  const terms = [1, 2, 3, 7, 12, 24, 36, 60];

  it('always schedules exactly the principal advanced', () => {
    // 400 combinations. A schedule that sums to a shilling more or less than
    // the advance leaves a loan that can never close at zero, and no report
    // that includes it will reconcile.
    for (const method of methods) {
      for (const principal of principals) {
        for (const rate of rates) {
          for (const term of terms) {
            const schedule = generateSchedule({
              principal: Money.of(principal),
              monthlyRate: Rate.ofMonthlyFraction(rate),
              termMonths: term,
              method,
              disbursementDate: DISBURSED,
            });

            expect(schedule.totalPrincipal.toDatabaseValue()).toBe(
              Money.of(principal).toDatabaseValue(),
            );
            expect(schedule.instalments.at(-1)?.closingBalance.isZero()).toBe(true);
          }
        }
      }
    }
  });

  it('always keeps the running balance consistent period to period', () => {
    for (const method of methods) {
      const schedule = generateSchedule(request({ method, termMonths: 24 }));
      let expectedOpening = schedule.instalments[0]?.openingBalance;

      for (const instalment of schedule.instalments) {
        expect(instalment.openingBalance.toDatabaseValue()).toBe(
          expectedOpening?.toDatabaseValue(),
        );
        expect(instalment.closingBalance.toDatabaseValue()).toBe(
          instalment.openingBalance.minus(instalment.principalDue).toDatabaseValue(),
        );
        expectedOpening = instalment.closingBalance;
      }
    }
  });

  it('always makes total due the sum of its parts', () => {
    for (const method of methods) {
      const schedule = generateSchedule(request({ method, termMonths: 18 }));

      for (const instalment of schedule.instalments) {
        expect(instalment.totalDue.toDatabaseValue()).toBe(
          instalment.principalDue.plus(instalment.interestDue).toDatabaseValue(),
        );
      }
    }
  });

  it('never schedules a negative amount', () => {
    for (const method of methods) {
      const schedule = generateSchedule(request({ method, termMonths: 36 }));

      for (const instalment of schedule.instalments) {
        expect(instalment.principalDue.isNegative()).toBe(false);
        expect(instalment.interestDue.isNegative()).toBe(false);
        expect(instalment.closingBalance.isNegative()).toBe(false);
      }
    }
  });

  it('is deterministic — the same request gives a byte-identical schedule', () => {
    const first = generateSchedule(request({ method: 'reducing_balance' }));
    const second = generateSchedule(request({ method: 'reducing_balance' }));

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

describe('edge cases', () => {
  it('handles a single-period loan', () => {
    const schedule = generateSchedule(request({ termMonths: 1, method: 'reducing_balance' }));

    expect(schedule.instalments).toHaveLength(1);
    expect(schedule.instalments[0]?.principalDue.toDatabaseValue()).toBe('1000000.00');
    expect(schedule.instalments[0]?.interestDue.toDatabaseValue()).toBe('50000.00');
  });

  it('handles a zero rate without dividing by zero', () => {
    // Rate permits zero; whether a loan product may is a separate rule, still
    // open in §13.8. The engine must not fall over either way.
    const schedule = generateSchedule({
      ...request({ method: 'reducing_balance' }),
      monthlyRate: Rate.zero(),
    });

    expect(schedule.totalInterest.isZero()).toBe(true);
    expect(schedule.totalPrincipal.toDatabaseValue()).toBe('1000000.00');
  });

  it('handles the smallest representable principal', () => {
    const schedule = generateSchedule({
      ...request({ method: 'reducing_balance', termMonths: 3 }),
      principal: Money.of('0.01'),
    });

    expect(schedule.totalPrincipal.toDatabaseValue()).toBe('0.01');
    expect(schedule.instalments.at(-1)?.closingBalance.isZero()).toBe(true);
  });
});

describe('rejected requests', () => {
  it.each([
    ['zero principal', { principal: Money.zero() }],
    ['negative principal', { principal: Money.of('-1.00') }],
    ['zero term', { termMonths: 0 }],
    ['negative term', { termMonths: -6 }],
    ['fractional term', { termMonths: 6.5 }],
    ['term beyond the maximum', { termMonths: MAXIMUM_TERM_MONTHS + 1 }],
    ['an invalid date', { disbursementDate: new Date('not a date') }],
  ])('refuses %s', (_label, overrides) => {
    expect(() => generateSchedule(request(overrides))).toThrow(DomainValidationError);
  });

  it('refuses an unknown interest method', () => {
    expect(() => generateSchedule(request({ method: 'compound_daily' as InterestMethod }))).toThrow(
      /Unknown interest method/,
    );
  });

  it('accepts exactly the maximum term', () => {
    expect(() => generateSchedule(request({ termMonths: MAXIMUM_TERM_MONTHS }))).not.toThrow();
  });

  it('narrows a method string', () => {
    expect(isInterestMethod('flat')).toBe(true);
    expect(isInterestMethod('reducing_balance')).toBe(true);
    expect(isInterestMethod('compound')).toBe(false);
  });
});
