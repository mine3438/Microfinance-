import { LOAN_STATUSES } from '@mfi/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { loans as loansApi } from '../../shared/api/endpoints.js';
import { formatMoney, formatStatus } from '../../shared/lib/format.js';
import { StatusBadge } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

export function LoansPage(): ReactNode {
  const session = useSession();
  const [status, setStatus] = useState('');

  const query = useQuery({
    queryKey: ['loans', { status }],
    queryFn: () => loansApi.list({ status: status === '' ? undefined : status, limit: 50 }),
  });

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Loans</h1>
        {session.can('loan.create') && (
          <Link className="button button--primary" to="/loans/new">
            New application
          </Link>
        )}
      </div>

      <Panel>
        <label className="search" htmlFor="loan-status">
          <span className="visually-hidden">Filter by status</span>
          <select
            id="loan-status"
            className="input"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
            }}
          >
            <option value="">All statuses</option>
            {LOAN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {formatStatus(value)}
              </option>
            ))}
          </select>
        </label>

        {query.isPending && <Spinner label="Loading loans" />}
        {query.error !== null && <ErrorNotice error={query.error} />}

        {query.data !== undefined &&
          (query.data.items.length === 0 ? (
            <EmptyState title={status === '' ? 'No loans yet' : 'No loans with that status'}>
              {status === ''
                ? 'Applications you record will appear here.'
                : 'Try a different status, or clear the filter.'}
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Loan</th>
                    <th scope="col">Borrower</th>
                    <th scope="col">Product</th>
                    <th scope="col" className="numeric">
                      Principal
                    </th>
                    <th scope="col" className="numeric">
                      Outstanding
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.items.map((loan) => (
                    <tr key={loan.id}>
                      <td>
                        <Link to={`/loans/${loan.id}`}>
                          <code>{loan.loanCode ?? 'Draft'}</code>
                        </Link>
                      </td>
                      <td>{loan.clientName}</td>
                      <td>{loan.productName}</td>
                      <td className="numeric">{formatMoney(loan.principal)}</td>
                      <td className="numeric">
                        {loan.outstandingBalance === null
                          ? '—'
                          : formatMoney(loan.outstandingBalance)}
                      </td>
                      <td>
                        <StatusBadge status={loan.status} />
                      </td>
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
