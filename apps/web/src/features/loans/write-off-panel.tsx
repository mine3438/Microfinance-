import { type LoanWithSchedule, type LoanWriteOff } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { loanEvents } from '../../shared/api/endpoints.js';
import {
  formatDate,
  formatMoney,
  formatMoneyWithCurrency,
  formatTimestamp,
  today,
} from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Writing a loan off, and recording what comes back afterwards.
 *
 * A write-off is a judgement that a debt will not be collected. It is made by a
 * person — there is no threshold, no days-overdue trigger and no scheduled job
 * that could reach this state on its own, because a system that wrote debts off
 * on a timer would be making that judgement for them.
 *
 * What it does **not** do is post anything to the accounts. WRITEOFF-02 and
 * RECOVERY-02 — the ledger treatment for a write-off and for money recovered
 * afterwards — are unresolved, so no journal entry is written and none is shown.
 * The operational record is complete and keeps principal and penalty apart, so
 * whatever treatment is eventually approved can be applied to write-offs that
 * have already happened.
 */
export function WriteOffPanel({
  loan,
  onChanged,
}: {
  loan: LoanWithSchedule;
  onChanged: () => Promise<void>;
}): ReactNode {
  const session = useSession();

  /**
   * Whether this panel belongs on the loan at all, decided by status alone.
   *
   * A loan that has been written off has that status, and only an active loan
   * can become one — so the loan itself answers this, and the panel does not
   * appear, vanish and reappear as the request resolves. Deriving it from the
   * response instead would also mean a loan whose write-off failed to load
   * silently rendered as one that was never written off.
   */
  const relevant = loan.status === 'active' || loan.status === 'written_off';
  const writtenOff = loan.status === 'written_off';

  const query = useQuery({
    queryKey: ['write-off', loan.id],
    queryFn: () => loanEvents.writeOff(loan.id),
    enabled: session.can('loan.read') && relevant,
  });

  if (!relevant) {
    return null;
  }

  return (
    <>
      <Panel title="Write-off" tone={writtenOff ? 'danger' : 'neutral'}>
        {query.isPending && <Spinner label="Loading the write-off record" />}
        {query.error !== null && <ErrorNotice error={query.error} />}

        {query.isSuccess &&
          (query.data === null ? (
            <WriteOffAction loan={loan} onChanged={onChanged} />
          ) : (
            <WriteOffRecord writeOff={query.data} />
          ))}
      </Panel>

      {writtenOff && <RecoveriesPanel loan={loan} />}
    </>
  );
}

function WriteOffAction({
  loan,
  onChanged,
}: {
  loan: LoanWithSchedule;
  onChanged: () => Promise<void>;
}): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');

  const writeOff = useMutation({
    mutationFn: () => loanEvents.recordWriteOff(loan.id, { reason: reason.trim() }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['write-off', loan.id] });
      await onChanged();
      setConfirming(false);
    },
  });

  const fieldError = (field: string): string | undefined =>
    writeOff.error instanceof ApiRequestError ? writeOff.error.fieldError(field) : undefined;

  if (!session.can('loan.write_off')) {
    return (
      <p className="muted">
        This loan has not been written off. Writing one off is reserved to the owner or manager.
      </p>
    );
  }

  return (
    <>
      <p>
        Writing this loan off records a judgement that{' '}
        <strong>
          {loan.outstandingBalance === null
            ? 'the outstanding balance'
            : formatMoneyWithCurrency(loan.outstandingBalance)}
        </strong>{' '}
        owed by {loan.clientName} will not be collected.
      </p>

      {writeOff.error !== null && <ErrorNotice error={writeOff.error} />}

      {!confirming ? (
        <div className="form-actions">
          <button
            className="button button--danger"
            type="button"
            onClick={() => {
              setConfirming(true);
            }}
          >
            Write this loan off
          </button>
        </div>
      ) : (
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            writeOff.mutate();
          }}
        >
          <div className="notice notice--danger" role="alert">
            <p className="notice__message">
              <strong>This is a significant financial decision and it is not reversible.</strong>{' '}
              The borrower’s balance becomes zero, interest and penalties stop accruing, and the
              loan will no longer take ordinary repayments. The debt is not forgiven: money received
              afterwards is recorded as a recovery.
            </p>
          </div>

          <Field
            id="write-off-reason"
            label="Why is this debt unrecoverable?"
            hint="Required. An unexplained write-off is the first thing an inspection asks about."
            error={fieldError('reason')}
          >
            {(props) => (
              <textarea
                {...props}
                className="input"
                rows={3}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>

          <div className="form-actions">
            <button
              className="button button--danger"
              type="submit"
              disabled={reason.trim() === '' || writeOff.isPending}
            >
              {writeOff.isPending ? 'Recording…' : 'Confirm the write-off'}
            </button>
            <button
              className="button"
              type="button"
              disabled={writeOff.isPending}
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
  );
}

function WriteOffRecord({ writeOff }: { writeOff: LoanWriteOff }): ReactNode {
  return (
    <>
      <dl className="details">
        <div>
          <dt>Principal written off</dt>
          <dd>{formatMoneyWithCurrency(writeOff.principalWrittenOff)}</dd>
        </div>
        <div>
          <dt>Penalties written off</dt>
          <dd>{formatMoneyWithCurrency(writeOff.penaltyWrittenOff)}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>
            <strong>{formatMoneyWithCurrency(writeOff.totalWrittenOff)}</strong>
          </dd>
        </div>
        <div>
          <dt>Written off</dt>
          <dd>{formatTimestamp(writeOff.writtenOffAt)}</dd>
        </div>
        <div>
          <dt>Approved by</dt>
          <dd>{writeOff.approvedByName ?? '—'}</dd>
        </div>
      </dl>

      <div>
        <h3 className="panel__subtitle">Reason</h3>
        <p>{writeOff.reason}</p>
      </div>

      <p className="hint-block">
        These are the amounts as they stood at the moment of the decision, kept because the live
        balance is now zero. Money received after a write-off is recorded below as a recovery, which
        is not a repayment and does not reopen the loan.
      </p>
    </>
  );
}

/**
 * Money received after a write-off.
 *
 * Deliberately not the repayments panel and deliberately not worded like one. A
 * recovery does not reinstate the loan, restore a balance, or create a payment
 * the allocator can split — the loan stays written off before and after. Routing
 * this through the ordinary repayment screen would produce exactly the record
 * that must not exist: a repayment against a debt that is no longer owed.
 */
function RecoveriesPanel({ loan }: { loan: LoanWithSchedule }): ReactNode {
  const session = useSession();
  const [recording, setRecording] = useState(false);

  const query = useQuery({
    queryKey: ['recoveries', loan.id],
    queryFn: () => loanEvents.recoveries(loan.id),
    enabled: session.can('payment.read'),
  });

  if (!session.can('payment.read')) {
    return null;
  }

  return (
    <Panel
      title="Recoveries"
      actions={
        session.can('payment.create') && !recording ? (
          <button
            className="button button--small"
            type="button"
            onClick={() => {
              setRecording(true);
            }}
          >
            Record a recovery
          </button>
        ) : undefined
      }
    >
      {recording && (
        <RecoveryForm
          loan={loan}
          onDone={() => {
            setRecording(false);
          }}
        />
      )}

      {query.isPending && <Spinner label="Loading recoveries" />}
      {query.error !== null && <ErrorNotice error={query.error} />}

      {query.data !== undefined &&
        (query.data.length === 0 ? (
          <EmptyState title="Nothing recovered yet">
            Money received against this written-off loan is recorded here.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Received</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col">Method</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Recorded by</th>
                </tr>
              </thead>
              <tbody>
                {query.data.map((recovery) => (
                  <tr key={recovery.id}>
                    <td>{formatDate(recovery.recoveredOn)}</td>
                    <td className="numeric">{formatMoney(recovery.amount)}</td>
                    <td>{recovery.method ?? '—'}</td>
                    <td>{recovery.reference === null ? '—' : <code>{recovery.reference}</code>}</td>
                    <td>{recovery.recordedByName ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <p className="hint-block">
        A recovery is not a repayment. It does not reopen this loan, restore the borrower’s balance
        or change its status — the loan stays written off.
      </p>
    </Panel>
  );
}

function RecoveryForm({ loan, onDone }: { loan: LoanWithSchedule; onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState('');
  const [recoveredOn, setRecoveredOn] = useState(today());
  const [method, setMethod] = useState('Cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const record = useMutation({
    mutationFn: () =>
      loanEvents.recordRecovery(loan.id, {
        amount: amount.trim(),
        recoveredOn,
        ...(method.trim() === '' ? {} : { method: method.trim() }),
        ...(reference.trim() === '' ? {} : { reference: reference.trim() }),
        ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['recoveries', loan.id] });
      onDone();
    },
  });

  const fieldError = (field: string): string | undefined =>
    record.error instanceof ApiRequestError ? record.error.fieldError(field) : undefined;

  return (
    <>
      {record.error !== null && <ErrorNotice error={record.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          record.mutate();
        }}
      >
        <Field
          id="recovery-amount"
          label="Amount received (TZS)"
          hint="Partial and repeated recoveries are both ordinary."
          error={fieldError('amount')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="recovery-on" label="Received on" error={fieldError('recoveredOn')}>
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={recoveredOn}
              onChange={(event) => {
                setRecoveredOn(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="recovery-method" label="How it arrived" error={fieldError('method')}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={method}
              onChange={(event) => {
                setMethod(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="recovery-reference"
          label="Reference"
          hint="Optional. Receipt or transaction number."
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

        <Field id="recovery-notes" label="Note" hint="Optional." error={fieldError('notes')}>
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
            disabled={amount.trim() === '' || record.isPending}
          >
            {record.isPending ? 'Recording…' : 'Record the recovery'}
          </button>
          <button className="button" type="button" onClick={onDone} disabled={record.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </>
  );
}
