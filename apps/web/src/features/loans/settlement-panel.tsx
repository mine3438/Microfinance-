import { type LoanWithSchedule, type SettlementQuote } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { loanEvents } from '../../shared/api/endpoints.js';
import {
  formatDate,
  formatMoney,
  formatMoneyWithCurrency,
  today,
} from '../../shared/lib/format.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Settling a loan before maturity.
 *
 * **Every figure on this screen comes from the server.** The four amounts are
 * rendered from the quote response exactly as sent; nothing here adds the parts
 * to check the total, works out which months are charged, or subtracts what has
 * been paid. That is not caution about rounding — it is that the settlement
 * figure is what the borrower hands over, and a second implementation of it in
 * browser JavaScript is a second answer that can differ from the recorded one.
 *
 * The quote is re-fetched whenever the settlement date changes and is never
 * cached across dates, because a quote taken an hour ago may have been overtaken
 * by a penalty accrual or an ordinary repayment. The server recomputes again
 * before it closes anything, and refuses a total that no longer matches — so a
 * stale screen produces a refusal, not a wrong settlement.
 */
export function SettlementPanel({
  loan,
  onSettled,
}: {
  loan: LoanWithSchedule;
  onSettled: () => Promise<void>;
}): ReactNode {
  const session = useSession();
  const [settlementDate, setSettlementDate] = useState(today());

  const quote = useQuery({
    queryKey: ['settlement-quote', loan.id, settlementDate],
    queryFn: () => loanEvents.settlementQuote(loan.id, settlementDate),
    enabled: session.can('payment.read') && loan.status === 'active',
    // A quote is a point-in-time figure, not a cacheable resource.
    staleTime: 0,
    gcTime: 0,
  });

  if (!session.can('payment.read') || loan.status !== 'active') {
    return null;
  }

  return (
    <Panel title="Settle early">
      <Field
        id="settlement-date"
        label="Settlement date"
        hint="Interest is charged to the end of this month. The day within the month does not change the figure."
      >
        {(props) => (
          <input
            {...props}
            className="input"
            type="date"
            value={settlementDate}
            onChange={(event) => {
              setSettlementDate(event.target.value);
            }}
          />
        )}
      </Field>

      {quote.isPending && <Spinner label="Requesting a settlement figure" />}
      {quote.error !== null && <ErrorNotice error={quote.error} />}

      {quote.data !== undefined && (
        <SettlementQuoteView loan={loan} quote={quote.data} onSettled={onSettled} />
      )}
    </Panel>
  );
}

function SettlementQuoteView({
  loan,
  quote,
  onSettled,
}: {
  loan: LoanWithSchedule;
  quote: SettlementQuote;
  onSettled: () => Promise<void>;
}): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [notes, setNotes] = useState('');

  const settle = useMutation({
    mutationFn: () =>
      loanEvents.settle(loan.id, {
        // Sent back exactly as quoted. The server compares the two and refuses
        // a mismatch, which is what makes a stale screen safe.
        amountPaid: quote.total,
        settlementDate: quote.settlementDate,
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['settlement-quote', loan.id] });
      await onSettled();
      setConfirming(false);
    },
  });

  const fieldError = (field: string): string | undefined =>
    settle.error instanceof ApiRequestError ? settle.error.fieldError(field) : undefined;

  return (
    <>
      <table className="table">
        <caption className="visually-hidden">Settlement breakdown</caption>
        <tbody>
          <tr>
            <th scope="row">Outstanding principal</th>
            <td className="numeric">{formatMoney(quote.principal)}</td>
          </tr>
          <tr>
            <th scope="row">Interest to {formatDate(quote.chargedThrough)}</th>
            <td className="numeric">{formatMoney(quote.interest)}</td>
          </tr>
          <tr>
            <th scope="row">Outstanding penalties</th>
            <td className="numeric">{formatMoney(quote.penalty)}</td>
          </tr>
          <tr className="row--total">
            <th scope="row">Total to settle</th>
            <td className="numeric">
              <strong>{formatMoneyWithCurrency(quote.total)}</strong>
            </td>
          </tr>
        </tbody>
      </table>

      <p className="muted">
        Interest after {formatDate(quote.chargedThrough)} is not charged, saving the borrower{' '}
        {formatMoneyWithCurrency(quote.interestNotCharged)}. Nothing is discounted and no penalty is
        waived. The application fee is separate and is not part of this figure.
      </p>

      {settle.error !== null && <ErrorNotice error={settle.error} />}

      {session.can('payment.create') && (
        <>
          {!confirming ? (
            <div className="form-actions">
              <button
                className="button button--primary"
                type="button"
                onClick={() => {
                  setConfirming(true);
                }}
              >
                Settle this loan
              </button>
            </div>
          ) : (
            <form
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                settle.mutate();
              }}
            >
              <p className="notice notice--warning">
                <strong>
                  This closes the loan against a payment of {formatMoneyWithCurrency(quote.total)}.
                </strong>{' '}
                Record it only once the money has been received. The loan will no longer accept
                repayments.
              </p>

              <Field
                id="settlement-notes"
                label="Note"
                hint="Optional. Anything worth recording about the settlement."
                error={fieldError('notes')}
              >
                {(props) => (
                  <textarea
                    {...props}
                    className="input"
                    rows={2}
                    value={notes}
                    onChange={(event) => {
                      setNotes(event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="form-actions">
                <button
                  className="button button--primary"
                  type="submit"
                  disabled={settle.isPending}
                >
                  {settle.isPending
                    ? 'Recording…'
                    : `Confirm ${formatMoneyWithCurrency(quote.total)} received`}
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={settle.isPending}
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}
