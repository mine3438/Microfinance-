import { Money, Percentage, Rate } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { derivedBalanceSheetFigures } from './derived.js';
import { compileMsp2_01, type StatementLine } from './msp2-01.js';
import { compileMsp2_02 } from './msp2-02.js';
import { type Msp2_02Line } from '../finance/entry.js';
import { compileMsp2_03, type Msp2_03 } from './msp2-03.js';
import { compileMsp2_04 } from './msp2-04.js';
import { compileMsp2_05 } from './msp2-05.js';
import { compileMsp2_07 } from './msp2-07.js';
import { compileMsp2_08 } from './msp2-08.js';
import { compileMsp2_09 } from './msp2-09.js';
import { compileMsp2_10 } from './msp2-10.js';
import { reportingPeriod } from './period.js';
import { validatePortfolioForms, type PortfolioForms } from './validation.js';

const SECTORS = ['agriculture', 'trade'];
const TYPES = ['business_individual_loans'];
const DISTRICTS = [{ code: 'ARU-CC', regionCode: 'ARUSHA' }];
const AS_AT = new Date('2026-03-31T00:00:00Z');
const PERIOD = reportingPeriod(2026, 1);
const AGENT_BANKS = ['crdb_bank_plc'];

/** The taxonomies as migrations 0004 and 0015 seed them. */
const MSP2_01_COMPUTED = new Set([1, 3, 8, 14, 17, 23, 26, 33, 35, 36, 42, 50, 51, 61]);
const MSP2_01_DERIVED = new Set([4, 5, 6, 7, 18, 22, 37, 38, 43, 46, 59]);

const MSP2_01_LINES: readonly StatementLine[] = Array.from({ length: 61 }, (_, index) => {
  const sno = index + 1;
  const isComputed = MSP2_01_COMPUTED.has(sno);
  return {
    sno,
    label: `MSP2-01 line ${String(sno)}`,
    isComputed,
    acceptsEntry: !isComputed && !MSP2_01_DERIVED.has(sno) && sno !== 34,
  };
});

const MSP2_05_LINES: readonly StatementLine[] = Array.from({ length: 13 }, (_, index) => {
  const sno = index + 1;
  const isComputed = new Set([1, 10, 11, 12, 13]).has(sno);
  return {
    sno,
    label: `MSP2-05 line ${String(sno)}`,
    isComputed,
    acceptsEntry: !isComputed && !new Set([2, 3, 4, 5]).has(sno),
  };
});

const MSP2_02_INCOME = new Set([2, 3, 4, 5, 6, 17, 18, 19, 20, 21, 22]);
const MSP2_02_COMPUTED = new Set([1, 7, 13, 16, 23, 40, 42]);

const MSP2_02_LINES: readonly Msp2_02Line[] = Array.from({ length: 42 }, (_, index) => {
  const sno = index + 1;
  const isComputed = MSP2_02_COMPUTED.has(sno);
  return {
    sno,
    label: `MSP2-02 line ${String(sno)}`,
    isComputed,
    entryDirection: isComputed ? null : MSP2_02_INCOME.has(sno) ? 'income' : 'expense',
  };
});

/**
 * A consistent set of forms describing one borrower with one loan.
 *
 * The balance sheet is built the way the API builds it — derived figures read
 * from the other compiled forms — and then balanced by entering capital equal
 * to total assets. Anything less would fail rule 1, which is the point of the
 * rule.
 */
function consistentForms(): PortfolioForms {
  const msp2_03 = compileMsp2_03({
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
  });

  const msp2_04 = compileMsp2_04({
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
  });

  const msp2_09 = compileMsp2_09({ sectorCodes: SECTORS, disbursements: [] });

  const msp2_10 = compileMsp2_10({
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
  });

  const msp2_02 = compileMsp2_02({
    lines: MSP2_02_LINES,
    entries: [],
    period: PERIOD,
    fiscalYearStart: '2026-01-01',
  });

  const msp2_07 = compileMsp2_07({ holdings: [] });
  const msp2_08 = compileMsp2_08({ institutionCodes: AGENT_BANKS, balances: [] });

  const derived = derivedBalanceSheetFigures({ msp2_02, msp2_03, msp2_07, msp2_08, msp2_10 });

  // Total assets come to loans net of the 1% provision: 1,000,000 − 10,000.
  // Compulsory savings are a liability (Sno46) and are derived, so the capital
  // entered has to make up the difference — 990,000 less the 50,000 of savings.
  // A sheet that does not balance is exactly what rule 1 exists to catch.
  const msp2_01 = compileMsp2_01({
    lines: MSP2_01_LINES,
    entered: new Map([[52, Money.of('940000')]]),
    derived,
  });

  const msp2_05 = compileMsp2_05({
    lines: MSP2_05_LINES,
    entered: new Map(),
    balanceSheet: msp2_01,
  });

  return { msp2_01, msp2_02, msp2_03, msp2_04, msp2_05, msp2_07, msp2_08, msp2_09, msp2_10 };
}

const blocking = (result: { findings: readonly { severity: string }[] }): number =>
  result.findings.filter((finding) => finding.severity === 'blocking').length;

describe('validatePortfolioForms', () => {
  it('passes a consistent set of forms', () => {
    const result = validatePortfolioForms(consistentForms());

    expect(blocking(result)).toBe(0);
    expect(result.submittable).toBe(true);
  });

  it('warns that a sheet of zeros balances trivially', () => {
    // Rule 1's blind spot: an untouched balance sheet passes every arithmetic
    // check BOT publishes, because nothing against nothing is equal. Whether a
    // figure was ever entered is the only thing that separates a dormant
    // institution from one that has not started.
    const forms = consistentForms();
    const empty: PortfolioForms = {
      ...forms,
      msp2_01: compileMsp2_01({
        lines: MSP2_01_LINES,
        entered: new Map(),
        derived: derivedBalanceSheetFigures(forms),
      }),
    };

    const warning = validatePortfolioForms(empty).findings.find((finding) =>
      finding.message.includes('never been filled in'),
    );

    expect(warning?.severity).toBe('warning');
  });

  it('blocks a balance sheet that does not balance', () => {
    // Rule 1, and the one check on MSP2-01 that can genuinely fail: its two
    // sides are assembled from different figures.
    const forms = consistentForms();
    const unbalanced: PortfolioForms = {
      ...forms,
      msp2_01: compileMsp2_01({
        lines: MSP2_01_LINES,
        entered: new Map([[52, Money.of('12345')]]),
        derived: derivedBalanceSheetFigures(forms),
      }),
    };

    const result = validatePortfolioForms(unbalanced);

    expect(result.submittable).toBe(false);
    expect(result.findings.some((finding) => finding.ruleId === 1)).toBe(true);
  });

  it('says how many lines are still blank when the sheet does not balance', () => {
    // The first thing to check, and the message says so rather than leaving an
    // accountant to compare two seven-figure totals by eye.
    const forms = consistentForms();
    const empty: PortfolioForms = {
      ...forms,
      msp2_01: compileMsp2_01({
        lines: MSP2_01_LINES,
        entered: new Map(),
        derived: derivedBalanceSheetFigures(forms),
      }),
    };

    const finding = validatePortfolioForms(empty).findings.find((entry) => entry.ruleId === 1);

    expect(finding?.message).toMatch(/line\(s\) have not been filled in yet/);
  });

  it('warns about a liquidity shortfall without calling the return invalid', () => {
    // A breach of BOT's 5% floor is a supervisory matter. The return is valid
    // and says the institution is short, so blocking the filing would be wrong.
    const forms = consistentForms();

    const shortfall = validatePortfolioForms(forms).findings.filter(
      (finding) => finding.ruleId === 6 && finding.severity === 'warning',
    );

    // The consistent fixture holds no cash at all against 990,000 of assets.
    expect(shortfall).toHaveLength(1);
    expect(shortfall[0]?.message).toContain('supervisory matter');
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
    const msp2_10 = compileMsp2_10({
      districts: DISTRICTS,
      exposures: [],
      presence: [],
      asAt: AS_AT,
    });

    // The balance sheet is rebuilt from the changed form, because Sno46 derives
    // from it. Replacing one without the other would fail rule 16 and test the
    // wrong thing.
    const msp2_01 = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: new Map([[52, Money.of('990000')]]),
      derived: derivedBalanceSheetFigures({ ...forms, msp2_10 }),
    });

    const withoutSavings: PortfolioForms = {
      ...forms,
      msp2_10,
      msp2_01,
      msp2_05: compileMsp2_05({
        lines: MSP2_05_LINES,
        entered: new Map(),
        balanceSheet: msp2_01,
      }),
    };

    const result = validatePortfolioForms(withoutSavings);

    const warning = result.findings.find((finding) =>
      finding.message.includes('Compulsory savings are reported as nil'),
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
