import { Money } from '@mfi/money';

import { type Msp2_03 } from './msp2-03.js';
import { type Msp2_04 } from './msp2-04.js';
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
  readonly msp2_03: Msp2_03;
  readonly msp2_04: Msp2_04;
  readonly msp2_09: Msp2_09;
  readonly msp2_10: Msp2_10;
}

/**
 * Check the forms this system compiles against each other.
 *
 * Only the rules whose *both* sides exist are checked. Six of BOT's eighteen
 * rules tie a portfolio form to MSP2-01 or MSP2-02, which are not built — those
 * are reported as warnings naming what is missing, rather than passed over in
 * silence. A validator that reports "no problems" while skipping half its rules
 * is worse than one that reports none at all, because it is believed.
 */
export function validatePortfolioForms(forms: PortfolioForms): ValidationResult {
  const findings: ValidationFinding[] = [
    ...checkSectorTotals(forms.msp2_03),
    ...checkBorrowerCountsAgree(forms.msp2_03, forms.msp2_04),
    ...checkNonPerformingRatio(forms.msp2_03),
    ...checkUnclassifiedExposures(forms.msp2_03),
    ...checkGenderSplitsSum(forms.msp2_09),
    ...checkGeographicSubtotals(forms.msp2_10),
    ...unavailableCrossFormRules(),
  ];

  return {
    findings,
    submittable: !findings.some((finding) => finding.severity === 'blocking'),
  };
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
        'this figure is absent rather than measured — and BOT validates it against MSP2-01 ' +
        'Sno46. Confirm the institution holds none before filing.',
    });
  }

  return findings;
}

/**
 * Rules whose other side does not exist yet.
 *
 * Reported explicitly. A compliance tool that silently skips the checks it
 * cannot perform teaches its user that a clean run means a valid return, and
 * that lesson is wrong in exactly the cases that matter.
 */
function unavailableCrossFormRules(): ValidationFinding[] {
  const unavailable: { ruleId: number; formCode: string; needs: string }[] = [
    { ruleId: 1, formCode: 'MSP2-01', needs: 'the balance sheet' },
    { ruleId: 2, formCode: 'MSP2-02', needs: 'MSP2-01’s profit and loss line' },
    { ruleId: 4, formCode: 'MSP2-04', needs: 'MSP2-01’s loans and allowance lines' },
    // Every cross-check BOT publishes for MSP2-07 and MSP2-08 ties a total to
    // a balance-sheet line, so compiling those forms does not make any of them
    // checkable. Both are produced and neither is verified against anything.
    { ruleId: 9, formCode: 'MSP2-07', needs: 'MSP2-01’s borrowings-from-banks line' },
    { ruleId: 10, formCode: 'MSP2-07', needs: 'MSP2-01’s microfinance-provider lines' },
    { ruleId: 11, formCode: 'MSP2-07', needs: 'MSP2-01’s MNO float line' },
    { ruleId: 12, formCode: 'MSP2-07', needs: 'MSP2-01’s cash-equivalent lines' },
    { ruleId: 13, formCode: 'MSP2-07', needs: 'MSP2-01’s borrowings-from-abroad line' },
    { ruleId: 14, formCode: 'MSP2-07', needs: 'MSP2-01’s balances-with-banks line' },
    { ruleId: 15, formCode: 'MSP2-08', needs: 'MSP2-01’s agent-banking line' },
    { ruleId: 16, formCode: 'MSP2-10', needs: 'MSP2-01’s compulsory savings line' },
  ];

  return unavailable.map(({ ruleId, formCode, needs }) => ({
    ruleId,
    formCode,
    severity: 'warning' as const,
    message: `Rule ${String(ruleId)} could not be checked: it requires ${needs}, which is not built.`,
  }));
}
