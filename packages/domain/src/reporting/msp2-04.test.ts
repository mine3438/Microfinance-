import { Money, Rate } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { amortisationMethodFor, compileMsp2_04, type RateExposure } from './msp2-04.js';

const TYPES = ['business_individual_loans', 'housing_microfinance_loans'];

const exposure = (overrides: Partial<RateExposure> = {}): RateExposure => ({
  botLoanType: 'business_individual_loans',
  clientId: 'client-1',
  outstanding: Money.of('1000000'),
  monthlyRate: Rate.ofMonthlyFraction('0.03'),
  interestMethod: 'reducing_balance',
  ...overrides,
});

describe('amortisationMethodFor', () => {
  it('maps this system’s interest methods onto BOT’s two columns', () => {
    expect(amortisationMethodFor('flat')).toBe('straight_line');
    expect(amortisationMethodFor('reducing_balance')).toBe('reducing_balance');
  });
});

describe('compileMsp2_04', () => {
  it('converts the stored monthly rate to percent per annum', () => {
    // The system stores 0.03 a month; BOT wants percent per annum. Simple by
    // default: 0.03 × 12 × 100 = 36%.
    const form = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [exposure()] });

    expect(form.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('36.00');
    expect(form.annualisation).toBe('simple');
  });

  it('compounds when asked to, which is a materially different figure', () => {
    // 5% a month is 60% simple or 79.586% effective. §11.2 asks BOT which they
    // want; the convention is a parameter so the choice is visible.
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [exposure({ monthlyRate: Rate.ofMonthlyFraction('0.05') })],
      annualisation: 'effective',
    });

    expect(form.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('79.59');
  });

  it('tracks the lowest and highest rate within a loan type', () => {
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        exposure({ monthlyRate: Rate.ofMonthlyFraction('0.02') }),
        exposure({ monthlyRate: Rate.ofMonthlyFraction('0.05'), clientId: 'c2' }),
        exposure({ monthlyRate: Rate.ofMonthlyFraction('0.035'), clientId: 'c3' }),
      ],
    });

    expect(form.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('24.00');
    expect(form.rows[0]?.reducingBalance.highest?.toFixed(2)).toBe('60.00');
  });

  it('reports rates separately by amortisation method', () => {
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        exposure({ interestMethod: 'flat', monthlyRate: Rate.ofMonthlyFraction('0.02') }),
        exposure({
          interestMethod: 'reducing_balance',
          monthlyRate: Rate.ofMonthlyFraction('0.05'),
          clientId: 'c2',
        }),
      ],
    });

    expect(form.rows[0]?.straightLine.lowest?.toFixed(2)).toBe('24.00');
    expect(form.rows[0]?.reducingBalance.lowest?.toFixed(2)).toBe('60.00');
  });

  it('reports null, not zero, when a type has no lending under a method', () => {
    // A loan type with no straight-line lending has no lowest rate. Reporting
    // 0% would say it lends at nothing.
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [exposure({ interestMethod: 'reducing_balance' })],
    });

    expect(form.rows[0]?.straightLine.lowest).toBeNull();
    expect(form.rows[0]?.straightLine.weightedAverage).toBeNull();
  });

  it('replicates BOT’s weighted-average formula, doubling included', () => {
    // BOT's cell computes `weight × lowest + weight × highest`, which for a
    // single loan is twice its rate rather than the rate. That is an error in
    // the template, and it is replicated deliberately: BOT's EDI validator is
    // the authority on a valid submission, and a return whose arithmetic
    // differs from the template's own is the more likely one to be rejected
    // (02-BOT-REPORTING-SPEC.md §5.1 and §11.3).
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [exposure({ monthlyRate: Rate.ofMonthlyFraction('0.03') })],
    });

    // One loan at 36% per annum. A conventional weighted average would be 36%.
    expect(form.rows[0]?.reducingBalance.weightedAverage?.toFixed(2)).toBe('72.00');
  });

  it('weights the average by outstanding amount', () => {
    // 900,000 at 24% and 100,000 at 60%: weighted midpoint is 27.6%, doubled
    // by BOT's formula to 55.2%.
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        exposure({ outstanding: Money.of('900000'), monthlyRate: Rate.ofMonthlyFraction('0.02') }),
        exposure({
          outstanding: Money.of('100000'),
          monthlyRate: Rate.ofMonthlyFraction('0.05'),
          clientId: 'c2',
        }),
      ],
    });

    expect(form.rows[0]?.reducingBalance.weightedAverage?.toFixed(2)).toBe('55.20');
  });

  it('counts borrowers, not loans, to match MSP2-03', () => {
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        exposure({ clientId: 'client-1' }),
        exposure({ clientId: 'client-1' }),
        exposure({ clientId: 'client-2' }),
      ],
    });

    expect(form.rows[0]?.borrowerCount).toBe(2);
  });

  it('counts a borrower once across loan types in the total', () => {
    // One person borrowing on two products is one borrower on the total line,
    // which is what BOT's cross-form rule against MSP2-03 compares.
    const form = compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        exposure({ botLoanType: TYPES[0]!, clientId: 'client-1' }),
        exposure({ botLoanType: TYPES[1]!, clientId: 'client-1' }),
      ],
    });

    expect(form.total.borrowerCount).toBe(1);
  });

  it('produces a row for every published loan type', () => {
    const form = compileMsp2_04({ loanTypeCodes: TYPES, exposures: [] });

    expect(form.rows.map((row) => row.botLoanType)).toEqual(TYPES);
  });

  it('refuses a loan type BOT does not publish', () => {
    expect(() =>
      compileMsp2_04({ loanTypeCodes: TYPES, exposures: [exposure({ botLoanType: 'invented' })] }),
    ).toThrow(/not one BOT publishes/);
  });
});
