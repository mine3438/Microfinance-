import { type FileReturnRequest, type FiledReturn, type FiledReturnDetail } from '@mfi/contracts';
import { type Principal } from '@mfi/identity';

import { ApiError, notFound } from '../../http/errors.js';
import { presentCompiledReturn } from '../reporting/presentation.js';
import { type ReportRepository } from '../reporting/report-repository.js';
import { compileQuarterlyReturn } from '../reporting/use-cases.js';
import { type FilingRepository } from './filing-repository.js';

/**
 * Filing a return, and reading one back.
 *
 * Two refusals stand between a compilation and a filing, and both are the
 * product rather than obstacles in front of it:
 *
 * 1. The **freshness gate**, inside the compilation — a return resting on stale
 *    classifications is the failure this system exists to prevent (R5).
 * 2. **BOT's own validation rules.** A return with a blocking finding is one
 *    BOT's EDI validator will reject, and filing it spends an institution's
 *    submission window to learn something this system already knew.
 *
 * What is archived is the compiled document itself, not the inputs to it.
 * Recompiling a past quarter later would produce a different answer — the loan
 * book moves, a mis-keyed payment gets reversed — and an institution asked to
 * explain a filed figure needs the document it sent.
 */

export async function fileReturn(
  principal: Principal,
  year: number,
  quarter: number,
  request: FileReturnRequest,
  reports: ReportRepository,
  filings: FilingRepository,
  now: () => Date = () => new Date(),
): Promise<FiledReturnDetail> {
  const compiled = await compileQuarterlyReturn(
    principal,
    {
      year,
      quarter,
      ...(request.annualisation === undefined ? {} : { annualisation: request.annualisation }),
      ...(request.fiscalYearStartMonth === undefined
        ? {}
        : { fiscalYearStartMonth: request.fiscalYearStartMonth }),
    },
    reports,
    now,
  );

  if (!compiled.validation.submittable) {
    const blocking = compiled.validation.findings.filter(
      (finding) => finding.severity === 'blocking',
    );

    throw new ApiError(
      'rule_violation',
      `This return breaks ${String(blocking.length)} of BOT’s own validation rules, so it would ` +
        'be rejected at submission. Filing it would spend the window and tell you nothing new.',
      blocking.map((finding) => ({
        path: [finding.formCode],
        message: finding.message,
      })),
    );
  }

  const document = presentCompiledReturn(compiled);
  const formCodes = Object.keys(document)
    .filter((key) => key.startsWith('msp2_'))
    // `msp2_03` is BOT's `MSP2-03`. The wire shape uses underscores because a
    // hyphen is not an identifier; the filing records BOT's own spelling.
    .map((key) => key.replace('msp2_', 'MSP2-'))
    .sort();

  return filings.archive(principal.institutionId, principal.userId, {
    year,
    quarter,
    document,
    formCodes,
    findingCount: compiled.validation.findings.length,
  });
}

export async function listFilings(
  principal: Principal,
  filings: FilingRepository,
): Promise<FiledReturn[]> {
  return filings.list(principal.institutionId, principal.userId);
}

export async function getFiling(
  principal: Principal,
  id: string,
  filings: FilingRepository,
): Promise<FiledReturnDetail> {
  const filing = await filings.find(principal.institutionId, principal.userId, id);
  if (filing === null) {
    throw notFound('That filing does not exist.');
  }
  return filing;
}

/**
 * Record BOT's acknowledgement against a filing.
 *
 * The only part of a filing that may change after the fact, and the database
 * enforces that with a trigger rather than trusting this function: the document,
 * the period, who filed it and when are all immutable once written.
 */
export async function recordSubmissionReference(
  principal: Principal,
  id: string,
  reference: string,
  filings: FilingRepository,
): Promise<FiledReturn> {
  return filings.recordSubmissionReference(
    principal.institutionId,
    principal.userId,
    id,
    reference,
  );
}
