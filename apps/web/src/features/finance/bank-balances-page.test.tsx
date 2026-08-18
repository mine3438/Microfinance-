import {
  type BankAccount,
  type BankAccountBalance,
  type FinancialInstitution,
} from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bank and MNO balances.
 *
 * This screen had no test, and that is why a labelling defect lived in it
 * unnoticed: its hints were rendered inside their `<label>` elements, so each
 * control's accessible name was its label followed by the whole hint. A screen
 * reader announced "Currency Anything but TZS needs a rate and rate date on
 * every balance" where it should have announced "Currency".
 *
 * The tests below pin the two things that keep the screen honest — the label
 * a control answers to, and the fact that no conversion happens here.
 */

const financialInstitutions = vi.fn<() => Promise<FinancialInstitution[]>>();
const listBankAccounts = vi.fn<() => Promise<BankAccount[]>>();
const listBankBalances = vi.fn<() => Promise<BankAccountBalance[]>>();
const openBankAccount = vi.fn<(request: unknown) => Promise<BankAccount>>();
const recordBankBalance = vi.fn<(...args: unknown[]) => Promise<BankAccountBalance>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  reference: {
    financialInstitutions: (): Promise<FinancialInstitution[]> => financialInstitutions(),
  },
  finance: {
    listBankAccounts: (): Promise<BankAccount[]> => listBankAccounts(),
    listBankBalances: (): Promise<BankAccountBalance[]> => listBankBalances(),
    openBankAccount: (request: unknown): Promise<BankAccount> => openBankAccount(request),
    recordBankBalance: (...args: unknown[]): Promise<BankAccountBalance> =>
      recordBankBalance(...args),
  },
}));

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: () => boolean } => ({ can: () => true }),
}));

const { BankBalancesPage } = await import('./bank-balances-page.js');

const INSTITUTIONS: FinancialInstitution[] = [
  // `inAgentBankingList` is BOT's fact about the institution, not a setting —
  // the two lists are published separately and an institution can be on one.
  {
    code: 'crdb',
    name: 'CRDB Bank Plc',
    kind: 'bank',
    inDepositsList: true,
    inAgentBankingList: true,
  },
  { code: 'mpesa', name: 'M-Pesa', kind: 'mno', inDepositsList: true, inAgentBankingList: false },
];

const TZS_ACCOUNT: BankAccount = {
  id: '019fef66-0000-7000-8000-00000000000a',
  holdingKind: 'bank_tanzania',
  institutionCode: 'crdb',
  counterpartyName: null,
  counterparty: 'CRDB Bank Plc',
  supportsAgentBanking: true,
  accountNumber: null,
  currencyCode: 'TZS',
  status: 'active',
  createdAt: '2026-01-02T08:00:00.000Z',
};

const USD_ACCOUNT: BankAccount = {
  ...TZS_ACCOUNT,
  id: '019fef66-0000-7000-8000-00000000000b',
  holdingKind: 'bank_abroad',
  institutionCode: null,
  counterpartyName: 'Standard Chartered London',
  counterparty: 'Standard Chartered London',
  supportsAgentBanking: false,
  currencyCode: 'USD',
};

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <BankBalancesPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  financialInstitutions.mockResolvedValue(INSTITUTIONS);
  listBankAccounts.mockResolvedValue([TZS_ACCOUNT]);
  listBankBalances.mockResolvedValue([]);
  openBankAccount.mockResolvedValue(TZS_ACCOUNT);
});

describe('field labelling', () => {
  it('names the currency field by its label alone, not by its label and its hint', async () => {
    renderPage();

    const currency = await screen.findByLabelText('Currency');
    expect(currency).toHaveValue('TZS');
    // The hint stays reachable as a description rather than as part of the name.
    expect(currency.getAttribute('aria-describedby')).toBe('currency-code-hint');
    expect(screen.getByText(/needs a rate and rate date/)).toBeInTheDocument();
  });

  it('names the counterparty field by its label alone, in the free-text sections', async () => {
    renderPage();

    // The two sections BOT publishes no list for ask for a name instead.
    await userEvent.selectOptions(await screen.findByLabelText('Section'), 'bank_abroad');

    const counterparty = screen.getByLabelText('Counterparty');
    expect(counterparty.getAttribute('aria-describedby')).toBe('counterparty-name-hint');
    expect(screen.getByText('BOT publishes no list for this section.')).toBeInTheDocument();
  });

  it('names the rate field by its label alone, on a foreign-currency account', async () => {
    listBankAccounts.mockResolvedValue([USD_ACCOUNT]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Record' }));

    const rate = screen.getByLabelText('Rate to TZS');
    expect(rate.getAttribute('aria-describedby')).toBe(`rate-${USD_ACCOUNT.id}-hint`);
    expect(screen.getByText(/unconfirmed \(§11\.6\)/)).toBeInTheDocument();
  });
});

describe('opening an account', () => {
  it('offers BOT’s list where BOT publishes one, and free text where it does not', async () => {
    renderPage();

    // A bank in Tanzania is chosen from BOT's list.
    expect(await screen.findByLabelText('Institution')).toBeInTheDocument();
    expect(screen.queryByLabelText('Counterparty')).toBeNull();

    await userEvent.selectOptions(screen.getByLabelText('Section'), 'bank_abroad');

    expect(screen.getByLabelText('Counterparty')).toBeInTheDocument();
    expect(screen.queryByLabelText('Institution')).toBeNull();
  });

  it('sends the institution code, never the name shown beside it', async () => {
    renderPage();

    // The select renders before BOT's list arrives, so wait for the option
    // rather than for the control.
    await screen.findByRole('option', { name: 'CRDB Bank Plc' });
    await userEvent.selectOptions(screen.getByLabelText('Institution'), 'crdb');
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));

    const sent = openBankAccount.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent['institutionCode']).toBe('crdb');
    expect(sent['counterpartyName']).toBeUndefined();
  });
});

describe('recording a balance', () => {
  it('sends the balance in the account’s own currency with the rate, never a TZS figure', async () => {
    // The conversion is the server's. This screen sends what was counted and
    // the rate it was counted at; multiplying here would put a rounded figure
    // on a BOT return with nothing to explain it.
    listBankAccounts.mockResolvedValue([USD_ACCOUNT]);
    recordBankBalance.mockResolvedValue({
      id: '019fef66-0000-7000-8000-00000000000c',
      bankAccountId: USD_ACCOUNT.id,
      counterparty: USD_ACCOUNT.counterparty,
      holdingKind: 'bank_abroad',
      year: 2026,
      quarter: 1,
      currencyCode: 'USD',
      depositBalance: '1000.00',
      borrowingBalance: '0.00',
      depositBalanceTzs: '2500000.00',
      borrowingBalanceTzs: '0.00',
      agentBankingBalance: '0.00',
      exchangeRate: '2500.00',
      rateDate: '2026-03-31',
      updatedAt: '2026-04-01T08:00:00.000Z',
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Record' }));
    await userEvent.clear(screen.getByLabelText('Deposits (USD)'));
    await userEvent.type(screen.getByLabelText('Deposits (USD)'), '1000.00');
    await userEvent.type(screen.getByLabelText('Rate to TZS'), '2500.00');
    await userEvent.type(screen.getByLabelText('Rate date'), '2026-03-31');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const sent = recordBankBalance.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent['depositBalance']).toBe('1000.00');
    expect(sent['exchangeRate']).toBe('2500.00');
    expect(sent['rateDate']).toBe('2026-03-31');
    // No TZS equivalent is computed on this side.
    expect('depositBalanceTzs' in sent).toBe(false);
  });

  it('asks for no rate on a TZS account, which converts at par', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Record' }));

    expect(screen.getByLabelText('Deposits (TZS)')).toBeInTheDocument();
    expect(screen.queryByLabelText('Rate to TZS')).toBeNull();
  });
});
