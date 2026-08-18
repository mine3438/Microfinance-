import {
  ANNUALISATION_CONVENTIONS,
  type AnnualisationConvention,
  type CompiledReturn,
} from '@mfi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { reports as reportsApi } from '../../shared/api/endpoints.js';
import { formatDate, formatQuarter } from '../../shared/lib/format.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { ReturnForms } from './return-forms.js';

/**
 * The BOT MSP2 quarterly return.
 *
 * The screen is built around a fact that is easy to design away: **this report
 * refuses more often than it succeeds, and the refusals are the product.** A
 * return compiled from stale classifications is a return that misstates the
 * portfolio to the Bank of Tanzania, which is precisely the failure the system
 * being replaced shipped with (analysis R5). So a refusal is rendered as a
 * first-class outcome with each problem named and a stated remedy — not as a
 * red toast that invites another click.
 *
 * Nothing here computes a figure. The API returns a finished return; this
 * displays it.
 */

/** The quarters BOT files, as the selector offers them. */
const QUARTER_OPTIONS = [1, 2, 3, 4] as const;

/**
 * The most recent quarter that has actually ended.
 *
 * A quarter still running has no closing balances, and the API refuses to
 * compile one — so defaulting to "this quarter" would open the screen on an
 * error every time. Calendar arithmetic only; no financial figure is derived
 * here.
 */
export function lastCompletedQuarter(now: Date = new Date()): { year: number; quarter: number } {
  const quarterOfNow = Math.floor(now.getUTCMonth() / 3) + 1;
  return quarterOfNow === 1
    ? { year: now.getUTCFullYear() - 1, quarter: 4 }
    : { year: now.getUTCFullYear(), quarter: quarterOfNow - 1 };
}

/** Years offered, newest first, back as far as a return could exist. */
function selectableYears(now: Date = new Date()): number[] {
  const latest = lastCompletedQuarter(now).year;
  return Array.from({ length: 6 }, (_, index) => latest - index);
}

interface Selection {
  readonly year: number;
  readonly quarter: number;
  readonly annualisation: AnnualisationConvention;
}

export function ReportsPage(): ReactNode {
  const initial = lastCompletedQuarter();

  const [draft, setDraft] = useState<Selection>({ ...initial, annualisation: 'simple' });
  // Held separately from the draft so changing a dropdown does not recompile.
  // Compiling walks the whole loan book; it happens when asked for.
  const [applied, setApplied] = useState<Selection>({ ...initial, annualisation: 'simple' });

  const query = useQuery({
    queryKey: ['msp2-return', applied],
    queryFn: () => reportsApi.quarterlyReturn(applied.year, applied.quarter, applied.annualisation),
    // A compiled return is a statement about a closed quarter. It changes only
    // when the underlying book is corrected, so refetching it on every window
    // focus would re-run a portfolio-wide computation for no new answer.
    refetchOnWindowFocus: false,
    retry: false,
  });

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">BOT quarterly return</h1>
          <p className="page__subtitle">
            MSP2 forms for {formatQuarter(applied.year, applied.quarter)}
          </p>
        </div>
      </div>

      <Panel title="Period">
        <form
          className="report-controls"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied(draft);
          }}
        >
          <label className="field" htmlFor="report-year">
            <span className="field__label">Year</span>
            <select
              id="report-year"
              className="input"
              value={draft.year}
              onChange={(event) => {
                setDraft((current) => ({ ...current, year: Number(event.target.value) }));
              }}
            >
              {selectableYears().map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="report-quarter">
            <span className="field__label">Quarter</span>
            <select
              id="report-quarter"
              className="input"
              value={draft.quarter}
              onChange={(event) => {
                setDraft((current) => ({ ...current, quarter: Number(event.target.value) }));
              }}
            >
              {QUARTER_OPTIONS.map((quarter) => (
                <option key={quarter} value={quarter}>
                  Q{quarter}
                </option>
              ))}
            </select>
          </label>

          <Field
            id="report-annualisation"
            label="Rate conversion"
            hint="Whether BOT reads a monthly rate as simple or compounded is unconfirmed (§11.2)."
          >
            {(props) => (
              <select
                {...props}
                className="input"
                value={draft.annualisation}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    annualisation: event.target.value as AnnualisationConvention,
                  }));
                }}
              >
                {ANNUALISATION_CONVENTIONS.map((convention) => (
                  <option key={convention} value={convention}>
                    {convention === 'simple' ? 'Simple (×12)' : 'Effective (compounded)'}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <div className="report-controls__action">
            <button className="button button--primary" type="submit" disabled={query.isFetching}>
              {query.isFetching ? 'Compiling…' : 'Compile'}
            </button>
          </div>
        </form>
      </Panel>

      {query.isPending && <Spinner label="Compiling the return" />}

      {query.error !== null && <CompilationRefusal error={query.error} />}

      {query.data !== undefined && (
        <>
          <ReturnSummary compiled={query.data} />
          <ReturnForms compiled={query.data} />
        </>
      )}
    </div>
  );
}

/**
 * Why a return could not be compiled.
 *
 * A 422 from this endpoint carries one detail per problem — classifications
 * never run, classifications stale, loans outside every provisioning band,
 * branches with no district — each with a message saying what to do. Collapsing
 * that into a single line would leave an operator fixing one problem per
 * filing window, which is not a workable pace when the window is a fortnight.
 *
 * Anything that is not a stated business refusal falls through to the shared
 * notice, which knows when to show a correlation ID and when not to.
 */
function CompilationRefusal({ error }: { error: unknown }): ReactNode {
  if (!(error instanceof ApiRequestError) || error.code !== 'rule_violation') {
    return <ErrorNotice error={error} />;
  }

  return (
    <Panel title="This return cannot be filed yet" tone="danger">
      <p className="notice__message">{error.message}</p>

      {error.details.length > 0 && (
        <ul className="problem-list">
          {error.details.map((detail) => (
            <li key={`${detail.path.join('.')}-${detail.message}`}>{detail.message}</li>
          ))}
        </ul>
      )}

      <p className="hint-block">
        Nothing has been filed and nothing has changed. The figures are refused rather than
        estimated: a return that looks complete and is wrong is worse than one that is late.
      </p>
    </Panel>
  );
}

/** How many forms a complete MSP2 submission carries. */
const FORMS_IN_A_FULL_RETURN = 10;

/** The verdict, the validation findings, and the forms that are missing. */
function ReturnSummary({ compiled }: { compiled: CompiledReturn }): ReactNode {
  const blocking = compiled.validation.findings.filter(
    (finding) => finding.severity === 'blocking',
  );
  const warnings = compiled.validation.findings.filter((finding) => finding.severity === 'warning');

  return (
    <Panel
      title={compiled.validation.submittable ? 'Ready to submit' : 'Not valid for submission'}
      tone={compiled.validation.submittable ? 'success' : 'danger'}
    >
      <dl className="totals">
        <div>
          <dt>Period</dt>
          <dd>
            {formatDate(compiled.period.startDate)} to {formatDate(compiled.period.endDate)}
          </dd>
        </div>
        <div>
          <dt>Forms compiled</dt>
          {/* Counted from what the server said is missing, not written in.
              A hard-coded "4 of 10" would keep saying four after a fifth is
              built, and the number an operator trusts would be the stale one. */}
          <dd>
            {FORMS_IN_A_FULL_RETURN - compiled.unavailableForms.length} of {FORMS_IN_A_FULL_RETURN}
          </dd>
        </div>
      </dl>

      {blocking.length > 0 && (
        <>
          <h3 className="allocation__title">
            {blocking.length} rule{blocking.length === 1 ? '' : 's'} BOT will reject
          </h3>
          <ul className="problem-list">
            {blocking.map((finding) => (
              <li key={`${finding.formCode}-${String(finding.ruleId)}-${finding.message}`}>
                <strong>{finding.formCode}</strong> {finding.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {warnings.length > 0 && (
        <>
          <h3 className="allocation__title">Checks that could not be completed</h3>
          <ul className="problem-list problem-list--muted">
            {warnings.map((finding) => (
              <li key={`${finding.formCode}-${String(finding.ruleId)}-${finding.message}`}>
                <strong>{finding.formCode}</strong> {finding.message}
              </li>
            ))}
          </ul>
        </>
      )}

      {compiled.unavailableForms.length > 0 && (
        <>
          <h3 className="allocation__title">Forms this system cannot yet produce</h3>
          <ul className="problem-list problem-list--muted">
            {compiled.unavailableForms.map((form) => (
              <li key={form.code}>
                <strong>{form.code}</strong> {form.reason}
              </li>
            ))}
          </ul>
          <p className="hint-block">
            A full MSP2 submission is ten forms. These are listed so that a screen showing four is
            never mistaken for a complete return.
          </p>
        </>
      )}
    </Panel>
  );
}
