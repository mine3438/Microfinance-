import { FINANCE_DIRECTIONS, type FinanceDirection, type Msp2_02Line } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { finance as financeApi, reference } from '../../shared/api/endpoints.js';
import { formatDate, formatMoney, today } from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Income and expenditure.
 *
 * There is no category field on this screen, and that is the point. BOT's
 * MSP2-02 has forty-two numbered lines; a figure belongs to exactly one of
 * them, and the picker below is built from the taxonomy the server serves
 * rather than from a list compiled into this bundle. The system being replaced
 * let a category be any string a caller sent, which then flowed onto a
 * regulatory filing.
 *
 * The lines BOT computes are absent from the picker entirely — they are totals
 * of the lines beneath them, and an entry against one would be counted twice.
 * The server refuses that regardless; leaving it out of the list means nobody
 * has to be told.
 */

const BLANK = {
  direction: 'expense' as FinanceDirection,
  sno: '',
  amount: '',
  entryDate: today(),
  description: '',
  reference: '',
};

export function FinancePage(): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const [direction, setDirection] = useState<FinanceDirection | ''>('');
  const [form, setForm] = useState(BLANK);

  const lines = useQuery({
    queryKey: ['msp2-02-lines'],
    // BOT's taxonomy changes only when a migration reseeds it, so this is
    // fetched once and kept for the session rather than on every render of the
    // form.
    queryFn: () => reference.msp2_02Lines(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const entries = useQuery({
    queryKey: ['finance-entries', { direction }],
    queryFn: () =>
      financeApi.listEntries({
        ...(direction === '' ? {} : { direction }),
        limit: 50,
      }),
  });

  const record = useMutation({
    mutationFn: () =>
      financeApi.recordEntry({
        direction: form.direction,
        sno: Number(form.sno),
        amount: form.amount,
        entryDate: form.entryDate,
        ...(form.description === '' ? {} : { description: form.description }),
        ...(form.reference === '' ? {} : { reference: form.reference }),
      }),
    onSuccess: async () => {
      setForm({ ...BLANK, direction: form.direction });
      await queryClient.invalidateQueries({ queryKey: ['finance-entries'] });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => financeApi.removeEntry(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['finance-entries'] });
    },
  });

  const enterable = (lines.data ?? []).filter((line) => line.entryDirection === form.direction);
  const fieldError = (field: string): string | undefined =>
    record.error instanceof ApiRequestError ? record.error.fieldError(field) : undefined;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Income and expenditure</h1>
          <p className="page__subtitle">
            Every figure is recorded against the BOT MSP2-02 line it will be filed on.
          </p>
        </div>
      </div>

      {session.can('expense.manage') && (
        <Panel title="Record a figure">
          <form
            className="report-controls"
            onSubmit={(event) => {
              event.preventDefault();
              record.mutate();
            }}
          >
            <label className="field" htmlFor="entry-direction">
              <span className="field__label">Side</span>
              <select
                id="entry-direction"
                className="input"
                value={form.direction}
                onChange={(event) => {
                  // The line list depends on the side, so a line chosen for the
                  // old one is cleared rather than left to be refused.
                  setForm((current) => ({
                    ...current,
                    direction: event.target.value as FinanceDirection,
                    sno: '',
                  }));
                }}
              >
                {FINANCE_DIRECTIONS.map((value) => (
                  <option key={value} value={value}>
                    {value === 'income' ? 'Income' : 'Expense'}
                  </option>
                ))}
              </select>
            </label>

            <label className="field field--wide" htmlFor="entry-line">
              <span className="field__label">BOT line</span>
              <select
                id="entry-line"
                className="input"
                value={form.sno}
                required
                onChange={(event) => {
                  setForm((current) => ({ ...current, sno: event.target.value }));
                }}
              >
                <option value="">Choose a line…</option>
                {enterable.map((line: Msp2_02Line) => (
                  <option key={line.sno} value={line.sno}>
                    {line.sno}. {line.label}
                  </option>
                ))}
              </select>
              {fieldError('sno') !== undefined && (
                <span className="field__error">{fieldError('sno')}</span>
              )}
            </label>

            <label className="field" htmlFor="entry-amount">
              <span className="field__label">Amount (TZS)</span>
              <input
                id="entry-amount"
                className="input"
                inputMode="decimal"
                value={form.amount}
                required
                onChange={(event) => {
                  setForm((current) => ({ ...current, amount: event.target.value }));
                }}
              />
              {fieldError('amount') !== undefined && (
                <span className="field__error">{fieldError('amount')}</span>
              )}
            </label>

            <label className="field" htmlFor="entry-date">
              <span className="field__label">Date</span>
              <input
                id="entry-date"
                className="input"
                type="date"
                value={form.entryDate}
                required
                onChange={(event) => {
                  setForm((current) => ({ ...current, entryDate: event.target.value }));
                }}
              />
              <span className="field__hint">
                The quarter is taken from this date, never typed separately.
              </span>
            </label>

            <label className="field field--wide" htmlFor="entry-description">
              <span className="field__label">Description</span>
              <input
                id="entry-description"
                className="input"
                value={form.description}
                onChange={(event) => {
                  setForm((current) => ({ ...current, description: event.target.value }));
                }}
              />
            </label>

            <label className="field" htmlFor="entry-reference">
              <span className="field__label">Reference</span>
              <input
                id="entry-reference"
                className="input"
                value={form.reference}
                placeholder="Invoice or voucher"
                onChange={(event) => {
                  setForm((current) => ({ ...current, reference: event.target.value }));
                }}
              />
            </label>

            <div className="report-controls__action">
              <button className="button button--primary" type="submit" disabled={record.isPending}>
                {record.isPending ? 'Recording…' : 'Record'}
              </button>
            </div>
          </form>

          {record.error !== null && <ErrorNotice error={record.error} />}
        </Panel>
      )}

      <Panel title="Recorded">
        <label className="search" htmlFor="entry-filter">
          <span className="visually-hidden">Filter by side</span>
          <select
            id="entry-filter"
            className="input"
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as FinanceDirection | '');
            }}
          >
            <option value="">Income and expenditure</option>
            <option value="income">Income only</option>
            <option value="expense">Expenditure only</option>
          </select>
        </label>

        {entries.isPending && <Spinner label="Loading entries" />}
        {entries.error !== null && <ErrorNotice error={entries.error} />}
        {remove.error !== null && <ErrorNotice error={remove.error} />}

        {entries.data !== undefined &&
          (entries.data.items.length === 0 ? (
            <EmptyState title="Nothing recorded yet">
              Income and expenditure recorded here appears on MSP2-02.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Side</th>
                    <th scope="col">BOT line</th>
                    <th scope="col">Description</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    {session.can('expense.manage') && <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {entries.data.items.map((entry) => (
                    <tr key={entry.id}>
                      <td>{formatDate(entry.entryDate)}</td>
                      <td>{entry.direction === 'income' ? 'Income' : 'Expense'}</td>
                      <td>
                        {entry.sno}. {entry.lineLabel}
                      </td>
                      <td>{entry.description ?? '—'}</td>
                      <td className="numeric">{formatMoney(entry.amount)}</td>
                      {session.can('expense.manage') && (
                        <td>
                          <button
                            className="button button--small button--danger"
                            type="button"
                            disabled={remove.isPending}
                            onClick={() => {
                              remove.mutate(entry.id);
                            }}
                          >
                            Remove
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </div>
  );
}
