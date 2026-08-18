import {
  SAVINGS_DIRECTIONS,
  type SavingsAccount,
  type SavingsAccountStatus,
  type SavingsDirection,
  type SavingsProduct,
} from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import {
  branches as branchesApi,
  clients as clientsApi,
  savings as savingsApi,
} from '../../shared/api/endpoints.js';
import { formatDate, formatMoney, today } from '../../shared/lib/format.js';
import { Badge } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Savings.
 *
 * Deliberately less than a savings subsystem. §13.4 asks for the interest rate
 * basis, the accrual frequency, the minimum balance and the withdrawal rules,
 * and none of those are answered — so there is no interest anywhere on this
 * screen, and a balance is what was paid in less what was taken out. Inventing
 * a rate here would put a fabricated credit on a saver's account.
 *
 * What is here is what BOT's return cannot be filed without. **Compulsory
 * savings appears on three forms** — MSP2-01 Sno46, MSP2-03's provision
 * deduction and MSP2-10's per-district column, with validation rule 16 tying
 * the last to the first — which is why a product's compulsory flag is shown on
 * every account rather than left to a naming convention.
 *
 * No arithmetic happens in the browser. A deposit sends the amount and the
 * date; the server locks the account row, refuses an overdraft, and writes the
 * entry and the new balance together. The balance shown after is the server's.
 */

export function SavingsPage(): ReactNode {
  const session = useSession();
  const [status, setStatus] = useState<SavingsAccountStatus | ''>('active');
  const [opening, setOpening] = useState(false);

  const products = useQuery({
    queryKey: ['savings-products'],
    queryFn: () => savingsApi.products(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const accounts = useQuery({
    queryKey: ['savings-accounts', status],
    queryFn: () => savingsApi.listAccounts(status === '' ? {} : { status }),
  });

  const manageable = session.can('savings.manage');

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Savings</h1>
          <p className="page__subtitle">
            Balances as paid in, less what was taken out. No interest is accrued — §13.4 is
            unanswered.
          </p>
        </div>
      </div>

      {manageable && (
        <Panel
          title="Open an account"
          actions={
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                setOpening((open) => !open);
              }}
            >
              {opening ? 'Cancel' : 'Open one'}
            </button>
          }
        >
          {opening ? (
            <OpenAccountForm
              products={products.data ?? []}
              onOpened={() => {
                setOpening(false);
              }}
            />
          ) : (
            <p className="muted">
              An account is opened on a stated date. Nothing can be recorded against it before that
              day.
            </p>
          )}
        </Panel>
      )}

      <Panel
        title="Accounts"
        actions={
          <Field id="savings-status" label="Showing">
            {(props) => (
              <select
                {...props}
                className="input"
                value={status}
                onChange={(event) => {
                  setStatus(event.target.value as SavingsAccountStatus | '');
                }}
              >
                <option value="active">Active</option>
                <option value="dormant">Dormant</option>
                <option value="closed">Closed</option>
                <option value="">All</option>
              </select>
            )}
          </Field>
        }
      >
        {(accounts.isPending || products.isPending) && <Spinner label="Loading savings accounts" />}
        {accounts.error !== null && <ErrorNotice error={accounts.error} />}
        {products.error !== null && <ErrorNotice error={products.error} />}

        {accounts.data !== undefined &&
          (accounts.data.items.length === 0 ? (
            <EmptyState title="No accounts">
              MSP2-10 reports compulsory savings per district, and MSP2-01 Sno46 reports the total.
              Both are zero until an account exists.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Saver</th>
                    <th scope="col">Product</th>
                    <th scope="col">Opened</th>
                    <th scope="col" className="numeric">
                      Balance
                    </th>
                    <th scope="col">State</th>
                    {manageable && <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {accounts.data.items.map((account) => (
                    <AccountRow key={account.id} account={account} manageable={manageable} />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </div>
  );
}

/** One account, its statement, and the two things that may be recorded against it. */
function AccountRow({
  account,
  manageable,
}: {
  account: SavingsAccount;
  manageable: boolean;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const columns = manageable ? 7 : 6;

  return (
    <>
      <tr>
        <td>{account.accountCode}</td>
        <td>{account.clientName}</td>
        <td>
          {account.productName}
          {account.isCompulsory && (
            <>
              {' '}
              <Badge tone="info">Compulsory</Badge>
            </>
          )}
        </td>
        <td>{formatDate(account.openedOn)}</td>
        <td className="numeric">{formatMoney(account.balance)}</td>
        <td>
          <Badge
            tone={
              account.status === 'active'
                ? 'success'
                : account.status === 'dormant'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {account.status === 'active'
              ? 'Active'
              : account.status === 'dormant'
                ? 'Dormant'
                : 'Closed'}
          </Badge>
        </td>
        {manageable && (
          <td>
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                setExpanded((open) => !open);
              }}
            >
              {expanded ? 'Close' : 'Statement'}
            </button>
          </td>
        )}
      </tr>

      {expanded && (
        <tr>
          <td colSpan={columns}>
            <AccountStatement account={account} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * An account's ledger, and the form that adds to it.
 *
 * The ledger is append-only. There is no edit and no delete — the database
 * grants no privilege for either — so a mistake is corrected by a reversing
 * entry that leaves both the error and the correction on the statement.
 */
function AccountStatement({ account }: { account: SavingsAccount }): ReactNode {
  const queryClient = useQueryClient();

  const transactions = useQuery({
    queryKey: ['savings-transactions', account.id],
    queryFn: () => savingsApi.transactions(account.id),
  });

  const [direction, setDirection] = useState<SavingsDirection>('deposit');
  const [amount, setAmount] = useState('');
  const [transactionDate, setTransactionDate] = useState(today());
  const [narrative, setNarrative] = useState('');

  const record = useMutation({
    mutationFn: () =>
      savingsApi.recordEntry(account.id, {
        direction,
        amount,
        transactionDate,
        ...(narrative === '' ? {} : { narrative }),
      }),
    onSuccess: async () => {
      setAmount('');
      setNarrative('');
      await queryClient.invalidateQueries({ queryKey: ['savings-transactions', account.id] });
      await queryClient.invalidateQueries({ queryKey: ['savings-accounts'] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    record.error instanceof ApiRequestError ? record.error.fieldError(field) : undefined;

  const closed = account.status === 'closed';

  return (
    <>
      {closed ? (
        <p className="muted">
          This account is closed. A closed account holds nothing and takes no further entries.
        </p>
      ) : (
        <>
          <form
            className="report-controls"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              record.mutate();
            }}
          >
            <Field id={`direction-${account.id}`} label="Entry">
              {(props) => (
                <select
                  {...props}
                  className="input"
                  value={direction}
                  onChange={(event) => {
                    setDirection(event.target.value as SavingsDirection);
                  }}
                >
                  {SAVINGS_DIRECTIONS.map((option) => (
                    <option key={option} value={option}>
                      {option === 'deposit' ? 'Deposit' : 'Withdrawal'}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field
              id={`amount-${account.id}`}
              label="Amount"
              hint="A withdrawal beyond the balance is refused by the server; nothing here goes overdrawn."
              error={fieldError('amount')}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  inputMode="decimal"
                  value={amount}
                  required
                  onChange={(event) => {
                    setAmount(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              id={`transaction-date-${account.id}`}
              label="Date"
              hint={`Not before ${formatDate(account.openedOn)}, and never in the future.`}
              error={fieldError('transactionDate')}
            >
              {(props) => (
                <input
                  {...props}
                  className="input"
                  type="date"
                  value={transactionDate}
                  required
                  onChange={(event) => {
                    setTransactionDate(event.target.value);
                  }}
                />
              )}
            </Field>

            <Field id={`narrative-${account.id}`} label="Narrative" error={fieldError('narrative')}>
              {(props) => (
                <input
                  {...props}
                  className="input"
                  value={narrative}
                  maxLength={500}
                  onChange={(event) => {
                    setNarrative(event.target.value);
                  }}
                />
              )}
            </Field>

            <div className="report-controls__action">
              <button className="button button--primary" type="submit" disabled={record.isPending}>
                {record.isPending ? 'Recording…' : 'Record'}
              </button>
            </div>
          </form>

          {record.error !== null && <ErrorNotice error={record.error} />}
        </>
      )}

      {transactions.isPending && <Spinner label="Loading statement" />}
      {transactions.error !== null && <ErrorNotice error={transactions.error} />}

      {transactions.data !== undefined &&
        (transactions.data.length === 0 ? (
          <EmptyState title="Nothing recorded yet">
            The balance is zero until something is paid in.
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Entry</th>
                  <th scope="col" className="numeric">
                    Amount
                  </th>
                  <th scope="col" className="numeric">
                    Balance after
                  </th>
                  <th scope="col">Narrative</th>
                </tr>
              </thead>
              <tbody>
                {transactions.data.map((entry) => (
                  <tr key={entry.id}>
                    <td>{formatDate(entry.transactionDate)}</td>
                    <td>
                      {entry.direction === 'deposit' ? 'Deposit' : 'Withdrawal'}
                      {entry.reversesId !== null && (
                        <>
                          {' '}
                          <Badge tone="warning">Reversal</Badge>
                        </>
                      )}
                    </td>
                    <td className="numeric">{formatMoney(entry.amount)}</td>
                    <td className="numeric">{formatMoney(entry.balanceAfter)}</td>
                    <td>{entry.narrative ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </>
  );
}

/** Opening an account against a saver, a branch and a product. */
function OpenAccountForm({
  products,
  onOpened,
}: {
  products: readonly SavingsProduct[];
  onOpened: () => void;
}): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const branchList = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const clientList = useQuery({
    queryKey: ['clients', 'for-savings'],
    queryFn: () => clientsApi.list({ status: 'active', limit: 100 }),
  });

  const [clientId, setClientId] = useState('');
  const [branchId, setBranchId] = useState(session.user?.branch?.id ?? '');
  const [productId, setProductId] = useState('');
  const [openedOn, setOpenedOn] = useState(today());

  const open = useMutation({
    mutationFn: () => savingsApi.openAccount({ clientId, branchId, productId, openedOn }),
    onSuccess: async () => {
      setClientId('');
      setProductId('');
      onOpened();
      await queryClient.invalidateQueries({ queryKey: ['savings-accounts'] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    open.error instanceof ApiRequestError ? open.error.fieldError(field) : undefined;

  const openBranches = (branchList.data ?? []).filter((branch) => branch.status === 'active');
  const openProducts = products.filter((product) => product.status === 'active');

  return (
    <>
      <form
        className="product-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          open.mutate();
        }}
      >
        <Field
          id="savings-client"
          label="Saver"
          hint={
            clientList.data?.nextCursor === null || clientList.data === undefined
              ? undefined
              : 'Showing the first 100 active borrowers. A saver beyond them cannot be chosen here yet.'
          }
          error={fieldError('clientId')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={clientId}
              required
              onChange={(event) => {
                setClientId(event.target.value);
              }}
            >
              <option value="">Choose a borrower…</option>
              {(clientList.data?.items ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.fullName} · {client.clientCode}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field id="savings-branch" label="Branch" error={fieldError('branchId')}>
          {(props) => (
            <select
              {...props}
              className="input"
              value={branchId}
              required
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            >
              <option value="">Choose a branch…</option>
              {openBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="savings-product"
          label="Product"
          hint="A compulsory product's balances appear on three BOT forms; a voluntary one's appear on none."
          error={fieldError('productId')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={productId}
              required
              onChange={(event) => {
                setProductId(event.target.value);
              }}
            >
              <option value="">Choose a product…</option>
              {openProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                  {product.isCompulsory ? ' (compulsory)' : ''}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="savings-opened-on"
          label="Opened on"
          hint="Nothing can be recorded against the account before this day."
          error={fieldError('openedOn')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={openedOn}
              required
              onChange={(event) => {
                setOpenedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={open.isPending}>
            {open.isPending ? 'Opening…' : 'Open account'}
          </button>
        </div>
      </form>

      {open.error !== null && <ErrorNotice error={open.error} />}
    </>
  );
}
