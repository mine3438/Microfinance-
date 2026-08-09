import { type LoanWithSchedule } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useParams } from 'react-router';

import { loans as loansApi } from '../../shared/api/endpoints.js';
import {
  formatDate,
  formatMoney,
  formatMoneyWithCurrency,
  formatMonthlyRate,
  formatStatus,
} from '../../shared/lib/format.js';
import { StatusBadge } from '../../shared/ui/badge.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { PaymentsPanel } from '../payments/payments-panel.js';
import { useSession } from '../auth/session.js';

/**
 * One loan, its schedule, its payments, and whatever the caller may do next.
 *
 * The available actions are derived from the loan's status and the caller's
 * permissions, so an officer does not see an Approve button they cannot use.
 * That is presentation: the API refuses the same request regardless, and the
 * domain refuses self-approval even for someone holding every permission.
 */
export function LoanPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const loanId = id ?? '';

  const query = useQuery({
    queryKey: ['loan', loanId],
    queryFn: () => loansApi.get(loanId),
    enabled: loanId !== '',
  });

  if (query.isPending) {
    return <Spinner label="Loading the loan" />;
  }
  if (query.error !== null) {
    return <ErrorNotice error={query.error} />;
  }
  return <LoanDetail loan={query.data} />;
}

function LoanDetail({ loan }: { loan: LoanWithSchedule }): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [rejectionReason, setRejectionReason] = useState('');
  const [showRejection, setShowRejection] = useState(false);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['loan', loan.id] });
    await queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const submit = useMutation({
    mutationFn: () => loansApi.submit(loan.id),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') =>
      decision === 'approve'
        ? loansApi.decide(loan.id, { decision: 'approve' })
        : loansApi.decide(loan.id, { decision: 'reject', reason: rejectionReason }),
    onSuccess: refresh,
  });
  const disburse = useMutation({
    mutationFn: () => loansApi.disburse(loan.id, {}),
    onSuccess: refresh,
  });

  const actionError = submit.error ?? decide.error ?? disburse.error;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">{loan.clientName}</h1>
          <p className="page__subtitle">
            <code>{loan.loanCode ?? 'Draft'}</code> · {loan.productName} ·{' '}
            <StatusBadge status={loan.status} />
          </p>
        </div>
      </div>

      {actionError !== null && <ErrorNotice error={actionError} />}

      <div className="layout layout--split">
        <div className="stack">
          <Panel title="Terms">
            <dl className="details">
              <div>
                <dt>Principal</dt>
                <dd>{formatMoneyWithCurrency(loan.principal)}</dd>
              </div>
              <div>
                <dt>Rate</dt>
                <dd>{formatMonthlyRate(loan.monthlyRate)}</dd>
              </div>
              <div>
                <dt>Interest method</dt>
                <dd>{loan.interestMethod === 'flat' ? 'Flat' : 'Reducing balance'}</dd>
              </div>
              <div>
                <dt>Term</dt>
                <dd>{loan.termMonths} months</dd>
              </div>
              <div>
                <dt>Outstanding</dt>
                <dd>
                  {loan.outstandingBalance === null
                    ? 'Not yet disbursed'
                    : formatMoneyWithCurrency(loan.outstandingBalance)}
                </dd>
              </div>
              {loan.disbursementDate !== null && (
                <div>
                  <dt>Disbursed</dt>
                  <dd>{formatDate(loan.disbursementDate)}</dd>
                </div>
              )}
            </dl>

            {loan.rejectionReason !== null && (
              <p className="notice notice--warning">
                <strong>Rejected.</strong> {loan.rejectionReason}
              </p>
            )}

            <p className="hint-block">
              The rate and method were copied from the product when this application was written.
              Repricing the product does not change this loan.
            </p>
          </Panel>

          <Panel title="What happens next">
            {loan.status === 'draft' && session.can('loan.create') && (
              <>
                <p>This is a draft. Submitting it sends it for approval by someone else.</p>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={submit.isPending}
                  onClick={() => {
                    submit.mutate();
                  }}
                >
                  {submit.isPending ? 'Submitting…' : 'Submit for approval'}
                </button>
              </>
            )}

            {loan.status === 'pending_approval' && session.can('loan.approve') && (
              <>
                <p>
                  Awaiting a decision. It cannot be approved by whoever submitted it, and it cannot
                  be approved above your configured limit.
                </p>
                <div className="form-actions">
                  <button
                    className="button button--primary"
                    type="button"
                    disabled={decide.isPending}
                    onClick={() => {
                      decide.mutate('approve');
                    }}
                  >
                    Approve
                  </button>
                  <button
                    className="button button--danger"
                    type="button"
                    onClick={() => {
                      setShowRejection(true);
                    }}
                  >
                    Reject
                  </button>
                </div>

                {showRejection && (
                  <div className="stack">
                    <Field
                      id="rejection-reason"
                      label="Reason for rejection"
                      hint="Required. A decision with no reason is not a record the borrower or an auditor can act on."
                    >
                      {(props) => (
                        <textarea
                          {...props}
                          className="input"
                          rows={3}
                          value={rejectionReason}
                          onChange={(event) => {
                            setRejectionReason(event.target.value);
                          }}
                        />
                      )}
                    </Field>
                    <button
                      className="button button--danger"
                      type="button"
                      disabled={rejectionReason.trim() === '' || decide.isPending}
                      onClick={() => {
                        decide.mutate('reject');
                      }}
                    >
                      {decide.isPending ? 'Recording…' : 'Confirm rejection'}
                    </button>
                  </div>
                )}
              </>
            )}

            {loan.status === 'pending_approval' && !session.can('loan.approve') && (
              <p className="muted">
                Waiting for approval. Your role does not hold approval authority.
              </p>
            )}

            {loan.status === 'approved' && session.can('loan.disburse') && (
              <>
                <p>
                  Approved. Disbursing records the release of funds and writes the repayment
                  schedule.
                </p>
                <button
                  className="button button--primary"
                  type="button"
                  disabled={disburse.isPending}
                  onClick={() => {
                    disburse.mutate();
                  }}
                >
                  {disburse.isPending ? 'Recording…' : 'Record disbursement'}
                </button>
              </>
            )}

            {(loan.status === 'rejected' ||
              loan.status === 'completed' ||
              loan.status === 'written_off') && (
              <p className="muted">
                This loan is {formatStatus(loan.status).toLowerCase()}. Nothing further follows.
              </p>
            )}
          </Panel>
        </div>

        <div className="stack">
          {loan.schedule !== null && (
            <Panel title="Repayment schedule">
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">#</th>
                      <th scope="col">Due</th>
                      <th scope="col" className="numeric">
                        Principal
                      </th>
                      <th scope="col" className="numeric">
                        Interest
                      </th>
                      <th scope="col" className="numeric">
                        Total
                      </th>
                      <th scope="col">Paid</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loan.schedule.instalments.map((instalment) => (
                      <tr
                        key={instalment.monthNumber}
                        className={instalment.isPaid ? 'row--muted' : ''}
                      >
                        <td>{instalment.monthNumber}</td>
                        <td>{formatDate(instalment.dueDate)}</td>
                        <td className="numeric">{formatMoney(instalment.principalDue)}</td>
                        <td className="numeric">{formatMoney(instalment.interestDue)}</td>
                        <td className="numeric">{formatMoney(instalment.totalDue)}</td>
                        <td>{instalment.isPaid ? 'Yes' : 'No'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {(loan.status === 'active' || loan.status === 'completed') && (
            <PaymentsPanel loan={loan} onChanged={refresh} />
          )}
        </div>
      </div>
    </div>
  );
}
