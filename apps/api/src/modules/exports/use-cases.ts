import { reportingPeriod } from '@mfi/domain';
import { type Principal } from '@mfi/identity';

import { ruleViolation } from '../../http/errors.js';
import { type FilingRepository } from '../filings/filing-repository.js';
import { getFiling } from '../filings/use-cases.js';
import { type CellMapRepository } from './cell-map.js';
import { type ExportRepository } from './export-repository.js';
import { buildReturnPdf } from './pdf.js';
import { buildReturnWorkbook } from './workbook.js';

/**
 * Exporting a filed return as the workbook BOT accepts.
 *
 * Built from the archived document, never from a fresh compilation. The two
 * would differ — the loan book moves, a mis-keyed payment gets reversed — and
 * the file an institution uploads has to be the return it filed, not this
 * quarter's answer to the same question.
 */

export interface ReturnDocument {
  readonly filename: string;
  readonly bytes: Buffer;
}

export async function exportFiledReturn(
  principal: Principal,
  id: string,
  filings: FilingRepository,
  exports: ExportRepository,
  cellMaps: CellMapRepository,
): Promise<ReturnDocument> {
  const filing = await getFiling(principal, id, filings);
  const identity = await exports.identity(principal.institutionId, principal.userId);

  // The pre-flight check §11 promised, arriving where it bites: BOT prints the
  // MSP code at the top of all ten forms and their validator keys submissions
  // on it. A workbook without one is not a return, it is a spreadsheet.
  if (identity.mspCode === null) {
    throw ruleViolation(
      'This institution has no BOT registration code recorded, and every MSP2 form carries it. ' +
        'Add the MSP code before exporting a return.',
    );
  }

  const period = reportingPeriod(filing.year, filing.quarter);
  const [map, labels] = await Promise.all([cellMaps.load(), exports.labels()]);

  const bytes = await buildReturnWorkbook(
    filing.document,
    {
      institutionName: identity.name,
      mspCode: identity.mspCode,
      quarterEndsOn: period.endDate,
    },
    map,
    labels.institutions,
  );

  return {
    // The MSP code and the quarter, because a supervisor's inbox holds one of
    // these from every institution in the country.
    filename: `MSP2_${identity.mspCode}_${String(filing.year)}Q${String(filing.quarter)}.xlsx`,
    bytes,
  };
}

/**
 * The same return, rendered for a person rather than for BOT's validator.
 *
 * The workbook is the submission; this is the document a board signs and an
 * auditor is handed. Both come from the archived filing, so the two can never
 * disagree about what was sent.
 */
export async function exportFiledReturnPdf(
  principal: Principal,
  id: string,
  filings: FilingRepository,
  exports: ExportRepository,
): Promise<ReturnDocument> {
  const filing = await getFiling(principal, id, filings);
  const identity = await exports.identity(principal.institutionId, principal.userId);

  if (identity.mspCode === null) {
    throw ruleViolation(
      'This institution has no BOT registration code recorded, and every MSP2 form carries it. ' +
        'Add the MSP code before exporting a return.',
    );
  }

  const labels = await exports.labels();
  const bytes = await buildReturnPdf(
    filing.document,
    {
      institutionName: identity.name,
      mspCode: identity.mspCode,
      filedAt: filing.filedAt,
      filedByName: filing.filedByName,
      submissionReference: filing.submissionReference,
    },
    labels,
  );

  return {
    filename: `MSP2_${identity.mspCode}_${String(filing.year)}Q${String(filing.quarter)}.pdf`,
    bytes,
  };
}
