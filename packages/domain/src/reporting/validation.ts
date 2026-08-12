import { Money } from '@mfi/money';

import { amountAt, type Msp2_01 } from './msp2-01.js';
import { type Msp2_02 } from './msp2-02.js';
import { type Msp2_03 } from './msp2-03.js';
import { type Msp2_04 } from './msp2-04.js';
import { type Msp2_05 } from './msp2-05.js';
import { COMPLAINT_LINE, type Msp2_06 } from './msp2-06.js';
import { type Msp2_07 } from './msp2-07.js';
import { type Msp2_08 } from './msp2-08.js';
import { type Msp2_09 } from './msp2-09.js';
import { type Msp2_10 } from './msp2-10.js';

/**
 * BOT's own validation rules, checked before a return leaves the building.
 *
 * These are not this system's opinions about correctness — they are the
 * arithmetic identities BOT's template asserts, extracted from it into
 * `reference.validation_rules` and implemented here. A return that fails one is
 * a return BOT's EDI validator will reject, and finding that out at submission
 * means an institution has already spent its filing window.
 *
 * The system this replaces validated nothing: the analysis records BOT reports
 * as generated entirely in the browser and never checked against anything
 * (R10). An unvalidated regulatory return is a document whose only reviewer is
 * the regulator.
 *
 * Failures are returned rather than thrown. Several can hold at once, and an
 * operator needs to see all of them to know whether the problem is one figure
 * or the whole compilation.
 */

/** How seriously a broken rule should be taken. */
export type ValidationSeverity =
  /** BOT will reject the submission. */
  | 'blocking'
  /** The return is internally consistent but something is missing or unusual. */
  | 'warning';

export interface ValidationFinding {
  /** The rule's identifier in `reference.validation_rules`, where it has one. */
  readonly ruleId: number | null;
  readonly formCode: string;
  readonly severity: ValidationSeverity;
  readonly message: string;
}

export interface ValidationResult {
  readonly findings: readonly ValidationFinding[];
  /** True when no finding is blocking. Warnings do not stop a filing. */
  readonly submittable: boolean;
}

export interface PortfolioForms {
  readonly msp2_01: Msp2_01;
  readonly msp2_02: Msp2_02;
  readonly msp2_03: Msp2_03;
  readonly msp2_04: Msp2_04;
  readonly msp2_05: Msp2_05;
  readonly msp2_06: Msp2_06;
  readonly msp2_07: Msp2_07;
  readonly msp2_08: Msp2_08;
  readonly msp2_09: Msp2_09;
  readonly msp2_10: Msp2_10;
}

/** The MSP2-01 lines BOT's rules address by number. */
const SNO = {
  cashInHand: 2,
  balancesWithBanks: 3,
  agentBanking: 5,
  balancesWithMsps: 6,
  mnoFloat: 7,
  loansNet: 17,
  allowance: 22,
  totalAssets: 33,
  borrowingsFromBanksTz: 37,
  borrowingsFromMsps: 38,
  borrowingsAbroad: 43,
  compulsorySavings: 46,
  profitOrLoss: 59,
  totalLiabilitiesAndCapital: 61,
} as const;

/** MSP2-02's net income after tax, which rule 2 reads on the YTD column. */
const NET_INCOME_AFTER_TAX_SNO = 42;

/**
 * Check the forms this system compiles against each other.
 *
 * All eighteen of BOT's published rules are checked here, along with four
 * warnings that are this system's own and are marked as such by carrying no
 * rule id. Honesty about that matters: most of the eighteen hold *by
 * construction* — their two sides are derived from the same figures — so this
 * is not eighteen independent confirmations that a return is right. It is
 * eighteen ways a future change could be caught breaking one.
 */
export function validatePortfolioForms(forms: PortfolioForms): ValidationResult {
  const findings: ValidationFinding[] = [
    ...checkBalanceSheetBalances(forms.msp2_01),
    ...checkBalanceSheetCompleteness(forms.msp2_01),
    ...checkNetIncomeAgreesWithBalanceSheet(forms.msp2_01, forms.msp2_02),
    ...checkGrossLoansAgree(forms.msp2_01, forms.msp2_04),
    ...checkLiquidAssetsRestateBalanceSheet(forms.msp2_01, forms.msp2_05),
    ...checkLiquidityRequirement(forms.msp2_05),
    ...checkBankBalancesAgree(forms.msp2_01, forms.msp2_07, forms.msp2_08),
    ...checkCompulsorySavingsAgree(forms.msp2_01, forms.msp2_10),
    ...checkSectorTotals(forms.msp2_03),
    ...checkBorrowerCountsAgree(forms.msp2_03, forms.msp2_04),
    ...checkNonPerformingRatio(forms.msp2_03),
    ...checkUnclassifiedExposures(forms.msp2_03),
    ...checkComplaintNatureSplits(forms.msp2_06),
    ...checkComplaintRollForward(forms.msp2_06),
    ...checkGenderSplitsSum(forms.msp2_09),
    ...checkGeographicSubtotals(forms.msp2_10),
  ];

  return {
    findings,
    submittable: !findings.some((finding) => finding.severity === 'blocking'),
  };
}

/**
 * Rule 7 — on every line, the count must equal the sum of the six nature
 * columns.
 *
 * Holds by construction: the compiler derives both from one set of complaints,
 * and a complaint carries exactly one nature. Checked anyway, because "holds by
 * construction" is a statement about today's compiler and this is a statement
 * about BOT's form.
 */
function checkComplaintNatureSplits(form: Msp2_06): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const row of form.rows) {
    const split = [...row.byNature.values()].reduce((sum, count) => sum + count, 0);
    if (split !== row.count) {
      findings.push({
        ruleId: 7,
        formCode: 'MSP2-06',
        severity: 'blocking',
        message:
          `Sno${String(row.sno)} counts ${String(row.count)} complaints but its nature columns ` +
          `sum to ${String(split)}. BOT validates this identity on every line.`,
      });
    }
  }

  return findings;
}

/**
 * Rule 8 — the closing line must equal the roll-forward.
 *
 * The compiler derives the closing line from the records rather than from this
 * arithmetic, so the two are independent statements that happen to agree. They
 * agree because a complaint cannot be resolved before it was received, which is
 * a database constraint rather than a property of this function — and a
 * migration could weaken it without this file noticing. So it is checked.
 */
function checkComplaintRollForward(form: Msp2_06): ValidationFinding[] {
  const countAt = (sno: number): number => form.rows.find((row) => row.sno === sno)?.count ?? 0;

  const expected =
    countAt(COMPLAINT_LINE.opening) +
    countAt(COMPLAINT_LINE.received) -
    countAt(COMPLAINT_LINE.resolvedByInstitution) -
    countAt(COMPLAINT_LINE.resolvedByOtherParties);
  const closing = countAt(COMPLAINT_LINE.unresolvedAtEnd);

  if (closing === expected) {
    return [];
  }

  return [
    {
      ruleId: 8,
      formCode: 'MSP2-06',
      severity: 'blocking',
      message:
        `Sno5 reports ${String(closing)} unresolved complaints at the quarter end, and the ` +
        `roll-forward gives ${String(expected)}. BOT computes this line from the four above it, ` +
        'so their template would show a different figure from the one compiled here.',
    },
  ];
}

/** Rule 17 — per sector, the class buckets must sum to the total outstanding. */
function checkSectorTotals(form: Msp2_03): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const row of [...form.rows, form.total]) {
    const summed = Money.sum(Object.values(row.outstandingByClass));
    if (!summed.equals(row.totalOutstanding)) {
      findings.push({
        ruleId: 17,
        formCode: 'MSP2-03',
        severity: 'blocking',
        message:
          `Sector ${row.sectorCode}: the classification columns sum to ` +
          `${summed.toDatabaseValue()} but total outstanding is ` +
          `${row.totalOutstanding.toDatabaseValue()}. BOT validates this identity.`,
      });
    }
  }

  return findings;
}

/**
 * Rule 3 — MSP2-03's borrower total must equal MSP2-04's.
 *
 * The two forms count the same borrowers through different dimensions, so a
 * mismatch means an exposure is on one form and not the other — a loan whose
 * client has a sector but whose product has no BOT loan type, or the reverse.
 * That is a data problem, not an arithmetic one, and it is exactly what this
 * rule exists to surface.
 */
function checkBorrowerCountsAgree(sectoral: Msp2_03, rates: Msp2_04): ValidationFinding[] {
  if (sectoral.total.borrowerCount === rates.total.borrowerCount) {
    return [];
  }

  return [
    {
      ruleId: 3,
      formCode: 'MSP2-03',
      severity: 'blocking',
      message:
        `MSP2-03 reports ${String(sectoral.total.borrowerCount)} borrowers and MSP2-04 reports ` +
        `${String(rates.total.borrowerCount)}. The same borrowers are counted by sector on one ` +
        'form and by loan type on the other, so a difference means an exposure is missing from one.',
    },
  ];
}

/** Rule 18 — the reported NPL ratio must be the one the columns imply. */
function checkNonPerformingRatio(form: Msp2_03): ValidationFinding[] {
  const total = form.total.totalOutstanding;
  if (total.isZero()) {
    return form.nonPerformingRatio.isZero()
      ? []
      : [
          {
            ruleId: 18,
            formCode: 'MSP2-03',
            severity: 'blocking',
            message:
              'A book with nothing outstanding cannot have a non-performing ratio above zero.',
          },
        ];
  }

  const nonPerforming = Money.sum([
    form.total.outstandingByClass.substandard,
    form.total.outstandingByClass.doubtful,
    form.total.outstandingByClass.loss,
  ]);
  const expected = nonPerforming.dividedByExact(total.toDatabaseValue()).times(100);

  if (form.nonPerformingRatio.toDecimal().equals(expected)) {
    return [];
  }

  return [
    {
      ruleId: 18,
      formCode: 'MSP2-03',
      severity: 'blocking',
      message:
        `The reported non-performing ratio (${form.nonPerformingRatio.toFixed(4)}%) is not ` +
        `(Substandard + Doubtful + Loss) ÷ Total Outstanding × 100 (${expected.toFixed(4)}%).`,
    },
  ];
}

/**
 * Exposures no provisioning band covers.
 *
 * Not one of BOT's rules, because BOT's template has no column for a loan
 * outside its bands — which is precisely the problem. A housing loan 40 days
 * overdue falls in the gap the housing schedule leaves below 91 days (§11.5),
 * and there is nowhere on the return to put it.
 *
 * Blocking. The alternative is filing a portfolio total that is quietly short
 * by however much those loans are worth.
 */
function checkUnclassifiedExposures(form: Msp2_03): ValidationFinding[] {
  if (form.unclassifiableLoanCount === 0) {
    return [];
  }

  return [
    {
      ruleId: null,
      formCode: 'MSP2-03',
      severity: 'blocking',
      message:
        `${String(form.unclassifiableLoanCount)} loan(s) fall outside every provisioning band and ` +
        'appear on no row of this form, so the reported portfolio is short by their value. ' +
        'BOT’s housing schedule defines nothing below 91 days — see 02-BOT-REPORTING-SPEC.md §11.5.',
    },
  ];
}

/** Each sector's total must be its female and male columns added together. */
function checkGenderSplitsSum(form: Msp2_09): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  for (const row of [...form.rows, form.total]) {
    const expectedCount = row.female.count + row.male.count;
    const expectedAmount = row.female.amount.plus(row.male.amount);

    if (row.total.count !== expectedCount || !row.total.amount.equals(expectedAmount)) {
      findings.push({
        ruleId: null,
        formCode: 'MSP2-09',
        severity: 'blocking',
        message:
          `Sector ${row.sectorCode}: the total column does not equal the female and male ` +
          'columns added together.',
      });
    }
  }

  return findings;
}

/** Region subtotals and the grand total must agree with the district rows. */
function checkGeographicSubtotals(form: Msp2_10): ValidationFinding[] {
  const findings: ValidationFinding[] = [];

  const districtOutstanding = Money.sum(form.districts.map((row) => row.totalOutstanding));
  if (!form.grandTotal.totalOutstanding.equals(districtOutstanding)) {
    findings.push({
      ruleId: null,
      formCode: 'MSP2-10',
      severity: 'blocking',
      message:
        'The grand total does not equal the district rows added together, so a district is ' +
        'either missing from the total or counted twice.',
    });
  }

  const regionOutstanding = Money.sum(form.regions.map((region) => region.totalOutstanding));
  if (!regionOutstanding.equals(districtOutstanding)) {
    findings.push({
      ruleId: null,
      formCode: 'MSP2-10',
      severity: 'blocking',
      message: 'The region subtotals do not add up to the district rows.',
    });
  }

  if (form.grandTotal.compulsorySavings.isZero()) {
    findings.push({
      ruleId: 16,
      formCode: 'MSP2-10',
      severity: 'warning',
      message:
        'Compulsory savings are reported as nil. Savings are not yet modelled (stage 15), so ' +
        'this figure is absent rather than measured. Rule 16 passes, but only because MSP2-01 ' +
        'Sno46 is derived from this same nil — the two agree without either being observed. ' +
        'Confirm the institution holds none before filing.',
    });
  }

  return findings;
}

/** Two amounts that BOT requires to be equal, reported when they are not. */
function requireEqual(
  ruleId: number | null,
  formCode: string,
  what: string,
  left: Money,
  right: Money,
): ValidationFinding[] {
  if (left.equals(right)) {
    return [];
  }

  return [
    {
      ruleId,
      formCode,
      severity: 'blocking',
      message:
        `${what}: ${left.toDatabaseValue()} against ${right.toDatabaseValue()}. ` +
        'BOT validates this identity.',
    },
  ];
}

/**
 * Rule 1 — the balance sheet must balance.
 *
 * The one check on MSP2-01 that can genuinely fail. Most of the others hold by
 * construction now that their lines are derived from the same figures the other
 * forms report; this one compares two sides assembled from different inputs,
 * and an incomplete sheet fails it. That is the intended behaviour: a balance
 * sheet still being filled in is not one that may be filed.
 */
function checkBalanceSheetBalances(form: Msp2_01): ValidationFinding[] {
  const assets = amountAt(form, SNO.totalAssets);
  const liabilitiesAndCapital = amountAt(form, SNO.totalLiabilitiesAndCapital);

  if (assets.equals(liabilitiesAndCapital)) {
    return [];
  }

  const outstanding = form.missingEntries.length;

  return [
    {
      ruleId: 1,
      formCode: 'MSP2-01',
      severity: 'blocking',
      message:
        `Total assets (${assets.toDatabaseValue()}) do not equal total liabilities and capital ` +
        `(${liabilitiesAndCapital.toDatabaseValue()}). BOT enforces this identity.` +
        (outstanding === 0
          ? ''
          : ` ${String(outstanding)} line(s) have not been filled in yet, which is the first ` +
            'thing to check.'),
    },
  ];
}

/**
 * Lines nobody has filled in.
 *
 * Not one of BOT's rules, and it exists because rule 1 has a blind spot: an
 * entirely empty balance sheet balances, at zero against zero. A dormant
 * institution genuinely files zeros, and one that has simply not started filling
 * the form in files the same document — the two are indistinguishable to every
 * arithmetic check BOT publishes.
 *
 * Whether a figure was ever entered is the only thing that separates them, so
 * that is what this reports. A warning rather than a block: a line may be
 * legitimately nil and never touched, and refusing to file on that basis would
 * be wrong.
 */
function checkBalanceSheetCompleteness(form: Msp2_01): ValidationFinding[] {
  if (form.missingEntries.length === 0) {
    return [];
  }

  return [
    {
      ruleId: null,
      formCode: 'MSP2-01',
      severity: 'warning',
      message:
        `${String(form.missingEntries.length)} balance sheet line(s) have never been filled in ` +
        'and are reported as nil. A sheet of zeros balances trivially, so BOT’s arithmetic ' +
        'checks cannot tell an institution with nothing to report from one that has not started.',
    },
  ];
}

/** Rule 2 — MSP2-02's year-to-date net income is the balance sheet's profit. */
function checkNetIncomeAgreesWithBalanceSheet(
  balanceSheet: Msp2_01,
  income: Msp2_02,
): ValidationFinding[] {
  const netIncome =
    income.rows.find((row) => row.sno === NET_INCOME_AFTER_TAX_SNO)?.yearToDateAmount ??
    Money.zero();

  return requireEqual(
    2,
    'MSP2-02',
    'Net income after tax year-to-date does not match the balance sheet’s profit line',
    netIncome,
    amountAt(balanceSheet, SNO.profitOrLoss),
  );
}

/** Rule 4 — MSP2-04's total outstanding is gross loans: net plus allowance. */
function checkGrossLoansAgree(balanceSheet: Msp2_01, rates: Msp2_04): ValidationFinding[] {
  const gross = amountAt(balanceSheet, SNO.loansNet).plus(amountAt(balanceSheet, SNO.allowance));

  return requireEqual(
    4,
    'MSP2-04',
    'Total outstanding does not equal the balance sheet’s loans net plus its allowance',
    rates.total.totalOutstanding,
    gross,
  );
}

/** Rule 5 — MSP2-05's first four lines restate MSP2-01. */
function checkLiquidAssetsRestateBalanceSheet(
  balanceSheet: Msp2_01,
  liquid: Msp2_05,
): ValidationFinding[] {
  const restated: readonly [number, number, string][] = [
    [2, SNO.cashInHand, 'Cash in hand'],
    [3, SNO.balancesWithBanks, 'Balances with banks'],
    [4, SNO.balancesWithMsps, 'Balances with microfinance service providers'],
    [5, SNO.mnoFloat, 'MNO float balances'],
  ];

  return restated.flatMap(([liquidSno, balanceSno, what]) =>
    requireEqual(
      5,
      'MSP2-05',
      `${what} does not match MSP2-01`,
      liquid.rows.find((row) => row.sno === liquidSno)?.amount ?? Money.zero(),
      amountAt(balanceSheet, balanceSno),
    ),
  );
}

/**
 * Rule 6 — the liquidity computation, and the floor it measures against.
 *
 * The arithmetic is checked, and separately the prudential outcome is reported.
 * A breach is not a filing error — the return is valid and says the institution
 * is short — so it is a warning here and a supervisory matter there. Reporting
 * it at all is the point: §6 of the reporting specification is explicit that
 * discovering a shortfall at submission is too late to act on.
 */
function checkLiquidityRequirement(form: Msp2_05): ValidationFinding[] {
  const findings = requireEqual(
    6,
    'MSP2-05',
    'Excess liquid assets is not available less the required minimum',
    form.excess,
    form.availableLiquidAssets.minus(form.requiredMinimum),
  );

  if (!form.meetsRequirement) {
    findings.push({
      ruleId: 6,
      formCode: 'MSP2-05',
      severity: 'warning',
      message:
        `Liquid assets are ${form.excess.abs().toDatabaseValue()} below BOT’s 5% minimum ` +
        `(${form.requiredMinimum.toDatabaseValue()} required, ` +
        `${form.availableLiquidAssets.toDatabaseValue()} available). The return is valid and ` +
        'says so; the shortfall is a supervisory matter, not a filing error.',
    });
  }

  return findings;
}

/** Rules 9 to 15 — every balance held elsewhere, tied to the balance sheet. */
function checkBankBalancesAgree(
  balanceSheet: Msp2_01,
  holdings: Msp2_07,
  agentBanking: Msp2_08,
): ValidationFinding[] {
  const subtotal = (kind: Msp2_07['sections'][number]['kind']): Msp2_07['total'] | undefined =>
    holdings.sections.find((section) => section.kind === kind)?.subtotal;

  const banks = subtotal('bank_tanzania');
  const msps = subtotal('microfinance_service_provider');
  const mnos = subtotal('mno');
  const abroad = subtotal('bank_abroad');
  const nil = Money.zero();

  return [
    ...requireEqual(
      9,
      'MSP2-07',
      'Borrowings from banks in Tanzania do not match the balance sheet',
      banks?.borrowingTotal ?? nil,
      amountAt(balanceSheet, SNO.borrowingsFromBanksTz),
    ),
    ...requireEqual(
      10,
      'MSP2-07',
      'Balances with microfinance service providers do not match the balance sheet',
      msps?.depositTotal ?? nil,
      amountAt(balanceSheet, SNO.balancesWithMsps),
    ),
    ...requireEqual(
      10,
      'MSP2-07',
      'Borrowings from microfinance service providers do not match the balance sheet',
      msps?.borrowingTotal ?? nil,
      amountAt(balanceSheet, SNO.borrowingsFromMsps),
    ),
    ...requireEqual(
      11,
      'MSP2-07',
      'MNO float balances do not match the balance sheet',
      mnos?.depositTotal ?? nil,
      amountAt(balanceSheet, SNO.mnoFloat),
    ),
    ...requireEqual(
      13,
      'MSP2-07',
      'Borrowings from banks abroad do not match the balance sheet',
      abroad?.borrowingTotal ?? nil,
      amountAt(balanceSheet, SNO.borrowingsAbroad),
    ),
    ...requireEqual(
      14,
      'MSP2-07',
      'Deposits with banks do not match the balance sheet’s bank balances',
      banks?.depositTotal ?? nil,
      amountAt(balanceSheet, SNO.balancesWithBanks),
    ),
    ...requireEqual(
      15,
      'MSP2-08',
      'Total agent-banking balances do not match the balance sheet',
      agentBanking.total,
      amountAt(balanceSheet, SNO.agentBanking),
    ),
  ];
}

/** Rule 16 — MSP2-10's compulsory savings tie to the balance sheet. */
function checkCompulsorySavingsAgree(
  balanceSheet: Msp2_01,
  geography: Msp2_10,
): ValidationFinding[] {
  return requireEqual(
    16,
    'MSP2-10',
    'Compulsory savings do not match the balance sheet',
    geography.grandTotal.compulsorySavings,
    amountAt(balanceSheet, SNO.compulsorySavings),
  );
}
