import { HOLDING_KINDS, type BankAccount, type HoldingKind } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { finance as financeApi, reference } from '../../shared/api/endpoints.js';
import { formatDate, formatMoney, formatQuarter } from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';
import { lastCompletedQuarter } from '../reports/reports-page.js';

/**
 * Where the institution's money sits, and what it held at each quarter end.
 *
 * BOT publishes a fixed list for two of MSP2-07's four sections and not the
 * other two, so this screen asks for a bank by name from a list and for a
 * microfinance provider or a foreign bank as free text. Which it asks for
 * follows the section chosen; sending both is refused by the server and by the
 * database beneath it.
 *
 * Agent-banking eligibility is never asked. It is BOT's fact about the
 * institution, read from their list when the account is opened.
 */

const SECTION_LABELS: Record<HoldingKind, string> = {
  bank_tanzania: 'Bank in Tanzania',
  microfinance_service_provider: 'Microfinance service provider',
  mno: 'Mobile network operator',
  bank_abroad: 'Bank abroad',
};

/** The sections BOT publishes a list for. */
const LISTED: ReadonlySet<HoldingKind> = new Set<HoldingKind>(['bank_tanzania', 'mno']);

export function BankBalancesPage(): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const initial = lastCompletedQuarter();

  const [period, setPeriod] = useState(initial);
  const [holdingKind, setHoldingKind] = useState<HoldingKind>('bank_tanzania');
  const [institutionCode, setInstitutionCode] = useState('');
  const [counterpartyName, setCounterpartyName] = useState('');
  const [currencyCode, setCurrencyCode] = useState('TZS');

  const institutions = useQuery({
    queryKey: ['financial-institutions'],
    queryFn: () => reference.financialInstitutions(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const accounts = useQuery({
    queryKey: ['bank-accounts'],
    queryFn: () => financeApi.listBankAccounts(),
  });

  const balances = useQuery({
    queryKey: ['bank-balances', period],
    queryFn: () => financeApi.listBankBalances(period.year, period.quarter),
  });

  const open = useMutation({
    mutationFn: () =>
      financeApi.openBankAccount({
        holdingKind,
        ...(LISTED.has(holdingKind) ? { institutionCode } : { counterpartyName }),
        currencyCode,
      }),
    onSuccess: async () => {
      setInstitutionCode('');
      setCounterpartyName('');
      setCurrencyCode('TZS');
      await queryClient.invalidateQueries({ queryKey: ['bank-accounts'] });
    },
  });

  const listed = LISTED.has(holdingKind);
  const choices = (institutions.data ?? []).filter((institution) =>
    holdingKind === 'mno' ? institution.kind === 'mno' : institution.kind === 'bank',
  );
  const fieldError = (field: string): string | undefined =>
    open.error instanceof ApiRequestError ? open.error.fieldError(field) : undefined;

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Bank and MNO balances</h1>
          <p className="page__subtitle">
            Quarter-end positions for MSP2-07 and MSP2-08 —{' '}
            {formatQuarter(period.year, period.quarter)}
          </p>
        </div>
      </div>

      {session.can('expense.manage') && (
        <Panel title="Open an account">
          <form
            className="report-controls"
            onSubmit={(event) => {
              event.preventDefault();
              open.mutate();
            }}
          >
            <label className="field field--wide" htmlFor="holding-kind">
              <span className="field__label">Section</span>
              <select
                id="holding-kind"
                className="input"
                value={holdingKind}
                onChange={(event) => {
                  setHoldingKind(event.target.value as HoldingKind);
                  setInstitutionCode('');
                  setCounterpartyName('');
                }}
              >
                {HOLDING_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {SECTION_LABELS[kind]}
                  </option>
                ))}
              </select>
            </label>

            {listed ? (
              <label className="field field--wide" htmlFor="institution-code">
                <span className="field__label">Institution</span>
                <select
                  id="institution-code"
                  className="input"
                  value={institutionCode}
                  required
                  onChange={(event) => {
                    setInstitutionCode(event.target.value);
                  }}
                >
                  <option value="">Choose from BOT&rsquo;s list…</option>
                  {choices.map((institution) => (
                    <option key={institution.code} value={institution.code}>
                      {institution.name}
                    </option>
                  ))}
                </select>
                {fieldError('institutionCode') !== undefined && (
                  <span className="field__error">{fieldError('institutionCode')}</span>
                )}
              </label>
            ) : (
              <label className="field field--wide" htmlFor="counterparty-name">
                <span className="field__label">Counterparty</span>
                <input
                  id="counterparty-name"
                  className="input"
                  value={counterpartyName}
                  required
                  onChange={(event) => {
                    setCounterpartyName(event.target.value);
                  }}
                />
                <span className="field__hint">BOT publishes no list for this section.</span>
                {fieldError('counterpartyName') !== undefined && (
                  <span className="field__error">{fieldError('counterpartyName')}</span>
                )}
              </label>
            )}

            <label className="field" htmlFor="currency-code">
              <span className="field__label">Currency</span>
              <input
                id="currency-code"
                className="input"
                value={currencyCode}
                maxLength={3}
                onChange={(event) => {
                  setCurrencyCode(event.target.value.toUpperCase());
                }}
              />
              <span className="field__hint">
                Anything but TZS needs a rate and rate date on every balance.
              </span>
            </label>

            <div className="report-controls__action">
              <button className="button button--primary" type="submit" disabled={open.isPending}>
                {open.isPending ? 'Opening…' : 'Open'}
              </button>
            </div>
          </form>

          {open.error !== null && <ErrorNotice error={open.error} />}
        </Panel>
      )}

      <Panel
        title="Quarter-end balances"
        actions={
          <div className="report-controls">
            <label className="field" htmlFor="balance-year">
              <span className="visually-hidden">Year</span>
              <input
                id="balance-year"
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
            <label className="field" htmlFor="balance-quarter">
              <span className="visually-hidden">Quarter</span>
              <select
                id="balance-quarter"
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
        }
      >
        {(accounts.isPending || balances.isPending) && <Spinner label="Loading balances" />}
        {accounts.error !== null && <ErrorNotice error={accounts.error} />}
        {balances.error !== null && <ErrorNotice error={balances.error} />}

        {accounts.data !== undefined &&
          (accounts.data.length === 0 ? (
            <EmptyState title="No accounts yet">
              MSP2-07 and MSP2-08 are compiled from the balances recorded against these accounts.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Counterparty</th>
                    <th scope="col">Section</th>
                    <th scope="col">Currency</th>
                    <th scope="col" className="numeric">
                      Deposits
                    </th>
                    <th scope="col" className="numeric">
                      Borrowings
                    </th>
                    <th scope="col" className="numeric">
                      Agent banking
                    </th>
                    <th scope="col">Rate</th>
                    {session.can('expense.manage') && <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {accounts.data.map((account) => (
                    <BalanceRow
                      key={account.id}
                      account={account}
                      year={period.year}
                      quarter={period.quarter}
                      editable={session.can('expense.manage')}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </div>
  );
}

/**
 * One account's figure for the chosen quarter.
 *
 * The TZS equivalent is never entered. A foreign balance is sent with its rate
 * and the server does the multiplication in exact decimal arithmetic — the one
 * place that conversion is allowed to happen.
 */
function BalanceRow({
  account,
  year,
  quarter,
  editable,
}: {
  account: BankAccount;
  year: number;
  quarter: number;
  editable: boolean;
}): ReactNode {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [deposit, setDeposit] = useState('0');
  const [borrowing, setBorrowing] = useState('0');
  const [agentBanking, setAgentBanking] = useState('0');
  const [rate, setRate] = useState('');
  const [rateDate, setRateDate] = useState('');

  const balances = useQuery({
    queryKey: ['bank-balances', { year, quarter }],
    queryFn: () => financeApi.listBankBalances(year, quarter),
  });

  const balance = balances.data?.find((entry) => entry.bankAccountId === account.id);
  const inTzs = account.currencyCode === 'TZS';

  const save = useMutation({
    mutationFn: () =>
      financeApi.recordBankBalance(account.id, {
        year,
        quarter: quarter as 1 | 2 | 3 | 4,
        depositBalance: deposit,
        borrowingBalance: borrowing,
        agentBankingBalance: agentBanking,
        ...(inTzs ? {} : { exchangeRate: rate, rateDate }),
      }),
    onSuccess: async () => {
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: ['bank-balances'] });
    },
  });

  const columns = editable ? 8 : 7;

  return (
    <>
      <tr>
        <td>{account.counterparty}</td>
        <td>{SECTION_LABELS[account.holdingKind]}</td>
        <td>{account.currencyCode}</td>
        <td className="numeric">
          {balance === undefined ? '—' : formatMoney(balance.depositBalanceTzs)}
        </td>
        <td className="numeric">
          {balance === undefined ? '—' : formatMoney(balance.borrowingBalanceTzs)}
        </td>
        <td className="numeric">
          {account.supportsAgentBanking
            ? balance === undefined
              ? '—'
              : formatMoney(balance.agentBankingBalance)
            : 'n/a'}
        </td>
        <td>
          {balance?.rateDate === undefined || balance.rateDate === null
            ? '—'
            : `${balance.exchangeRate ?? ''} @ ${formatDate(balance.rateDate)}`}
        </td>
        {editable && (
          <td>
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                setDeposit(balance?.depositBalance ?? '0');
                setBorrowing(balance?.borrowingBalance ?? '0');
                setAgentBanking(balance?.agentBankingBalance ?? '0');
                setRate(balance?.exchangeRate ?? '');
                setRateDate(balance?.rateDate ?? '');
                setEditing((open) => !open);
              }}
            >
              {editing ? 'Cancel' : balance === undefined ? 'Record' : 'Restate'}
            </button>
          </td>
        )}
      </tr>

      {editing && (
        <tr>
          <td colSpan={columns}>
            <form
              className="report-controls"
              onSubmit={(event) => {
                event.preventDefault();
                save.mutate();
              }}
            >
              <label className="field" htmlFor={`deposit-${account.id}`}>
                <span className="field__label">Deposits ({account.currencyCode})</span>
                <input
                  id={`deposit-${account.id}`}
                  className="input"
                  inputMode="decimal"
                  value={deposit}
                  onChange={(event) => {
                    setDeposit(event.target.value);
                  }}
                />
              </label>

              <label className="field" htmlFor={`borrowing-${account.id}`}>
                <span className="field__label">Borrowings ({account.currencyCode})</span>
                <input
                  id={`borrowing-${account.id}`}
                  className="input"
                  inputMode="decimal"
                  value={borrowing}
                  onChange={(event) => {
                    setBorrowing(event.target.value);
                  }}
                />
              </label>

              {account.supportsAgentBanking && (
                <label className="field" htmlFor={`agent-${account.id}`}>
                  <span className="field__label">Agent banking</span>
                  <input
                    id={`agent-${account.id}`}
                    className="input"
                    inputMode="decimal"
                    value={agentBanking}
                    onChange={(event) => {
                      setAgentBanking(event.target.value);
                    }}
                  />
                </label>
              )}

              {!inTzs && (
                <>
                  <label className="field" htmlFor={`rate-${account.id}`}>
                    <span className="field__label">Rate to TZS</span>
                    <input
                      id={`rate-${account.id}`}
                      className="input"
                      inputMode="decimal"
                      value={rate}
                      required
                      onChange={(event) => {
                        setRate(event.target.value);
                      }}
                    />
                    <span className="field__hint">
                      Which rate BOT expects is unconfirmed (§11.6); the one used is recorded.
                    </span>
                  </label>

                  <label className="field" htmlFor={`rate-date-${account.id}`}>
                    <span className="field__label">Rate date</span>
                    <input
                      id={`rate-date-${account.id}`}
                      className="input"
                      type="date"
                      value={rateDate}
                      required
                      onChange={(event) => {
                        setRateDate(event.target.value);
                      }}
                    />
                  </label>
                </>
              )}

              <div className="report-controls__action">
                <button className="button button--primary" type="submit" disabled={save.isPending}>
                  {save.isPending ? 'Saving…' : 'Save'}
                </button>
              </div>
            </form>

            {save.error !== null && <ErrorNotice error={save.error} />}
          </td>
        </tr>
      )}
    </>
  );
}
