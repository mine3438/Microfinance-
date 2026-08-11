import {
  STATEMENT_FORMS,
  type Msp2_01,
  type Msp2_05,
  type StatementForm,
  type StatementRow,
} from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';

import { statements as statementsApi } from '../../shared/api/endpoints.js';
import { formatMoney, formatPercentage } from '../../shared/lib/format.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';
import { lastCompletedQuarter } from '../reports/reports-page.js';

/**
 * Preparing MSP2-01 and MSP2-05.
 *
 * Three kinds of line, shown as three different things, because conflating them
 * would hide which figures a person can actually change:
 *
 * - **entered** — an input, and the institution's own figure;
 * - **derived** — this system's answer, from the loan book or another MSP2
 *   form, shown and not editable;
 * - **computed** — BOT's own arithmetic over the lines above.
 *
 * Nothing here adds a column. The totals move because the server recompiles the
 * whole form on save and sends it back — a balance sheet that has stopped
 * balancing is visible immediately rather than at submission.
 */

const FORM_TITLES: Record<StatementForm, string> = {
  'MSP2-01': 'Balance sheet',
  'MSP2-05': 'Liquid assets',
};

export function StatementsPage(): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const initial = lastCompletedQuarter();

  const [form, setForm] = useState<StatementForm>('MSP2-01');
  const [period, setPeriod] = useState(initial);
  /** Figures the user has changed but not yet saved, by Sno. */
  const [draft, setDraft] = useState<Record<number, string>>({});

  const statement = useQuery({
    queryKey: ['statement', form, period],
    queryFn: () => statementsApi.view(form, period.year, period.quarter),
    // Recompiling walks the loan book, so this is fetched when asked for rather
    // than every time the window regains focus.
    refetchOnWindowFocus: false,
  });

  // A draft belongs to one form and one quarter. Carrying it across would offer
  // to write last quarter's figures into this one.
  useEffect(() => {
    setDraft({});
  }, [form, period]);

  const save = useMutation({
    mutationFn: () =>
      statementsApi.save(form, period.year, period.quarter, {
        lines: Object.entries(draft).map(([sno, amount]) => ({ sno: Number(sno), amount })),
      }),
    onSuccess: async (view) => {
      setDraft({});
      queryClient.setQueryData(['statement', form, period], view);
      await queryClient.invalidateQueries({ queryKey: ['msp2-return'] });
    },
  });

  const view = statement.data;
  const rows: readonly StatementRow[] =
    view?.msp2_01?.rows ?? view?.msp2_05?.rows ?? ([] as StatementRow[]);
  const changed = Object.keys(draft).length;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Financial statements</h1>
          <p className="page__subtitle">
            The figures only the institution knows. Everything this system can answer is filled in
            and cannot be typed over.
          </p>
        </div>
      </div>

      <Panel title="Statement">
        <div className="report-controls">
          <label className="field" htmlFor="statement-form">
            <span className="field__label">Form</span>
            <select
              id="statement-form"
              className="input"
              value={form}
              onChange={(event) => {
                setForm(event.target.value as StatementForm);
              }}
            >
              {STATEMENT_FORMS.map((code) => (
                <option key={code} value={code}>
                  {code} — {FORM_TITLES[code]}
                </option>
              ))}
            </select>
          </label>

          <label className="field" htmlFor="statement-year">
            <span className="field__label">Year</span>
            <input
              id="statement-year"
              className="input"
              type="number"
              min={2000}
              max={9999}
              value={period.year}
              onChange={(event) => {
                setPeriod((current) => ({ ...current, year: Number(event.target.value) }));
              }}
            />
          </label>

          <label className="field" htmlFor="statement-quarter">
            <span className="field__label">Quarter</span>
            <select
              id="statement-quarter"
              className="input"
              value={period.quarter}
              onChange={(event) => {
                setPeriod((current) => ({ ...current, quarter: Number(event.target.value) }));
              }}
            >
              {[1, 2, 3, 4].map((quarter) => (
                <option key={quarter} value={quarter}>
                  Q{quarter}
                </option>
              ))}
            </select>
          </label>
        </div>
      </Panel>

      {statement.isPending && <Spinner label="Compiling the statement" />}
      {statement.error !== null && <ErrorNotice error={statement.error} />}

      {view?.msp2_01 !== undefined && <BalanceSheetSummary form={view.msp2_01} />}
      {view?.msp2_05 !== undefined && <LiquiditySummary form={view.msp2_05} />}

      {view !== undefined && (
        <Panel
          title={`${form} lines`}
          actions={
            session.can('expense.manage') ? (
              <button
                className="button button--primary"
                type="button"
                disabled={changed === 0 || save.isPending}
                onClick={() => {
                  save.mutate();
                }}
              >
                {save.isPending
                  ? 'Saving…'
                  : changed === 0
                    ? 'No changes'
                    : `Save ${String(changed)} figure${changed === 1 ? '' : 's'}`}
              </button>
            ) : undefined
          }
        >
          {save.error !== null && <ErrorNotice error={save.error} />}

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Sno</th>
                  <th scope="col">Line</th>
                  <th scope="col">Source</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.sno} className={row.source === 'computed' ? 'row--computed' : ''}>
                    <td className="numeric">{row.sno}</td>
                    <td>{row.label}</td>
                    <td>
                      <span
                        className={`badge badge--${row.source === 'entered' ? 'info' : 'neutral'}`}
                      >
                        {row.source}
                      </span>
                    </td>
                    <td className="numeric">
                      {row.source === 'entered' && session.can('expense.manage') ? (
                        <input
                          className="input input--figure"
                          inputMode="decimal"
                          aria-label={`${String(row.sno)}. ${row.label}`}
                          value={draft[row.sno] ?? row.amount}
                          onChange={(event) => {
                            setDraft((current) => ({ ...current, [row.sno]: event.target.value }));
                          }}
                        />
                      ) : (
                        formatMoney(row.amount)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}

/** Whether the sheet balances, which is BOT's first validation rule. */
function BalanceSheetSummary({ form }: { form: Msp2_01 }): ReactNode {
  const amountAt = (sno: number): string =>
    form.rows.find((row) => row.sno === sno)?.amount ?? '0.00';

  const assets = amountAt(33);
  const liabilitiesAndCapital = amountAt(61);
  const balances = assets === liabilitiesAndCapital;

  return (
    <Panel
      title={balances ? 'The sheet balances' : 'The sheet does not balance'}
      tone={balances ? 'success' : 'warning'}
    >
      <dl className="totals">
        <div>
          <dt>Total assets</dt>
          <dd>{formatMoney(assets)}</dd>
        </div>
        <div>
          <dt>Total liabilities and capital</dt>
          <dd>{formatMoney(liabilitiesAndCapital)}</dd>
        </div>
      </dl>

      {!balances && (
        <p className="hint-block">
          BOT enforces that these two are equal, so the return cannot be filed until they are.
          {form.missingEntries.length > 0 &&
            ` ${String(form.missingEntries.length)} line(s) have not been filled in yet, which is
              the first thing to check.`}
        </p>
      )}
    </Panel>
  );
}

/** The liquidity position, and whether it clears BOT's floor. */
function LiquiditySummary({ form }: { form: Msp2_05 }): ReactNode {
  return (
    <Panel
      title={form.meetsRequirement ? 'Liquidity requirement met' : 'Below the liquidity minimum'}
      tone={form.meetsRequirement ? 'success' : 'warning'}
    >
      <dl className="totals">
        <div>
          <dt>Available liquid assets</dt>
          <dd>{formatMoney(form.availableLiquidAssets)}</dd>
        </div>
        <div>
          <dt>Required minimum (5% of total assets)</dt>
          <dd>{formatMoney(form.requiredMinimum)}</dd>
        </div>
        <div>
          <dt>Excess (deficiency)</dt>
          <dd>{formatMoney(form.excess)}</dd>
        </div>
        <div>
          <dt>Liquid asset ratio</dt>
          <dd>{form.liquidAssetRatio === null ? '—' : formatPercentage(form.liquidAssetRatio)}</dd>
        </div>
      </dl>

      {!form.meetsRequirement && (
        <p className="hint-block">
          A shortfall is a supervisory matter rather than a filing error — the return is valid and
          says so. It is shown here because finding it at submission would be too late to act on.
        </p>
      )}
    </Panel>
  );
}
