import {
  assessReportingReadiness,
  compileMsp2_02,
  compileMsp2_03,
  compileMsp2_04,
  compileMsp2_07,
  compileMsp2_08,
  compileMsp2_09,
  compileMsp2_10,
  reportingPeriod,
  validatePortfolioForms,
  type Msp2_02,
  type Msp2_03,
  type Msp2_04,
  type Msp2_07,
  type Msp2_08,
  type Msp2_09,
  type Msp2_10,
  type ReportingPeriod,
  type ValidationResult,
} from '@mfi/domain';
import { type Principal } from '@mfi/identity';
import { type AnnualisationConvention } from '@mfi/money';

import { ApiError, ruleViolation } from '../../http/errors.js';
import { type ReportRepository } from './report-repository.js';

/** A compiled quarterly return, with the verdict on whether it may be filed. */
export interface CompiledReturn {
  readonly period: ReportingPeriod;
  readonly msp2_02: Msp2_02;
  readonly msp2_03: Msp2_03;
  readonly msp2_04: Msp2_04;
  readonly msp2_07: Msp2_07;
  readonly msp2_08: Msp2_08;
  readonly msp2_09: Msp2_09;
  readonly msp2_10: Msp2_10;
  readonly validation: ValidationResult;
  /** Which forms BOT requires that this system cannot yet produce. */
  readonly unavailableForms: readonly { readonly code: string; readonly reason: string }[];
}

/** The forms not built, and why. Reported rather than omitted. */
const UNAVAILABLE_FORMS = Object.freeze([
  {
    code: 'MSP2-01',
    reason: 'The balance sheet needs the financial statements module (stage 12).',
  },
  { code: 'MSP2-05', reason: 'Liquid assets are derived from MSP2-01.' },
  { code: 'MSP2-06', reason: 'Complaints are not yet recorded (stage 14).' },
]);

/**
 * The first day of the fiscal year a quarter falls in.
 *
 * The most recent occurrence of the start month on or before the quarter, so a
 * July fiscal year puts the January quarter in the year that began the
 * preceding July. §11.8 does not say whether BOT reads the calendar year or an
 * institution's own, which is why the month is a parameter with January as its
 * stated default rather than a constant — and the window actually used comes
 * back on the compiled form.
 */
export function fiscalYearStartFor(period: ReportingPeriod, startMonth: number): string {
  const quarterStartMonth = (period.quarter - 1) * 3 + 1;
  const year = quarterStartMonth >= startMonth ? period.year : period.year - 1;
  return `${String(year).padStart(4, '0')}-${String(startMonth).padStart(2, '0')}-01`;
}

export interface CompileReturnRequest {
  readonly year: number;
  readonly quarter: number;
  readonly annualisation?: AnnualisationConvention | undefined;
  /** Month the fiscal year begins, 1-12. January unless stated. */
  readonly fiscalYearStartMonth?: number | undefined;
}

/**
 * Compile a quarterly return.
 *
 * Refuses before it computes anything when the classification the figures rest
 * on is stale. That gate is the closure of the worst defect in the system being
 * replaced: its classification job was scheduled by a `pg_cron` line left
 * commented out, so a loan forty days overdue kept reporting "Current" — to the
 * dashboard *and to the Bank of Tanzania* (analysis R5).
 *
 * A compliance product that quietly files wrong numbers is worse than one that
 * refuses to file, so this refuses. The refusal names what is wrong and what to
 * do about it, which is the difference between a gate and an obstacle.
 */
export async function compileQuarterlyReturn(
  principal: Principal,
  request: CompileReturnRequest,
  reports: ReportRepository,
  now: () => Date = () => new Date(),
): Promise<CompiledReturn> {
  const period = reportingPeriod(request.year, request.quarter);
  const at = now();

  if (period.endDate > at.toISOString().slice(0, 10)) {
    // A quarter that has not finished has no closing balances. Compiling one
    // would produce a return that looks complete and is not.
    throw ruleViolation(
      `The quarter ending ${period.endDate} has not finished, so it cannot be reported yet.`,
    );
  }

  const fiscalYearStart = fiscalYearStartFor(period, request.fiscalYearStartMonth ?? 1);

  const snapshot = await reports.snapshot(
    principal.institutionId,
    principal.userId,
    period,
    fiscalYearStart,
  );

  const unclassifiable = snapshot.classifiedExposures.filter(
    (exposure) => exposure.classification === null,
  ).length;

  const readiness = assessReportingReadiness({
    classificationsUpdatedAt: snapshot.classificationsUpdatedAt,
    unclassifiableLoanCount: unclassifiable,
    unlocatedBranchCount: snapshot.unlocatedBranchCount,
    now: at,
  });

  if (!readiness.ready) {
    throw new ApiError(
      'rule_violation',
      'This return cannot be compiled from figures in their current state.',
      readiness.problems.map((problem) => ({
        path: [problem.problem],
        message: problem.message,
      })),
    );
  }

  const msp2_02 = compileMsp2_02({
    lines: snapshot.msp2_02Lines,
    entries: snapshot.financeEntries,
    period,
    fiscalYearStart,
  });

  const msp2_07 = compileMsp2_07({ holdings: snapshot.holdings });

  const msp2_08 = compileMsp2_08({
    institutionCodes: snapshot.agentBankingCodes,
    balances: snapshot.agentBankingBalances,
  });

  const msp2_03 = compileMsp2_03({
    sectorCodes: snapshot.sectorCodes,
    exposures: snapshot.classifiedExposures,
    writeOffs: snapshot.writeOffs,
    // Nil until savings exist (stage 15). The validator warns rather than
    // assuming an institution holds no security.
    collateral: [],
  });

  const msp2_04 = compileMsp2_04({
    loanTypeCodes: snapshot.loanTypeCodes,
    exposures: snapshot.rateExposures,
    ...(request.annualisation === undefined ? {} : { annualisation: request.annualisation }),
  });

  const msp2_09 = compileMsp2_09({
    sectorCodes: snapshot.sectorCodes,
    disbursements: snapshot.disbursements,
  });

  const msp2_10 = compileMsp2_10({
    districts: snapshot.districts,
    exposures: snapshot.geographic,
    presence: snapshot.presence,
    // The age band is measured at the quarter end, which is a choice §11.4 has
    // not settled. Stated here rather than defaulted inside the compiler, so
    // it is visible at the one place a return is produced.
    asAt: new Date(`${period.endDate}T00:00:00Z`),
  });

  return {
    period,
    msp2_02,
    msp2_03,
    msp2_04,
    msp2_07,
    msp2_08,
    msp2_09,
    msp2_10,
    validation: validatePortfolioForms({ msp2_03, msp2_04, msp2_09, msp2_10 }),
    unavailableForms: UNAVAILABLE_FORMS,
  };
}
