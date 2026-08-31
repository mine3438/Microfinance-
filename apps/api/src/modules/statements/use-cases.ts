import { type Msp2_01, type Msp2_05, type StatementForm } from '@mfi/contracts';
import { reportingPeriod } from '@mfi/domain';
import { type Principal } from '@mfi/identity';

import { ApiError } from '../../http/errors.js';
import { presentMsp2_01, presentMsp2_05 } from '../reporting/presentation.js';
import { type ReportRepository } from '../reporting/report-repository.js';
import { compileForms, fiscalYearStartFor } from '../reporting/use-cases.js';
import { type StatementRepository } from './statement-repository.js';

/**
 * Preparing a quarterly statement.
 *
 * The form comes back compiled — derived lines filled in from the loan book and
 * the other MSP2 forms, totals rolled up — so an accountant sees the balance
 * sheet move as figures are entered rather than discovering at submission that
 * it does not balance.
 *
 * **No freshness gate here.** Compiling a *return* refuses when overdue
 * classifications are stale, because filing on stale figures is the defect this
 * system exists to prevent. Typing last quarter's rent into a balance sheet is
 * not filing, and blocking it would make the gate an obstacle rather than a
 * control. The gate stays where the filing happens.
 */

export interface StatementView {
  readonly form: StatementForm;
  readonly year: number;
  readonly quarter: number;
  readonly msp2_01?: Msp2_01;
  readonly msp2_05?: Msp2_05;
}

async function compile(
  principal: Principal,
  form: StatementForm,
  year: number,
  quarter: number,
  reports: ReportRepository,
): Promise<StatementView> {
  const period = reportingPeriod(year, quarter);
  // The calendar year, because a statement screen is not a filing and the
  // year-to-date column it feeds is only read on MSP2-02. §11.8's question is
  // answered at the point a return is compiled, where the choice is visible.
  const fiscalYearStart = fiscalYearStartFor(period, 1);

  const snapshot = await reports.snapshot(
    principal.institutionId,
    principal.userId,
    period,
    fiscalYearStart,
  );
  const forms = compileForms(snapshot, period, fiscalYearStart);

  return form === 'MSP2-01'
    ? { form, year, quarter, msp2_01: presentMsp2_01(forms.msp2_01) }
    : { form, year, quarter, msp2_05: presentMsp2_05(forms.msp2_05) };
}

export async function viewStatement(
  principal: Principal,
  form: StatementForm,
  year: number,
  quarter: number,
  reports: ReportRepository,
): Promise<StatementView> {
  return compile(principal, form, year, quarter, reports);
}

/**
 * Save figures and hand back the form they produce.
 *
 * Returning the compiled statement rather than an acknowledgement is the whole
 * point: every total that moved is visible immediately, and so is a balance
 * sheet that has stopped balancing.
 *
 * @throws {ApiError} `validation_failed` naming `sno` when a line does not
 * accept entry — checked here so the message says which line and why, with the
 * database constraint underneath as the floor.
 */
export async function saveStatementLines(
  principal: Principal,
  form: StatementForm,
  year: number,
  quarter: number,
  lines: readonly { readonly sno: number; readonly amount: string }[],
  statements: StatementRepository,
  reports: ReportRepository,
): Promise<StatementView> {
  const duplicated = lines
    .map((line) => line.sno)
    .filter((sno, index, all) => all.indexOf(sno) !== index);

  if (duplicated.length > 0) {
    throw new ApiError(
      'validation_failed',
      `Line ${String(duplicated[0])} appears more than once, so which figure to keep is undefined.`,
      [{ path: ['lines'], message: 'Each line may appear once per request.' }],
    );
  }

  // Checked here so the refusal names the line and says why. The composite
  // foreign key underneath refuses the same rows, but a key that did not
  // resolve says nothing an accountant could act on.
  const taxonomy = await statements.formLines(principal.institutionId, principal.userId, form);

  for (const line of lines) {
    const known = taxonomy.find((candidate) => candidate.sno === line.sno);

    if (known === undefined) {
      throw new ApiError('validation_failed', `${form} has no line numbered ${String(line.sno)}.`, [
        { path: ['lines'], message: `BOT does not publish line ${String(line.sno)}.` },
      ]);
    }

    if (!known.acceptsEntry) {
      const why = known.isComputed
        ? 'BOT’s template computes it from the lines beneath it'
        : 'this system derives it from figures it already holds, and a second answer could ' +
          'disagree with the first on a filed return';

      throw new ApiError('validation_failed', `“${known.label}” is not entered: ${why}.`, [
        { path: ['lines'], message: `Line ${String(line.sno)} does not accept a figure.` },
      ]);
    }
  }

  await statements.saveLines(principal.institutionId, principal.userId, form, year, quarter, lines);

  return compile(principal, form, year, quarter, reports);
}
