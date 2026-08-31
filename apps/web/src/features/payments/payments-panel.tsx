import { type AllocationPreview, type LoanWithSchedule } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { payments as paymentsApi } from '../../shared/api/endpoints.js';
import { formatDate, formatMoney, formatMoneyWithCurrency } from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { useSession } from '../auth/session.js';

/**
 * Recording a repayment, and the history of what has been recorded.
 *
 * **The split shown before the button is pressed comes from the server.** As
 * an amount is typed, `/loans/:id/payments/preview` runs the same allocator the
 * write path will run, so the interest and principal quoted at the counter are
 * the figures that get stored. Nothing in this file divides an amount between
 * buckets.
 */
export function PaymentsPanel({
  loan,
  onChanged,
}: {
  loan: LoanWithSchedule;
  onChanged: () => Promise<void>;
}): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');

  const history = useQuery({
    queryKey: ['payments', loan.id],
    queryFn: () => paymentsApi.list({ loanId: loan.id, limit: 50 }),
  });

  const preview = useQuery({
    queryKey: ['payment-preview', loan.id, amount],
    queryFn: () => paymentsApi.previewAllocation(loan.id, amount),
    enabled: amount !== '' && loan.status === 'active',
    retry: false,
  });

  const record = useMutation({
    mutationFn: () =>
      paymentsApi.record(loan.id, {
        amountPaid: amount,
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      }),
    onSuccess: async () => {
      setAmount('');
      setNotes('');
      await queryClient.invalidateQueries({ queryKey: ['payments', loan.id] });
      await onChanged();
    },
  });

  const amountError =
    record.error instanceof ApiRequestError
      ? record.error.fieldError('amountPaid')
      : preview.error instanceof ApiRequestError
        ? preview.error.fieldError('amountPaid')
        : undefined;

  return (
    <>
      {loan.status === 'active' && session.can('payment.create') && (
        <Panel title="Record a repayment">
          {record.error !== null && <ErrorNotice error={record.error} />}

          <Field
            id="amount"
            label="Amount received (TZS)"
            hint="Enter the amount in shillings, for example 150000 or 150000.50."
            error={amountError}
          >
            {(props) => (
              <input
                {...props}
                className="input"
                // Not `type="number"`: a number input yields a JS number, and
                // the API refuses amounts that arrived as doubles.
                inputMode="decimal"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value.trim());
                }}
              />
            )}
          </Field>

          <Field id="notes" label="Notes (optional)">
            {(props) => (
              <input
                {...props}
                className="input"
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                }}
              />
            )}
          </Field>

          {preview.data !== undefined && <AllocationSummary preview={preview.data} />}

          <button
            className="button button--primary"
            type="button"
            disabled={amount === '' || preview.data === undefined || record.isPending}
            onClick={() => {
              record.mutate();
            }}
          >
            {record.isPending ? 'Recording…' : 'Record repayment'}
          </button>

          <p className="hint-block">
            A recorded repayment cannot be edited. If it is wrong, it is corrected by recording a
            reversal, so both the entry and its correction stay on the record.
          </p>
        </Panel>
      )}

      <Panel title="Repayment history">
        {history.error !== null && <ErrorNotice error={history.error} />}

        {history.data !== undefined &&
          (history.data.items.length === 0 ? (
            <EmptyState title="No repayments yet">
              Repayments recorded against this loan will appear here.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    <th scope="col" className="numeric">
                      Interest
                    </th>
                    <th scope="col" className="numeric">
                      Principal
                    </th>
                    <th scope="col" className="numeric">
                      Balance after
                    </th>
                    <th scope="col">&nbsp;</th>
                  </tr>
                </thead>
                <tbody>
                  {history.data.items.map((payment) => {
                    const isReversal = payment.reversesPaymentId !== null;
                    const isReversed = payment.reversedByPaymentId !== null;

                    return (
                      <tr key={payment.id} className={isReversed ? 'row--muted' : ''}>
                        <td>{formatDate(payment.datePaid)}</td>
                        <td className="numeric">{formatMoney(payment.amountPaid)}</td>
                        <td className="numeric">{formatMoney(payment.allocation.interest)}</td>
                        <td className="numeric">{formatMoney(payment.allocation.principal)}</td>
                        <td className="numeric">{formatMoney(payment.balanceAfter)}</td>
                        <td>
                          {isReversal ? (
                            <span className="badge badge--warning">Reversal</span>
                          ) : isReversed ? (
                            <span className="badge badge--neutral">Reversed</span>
                          ) : (
                            session.can('payment.reverse') && (
                              <ReverseButton
                                paymentId={payment.id}
                                onDone={async () => {
                                  await queryClient.invalidateQueries({
                                    queryKey: ['payments', loan.id],
                                  });
                                  await onChanged();
                                }}
                              />
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </>
  );
}

/**
 * What the server says an amount would do.
 *
 * Rendered verbatim. The unallocated line appears only when there is one, and
 * it is worded as a question rather than an outcome: what an institution does
 * with money paid beyond everything owed is an open rule, and this screen must
 * not imply the system has decided.
 */
function AllocationSummary({ preview }: { preview: AllocationPreview }): ReactNode {
  const overpaid = Number(preview.allocation.unallocated) > 0;

  return (
    <div className="allocation">
      <p className="allocation__title">This repayment would be applied as:</p>
      <dl className="totals">
        <div>
          <dt>Interest</dt>
          <dd>{formatMoneyWithCurrency(preview.allocation.interest)}</dd>
        </div>
        <div>
          <dt>Principal</dt>
          <dd>{formatMoneyWithCurrency(preview.allocation.principal)}</dd>
        </div>
        <div className="totals__emphasis">
          <dt>Balance after</dt>
          <dd>{formatMoneyWithCurrency(preview.balanceAfter)}</dd>
        </div>
      </dl>

      {overpaid && (
        <p className="notice notice--warning">
          {formatMoneyWithCurrency(preview.allocation.unallocated)} is more than this loan owes. It
          will be recorded as unallocated rather than applied — decide with your administrator
          whether it is refunded or held.
        </p>
      )}
    </div>
  );
}

function ReverseButton({
  paymentId,
  onDone,
}: {
  paymentId: string;
  onDone: () => Promise<void>;
}): ReactNode {
  const [reason, setReason] = useState('');
  const [open, setOpen] = useState(false);

  const reverse = useMutation({
    mutationFn: () => paymentsApi.reverse(paymentId, { reason }),
    onSuccess: async () => {
      setOpen(false);
      setReason('');
      await onDone();
    },
  });

  if (!open) {
    return (
      <button
        className="button button--small"
        type="button"
        onClick={() => {
          setOpen(true);
        }}
      >
        Reverse
      </button>
    );
  }

  return (
    <div className="reversal">
      {reverse.error !== null && <ErrorNotice error={reverse.error} />}
      <Field
        id={`reversal-${paymentId}`}
        label="Why is this being reversed?"
        hint="Required. An unexplained movement of money is worse than the mistake it corrects."
      >
        {(props) => (
          <input
            {...props}
            className="input"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
            }}
          />
        )}
      </Field>
      <div className="form-actions">
        <button
          className="button button--danger button--small"
          type="button"
          disabled={reason.trim() === '' || reverse.isPending}
          onClick={() => {
            reverse.mutate();
          }}
        >
          {reverse.isPending ? 'Reversing…' : 'Confirm reversal'}
        </button>
        <button
          className="button button--small"
          type="button"
          onClick={() => {
            setOpen(false);
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
