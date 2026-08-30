import { APPLICATION_FEE_AMOUNT, type ApplicationFee, type LoanWithSchedule } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { loanEvents } from '../../shared/api/endpoints.js';
import { formatDate, formatMoneyWithCurrency, today } from '../../shared/lib/format.js';
import { Badge } from '../../shared/ui/badge.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * The application/form fee, and its refund.
 *
 * Three properties this panel exists to hold, each of which the obvious
 * implementation gets wrong.
 *
 * **It is charged once per application, not once per submission.** A rejected
 * application returns to draft and may be revised and resubmitted; no second
 * fee is ever asked for. The collect control therefore keys off whether a fee
 * record exists at all — never off the loan's status, which cycles.
 *
 * **Entitlement is not the loan's status.** Because rejection sends the
 * application back to `draft`, `status === 'rejected'` is false for exactly the
 * applications a refund is owed on. The server derives the state from the
 * rejection decision itself and reports it as `state`; this panel renders that
 * and computes nothing.
 *
 * **Owed is not paid.** `refund_due` means the institution owes the applicant
 * TZS 5,000 in cash. `refunded` means somebody handed it over and recorded it.
 * They are shown as different things, in different words, because a screen that
 * blurred them would let an applicant be told they had been paid when the money
 * was still in the drawer.
 *
 * No ledger language appears anywhere here. FEE-04 — how a collection and a
 * refund post to the accounts — is unresolved, and nothing in this system
 * writes a journal entry for either.
 */
export function ApplicationFeePanel({ loan }: { loan: LoanWithSchedule }): ReactNode {
  const session = useSession();

  const query = useQuery({
    queryKey: ['application-fee', loan.id],
    queryFn: () => loanEvents.applicationFee(loan.id),
    enabled: session.can('payment.read'),
  });

  if (!session.can('payment.read')) {
    return null;
  }

  return (
    <Panel title="Application fee">
      {query.isPending && <Spinner label="Loading the application fee" />}
      {query.error !== null && <ErrorNotice error={query.error} />}

      {query.isSuccess &&
        (query.data === null ? <FeeNotYetCollected loan={loan} /> : <FeeRecord fee={query.data} />)}
    </Panel>
  );
}

/** Tone and wording for each state the server reports. */
const STATE_LABELS: Record<
  ApplicationFee['state'],
  { label: string; tone: 'neutral' | 'info' | 'success' | 'warning'; explanation: string }
> = {
  collected: {
    label: 'Collected',
    tone: 'info',
    explanation: 'Taken when the forms were handed in. The application has not been decided yet.',
  },
  retained: {
    label: 'Retained',
    tone: 'success',
    explanation: 'The application was approved, so the institution keeps the fee.',
  },
  refund_due: {
    label: 'Refund due',
    tone: 'warning',
    explanation:
      'The application was rejected, so this fee is owed back to the applicant. ' +
      'It has not been handed over yet.',
  },
  refunded: {
    label: 'Refunded',
    tone: 'neutral',
    explanation: 'Handed back to the applicant. The record of the original collection is kept.',
  },
};

function FeeNotYetCollected({ loan }: { loan: LoanWithSchedule }): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [collectedOn, setCollectedOn] = useState(today());
  const [reference, setReference] = useState('');

  const collect = useMutation({
    mutationFn: () =>
      loanEvents.collectApplicationFee(loan.id, {
        collectedOn,
        method: 'Cash',
        ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['application-fee', loan.id] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    collect.error instanceof ApiRequestError ? collect.error.fieldError(field) : undefined;

  if (!session.can('payment.create')) {
    return <p className="muted">No application fee has been recorded for this application.</p>;
  }

  return (
    <>
      <p>
        No fee has been recorded for this application. The charge is{' '}
        <strong>{formatMoneyWithCurrency(APPLICATION_FEE_AMOUNT)}</strong>, in cash, once per
        application.
      </p>

      {collect.error !== null && <ErrorNotice error={collect.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          collect.mutate();
        }}
      >
        <Field id="fee-collected-on" label="Collected on" error={fieldError('collectedOn')}>
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={collectedOn}
              onChange={(event) => {
                setCollectedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="fee-reference"
          label="Receipt reference"
          hint="Optional. The receipt number given to the applicant."
          error={fieldError('reference')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              value={reference}
              onChange={(event) => {
                setReference(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={collect.isPending}>
            {collect.isPending
              ? 'Recording…'
              : `Record ${formatMoneyWithCurrency(APPLICATION_FEE_AMOUNT)} received`}
          </button>
        </div>
      </form>

      <p className="hint-block">
        The amount is fixed policy and is not entered here. This fee is not part of the loan: it is
        not added to the principal, not deducted from the disbursement, and earns no interest.
      </p>
    </>
  );
}

function FeeRecord({ fee }: { fee: ApplicationFee }): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [refunding, setRefunding] = useState(false);
  const [refundedOn, setRefundedOn] = useState(today());
  const [reason, setReason] = useState('');

  const refund = useMutation({
    mutationFn: () =>
      loanEvents.refundApplicationFee(fee.loanId, {
        refundedOn,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['application-fee', fee.loanId] });
      setRefunding(false);
    },
  });

  const fieldError = (field: string): string | undefined =>
    refund.error instanceof ApiRequestError ? refund.error.fieldError(field) : undefined;

  const state = STATE_LABELS[fee.state];

  return (
    <>
      <dl className="details">
        <div>
          <dt>Amount</dt>
          <dd>{formatMoneyWithCurrency(fee.amount)}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            <Badge tone={state.tone}>{state.label}</Badge>
          </dd>
        </div>
        <div>
          <dt>Collected</dt>
          <dd>{formatDate(fee.collectedOn)}</dd>
        </div>
        <div>
          <dt>Taken by</dt>
          <dd>{fee.collectedByName ?? '—'}</dd>
        </div>
        {fee.method !== null && (
          <div>
            <dt>Method</dt>
            <dd>{fee.method}</dd>
          </div>
        )}
        {fee.reference !== null && (
          <div>
            <dt>Reference</dt>
            <dd>
              <code>{fee.reference}</code>
            </dd>
          </div>
        )}
      </dl>

      <p className="muted">{state.explanation}</p>

      {fee.refundedOn !== null && (
        <>
          <h3 className="panel__subtitle">Refund</h3>
          <dl className="details">
            <div>
              <dt>Handed back</dt>
              <dd>{formatDate(fee.refundedOn)}</dd>
            </div>
            <div>
              <dt>By</dt>
              <dd>{fee.refundedByName ?? '—'}</dd>
            </div>
            {fee.refundReason !== null && (
              <div>
                <dt>Reason</dt>
                <dd>{fee.refundReason}</dd>
              </div>
            )}
          </dl>
        </>
      )}

      {fee.state === 'refund_due' && session.can('payment.create') && (
        <>
          {!refunding && (
            <div className="form-actions">
              <button
                className="button button--primary"
                type="button"
                onClick={() => {
                  setRefunding(true);
                }}
              >
                Record a cash refund
              </button>
            </div>
          )}

          {refunding && (
            <>
              {refund.error !== null && <ErrorNotice error={refund.error} />}

              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  refund.mutate();
                }}
              >
                <p>
                  Record this only once the {formatMoneyWithCurrency(fee.amount)} has actually been
                  handed to the applicant.
                </p>

                <Field id="refund-on" label="Refunded on" error={fieldError('refundedOn')}>
                  {(props) => (
                    <input
                      {...props}
                      className="input"
                      type="date"
                      value={refundedOn}
                      onChange={(event) => {
                        setRefundedOn(event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  id="refund-reason"
                  label="Note"
                  hint="Optional. Anything worth recording about the refund."
                  error={fieldError('reason')}
                >
                  {(props) => (
                    <textarea
                      {...props}
                      className="input"
                      rows={2}
                      value={reason}
                      onChange={(event) => {
                        setReason(event.target.value);
                      }}
                    />
                  )}
                </Field>

                <div className="form-actions">
                  <button
                    className="button button--primary"
                    type="submit"
                    disabled={refund.isPending}
                  >
                    {refund.isPending ? 'Recording…' : 'Confirm the refund was paid'}
                  </button>
                  <button
                    className="button"
                    type="button"
                    disabled={refund.isPending}
                    onClick={() => {
                      setRefunding(false);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </form>
            </>
          )}
        </>
      )}

      <p className="hint-block">
        Charged once per application. Revising and resubmitting this application does not incur a
        second fee.
      </p>
    </>
  );
}
