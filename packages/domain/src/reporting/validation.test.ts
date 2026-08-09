import { Money, Percentage, Rate } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { compileMsp2_03, type Msp2_03 } from './msp2-03.js';
import { compileMsp2_04 } from './msp2-04.js';
import { compileMsp2_09 } from './msp2-09.js';
import { compileMsp2_10 } from './msp2-10.js';
import { validatePortfolioForms, type PortfolioForms } from './validation.js';

const SECTORS = ['agriculture', 'trade'];
const TYPES = ['business_individual_loans'];
const DISTRICTS = [{ code: 'ARU-CC', regionCode: 'ARUSHA' }];
const AS_AT = new Date('2026-03-31T00:00:00Z');

/** A consistent set of forms describing one borrower with one loan. */
function consistentForms(): PortfolioForms {
  return {
    msp2_03: compileMsp2_03({
      sectorCodes: SECTORS,
      exposures: [
        {
          sectorCode: 'agriculture',
          clientId: 'client-1',
          outstanding: Money.of('1000000'),
          classification: 'current',
          provisionRate: Percentage.of('1'),
        },
      ],
      writeOffs: [],
      collateral: [],
    }),
    msp2_04: compileMsp2_04({
      loanTypeCodes: TYPES,
      exposures: [
        {
          botLoanType: 'business_individual_loans',
          clientId: 'client-1',
          outstanding: Money.of('1000000'),
          monthlyRate: Rate.ofMonthlyFraction('0.03'),
          interestMethod: 'reducing_balance',
        },
      ],
    }),
    msp2_09: compileMsp2_09({ sectorCodes: SECTORS, disbursements: [] }),
    msp2_10: compileMsp2_10({
      districts: DISTRICTS,
      exposures: [],
      presence: [
        {
          districtCode: 'ARU-CC',
          branchCount: 1,
          employeeCount: 4,
          compulsorySavings: Money.of('50000'),
        },
      ],
      asAt: AS_AT,
    }),
  };
}

const blocking = (result: { findings: readonly { severity: string }[] }): number =>
  result.findings.filter((finding) => finding.severity === 'blocking').length;

describe('validatePortfolioForms', () => {
  it('passes a consistent set of forms', () => {
    const result = validatePortfolioForms(consistentForms());

    expect(blocking(result)).toBe(0);
    expect(result.submittable).toBe(true);
  });

  it('reports the rules it could not check rather than passing over them', () => {
    // A validator that silently skips half its rules teaches its user that a
    // clean run means a valid return, and that lesson is wrong in exactly the
    // cases that matter.
    const result = validatePortfolioForms(consistentForms());

    const unchecked = result.findings.filter((finding) =>
      finding.message.includes('could not be checked'),
    );
    expect(unchecked.length).toBeGreaterThan(0);
    expect(unchecked.every((finding) => finding.severity === 'warning')).toBe(true);
  });

  it('blocks when the borrower counts on MSP2-03 and MSP2-04 disagree', () => {
    // The same borrowers counted through different dimensions. A difference
    // means an exposure is on one form and not the other — a loan whose client
    // has a sector but whose product has no BOT loan type, or the reverse.
    const forms = consistentForms();
    const mismatched: PortfolioForms = {
      ...forms,
      msp2_04: compileMsp2_04({
        loanTypeCodes: TYPES,
        exposures: [
          {
            botLoanType: 'business_individual_loans',
            clientId: 'client-1',
            outstanding: Money.of('1000000'),
            monthlyRate: Rate.ofMonthlyFraction('0.03'),
            interestMethod: 'reducing_balance',
          },
          {
            botLoanType: 'business_individual_loans',
            clientId: 'client-2',
            outstanding: Money.of('500000'),
            monthlyRate: Rate.ofMonthlyFraction('0.03'),
            interestMethod: 'reducing_balance',
          },
        ],
      }),
    };

    const result = validatePortfolioForms(mismatched);

    expect(result.submittable).toBe(false);
    expect(result.findings.some((finding) => finding.ruleId === 3)).toBe(true);
  });

  it('blocks when an exposure could not be classified', () => {
    const forms = consistentForms();
    const withUnclassified: PortfolioForms = {
      ...forms,
      msp2_03: compileMsp2_03({
        sectorCodes: SECTORS,
        exposures: [
          {
            sectorCode: 'agriculture',
            clientId: 'client-1',
            outstanding: Money.of('1000000'),
            classification: 'current',
            provisionRate: Percentage.of('1'),
          },
          {
            sectorCode: 'agriculture',
            clientId: 'housing-borrower',
            outstanding: Money.of('900000'),
            classification: null,
            provisionRate: null,
          },
        ],
        writeOffs: [],
        collateral: [],
      }),
    };

    const result = validatePortfolioForms(withUnclassified);

    // The reported portfolio is short by 900,000 and nothing on the form says
    // so. Blocking is the only honest answer.
    expect(result.submittable).toBe(false);
    expect(
      result.findings.some((finding) =>
        finding.message.includes('outside every provisioning band'),
      ),
    ).toBe(true);
  });

  it('blocks when a sector’s classification columns do not sum to its total', () => {
    const forms = consistentForms();
    const broken = forms.msp2_03.rows[0]!;

    // A form assembled by something other than the compiler — an import, a
    // hand-edit, a future code path. The rule exists because BOT checks it.
    const tampered: Msp2_03 = {
      ...forms.msp2_03,
      rows: [{ ...broken, totalOutstanding: Money.of('999999') }, ...forms.msp2_03.rows.slice(1)],
    };

    const result = validatePortfolioForms({ ...forms, msp2_03: tampered });

    expect(result.submittable).toBe(false);
    expect(result.findings.some((finding) => finding.ruleId === 17)).toBe(true);
  });

  it('warns when compulsory savings are nil, since BOT ties them to MSP2-01', () => {
    const forms = consistentForms();
    const withoutSavings: PortfolioForms = {
      ...forms,
      msp2_10: compileMsp2_10({
        districts: DISTRICTS,
        exposures: [],
        presence: [],
        asAt: AS_AT,
      }),
    };

    const result = validatePortfolioForms(withoutSavings);

    const warning = result.findings.find((finding) =>
      finding.message.includes('Compulsory savings'),
    );
    expect(warning?.severity).toBe('warning');
    // A warning, not a block: an institution may genuinely hold none, and
    // refusing to file on that basis would be wrong.
    expect(result.submittable).toBe(true);
  });

  it('reports every failure at once rather than stopping at the first', () => {
    // An operator needs to know whether the problem is one figure or the whole
    // compilation, and one-at-a-time means one filing window per mistake.
    const forms = consistentForms();
    const broken = forms.msp2_03.rows[0]!;
    const tampered: Msp2_03 = {
      ...forms.msp2_03,
      rows: [{ ...broken, totalOutstanding: Money.of('999999') }, ...forms.msp2_03.rows.slice(1)],
      total: { ...forms.msp2_03.total, borrowerCount: 99 },
    };

    const result = validatePortfolioForms({ ...forms, msp2_03: tampered });

    expect(blocking(result)).toBeGreaterThan(1);
  });
});
