import {
  type Branch,
  type Client,
  type Page,
  type SavingsAccount,
  type SavingsProduct,
  type SavingsTransaction,
} from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Savings.
 *
 * Two properties carry the weight here, and both are things the screen must
 * *not* do. It computes no balance — the figure after an entry is the server's,
 * written under a row lock in the same transaction as the entry — and it
 * accrues no interest, because §13.4's rate basis, frequency, minimum balance
 * and withdrawal rules are all unanswered.
 *
 * The third is that a product's compulsory flag is visible on every account.
 * It decides whether the balance appears on three BOT forms or on none.
 */

const products = vi.fn<() => Promise<SavingsProduct[]>>();
const listAccounts = vi.fn<() => Promise<Page<SavingsAccount>>>();
const openAccount = vi.fn<(request: unknown) => Promise<SavingsAccount>>();
const transactions = vi.fn<() => Promise<SavingsTransaction[]>>();
const recordEntry = vi.fn<(...args: unknown[]) => Promise<SavingsTransaction>>();
const listBranches = vi.fn<() => Promise<Branch[]>>();
const listClients = vi.fn<() => Promise<Page<Client>>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  savings: {
    products: (): Promise<SavingsProduct[]> => products(),
    listAccounts: (): Promise<Page<SavingsAccount>> => listAccounts(),
    openAccount: (request: unknown): Promise<SavingsAccount> => openAccount(request),
    transactions: (): Promise<SavingsTransaction[]> => transactions(),
    recordEntry: (...args: unknown[]): Promise<SavingsTransaction> => recordEntry(...args),
  },
  branches: { list: (): Promise<Branch[]> => listBranches() },
  clients: { list: (): Promise<Page<Client>> => listClients() },
}));

let permissions = new Set<string>(['savings.read', 'savings.manage']);

const BRANCH_ID = '019fef66-0000-7000-8000-0000000000b1';

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: { id: BRANCH_ID, name: 'Head Office' } },
  }),
}));

const { SavingsPage } = await import('./savings-page.js');

const COMPULSORY: SavingsProduct = {
  id: '019fef66-0000-7000-8000-0000000000p1',
  code: 'CS',
  name: 'Compulsory Savings',
  isCompulsory: true,
  status: 'active',
};

const VOLUNTARY: SavingsProduct = {
  id: '019fef66-0000-7000-8000-0000000000p2',
  code: 'VS',
  name: 'Voluntary Savings',
  isCompulsory: false,
  status: 'active',
};

const RETIRED: SavingsProduct = {
  id: '019fef66-0000-7000-8000-0000000000p3',
  code: 'OLD',
  name: 'Withdrawn Product',
  isCompulsory: false,
  status: 'closed',
};

const account = (overrides: Partial<SavingsAccount> = {}): SavingsAccount => ({
  id: '019fef66-0000-7000-8000-0000000000a1',
  accountCode: 'SAV-0001',
  clientId: '019fef66-0000-7000-8000-0000000000cl',
  clientName: 'Neema Kimaro',
  branchId: BRANCH_ID,
  branchName: 'Head Office',
  productId: COMPULSORY.id,
  productName: 'Compulsory Savings',
  isCompulsory: true,
  status: 'active',
  openedOn: '2026-01-15',
  closedOn: null,
  balance: '450000.00',
  createdAt: '2026-01-15T08:00:00.000Z',
  updatedAt: '2026-02-01T08:00:00.000Z',
  ...overrides,
});

const entry = (overrides: Partial<SavingsTransaction> = {}): SavingsTransaction => ({
  id: '019fef66-0000-7000-8000-0000000000t1',
  savingsAccountId: '019fef66-0000-7000-8000-0000000000a1',
  direction: 'deposit',
  amount: '450000.00',
  balanceAfter: '450000.00',
  transactionDate: '2026-01-20',
  narrative: 'Opening deposit',
  reference: null,
  reversesId: null,
  recordedBy: '019fef66-0000-7000-8000-0000000000u1',
  createdAt: '2026-01-20T08:00:00.000Z',
  ...overrides,
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <SavingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['savings.read', 'savings.manage']);
  products.mockResolvedValue([COMPULSORY, VOLUNTARY, RETIRED]);
  listAccounts.mockResolvedValue({ items: [account()], nextCursor: null });
  openAccount.mockResolvedValue(account());
  transactions.mockResolvedValue([entry()]);
  recordEntry.mockResolvedValue(entry());
  listBranches.mockResolvedValue([
    {
      id: BRANCH_ID,
      code: 'HO',
      name: 'Head Office',
      isHeadOffice: true,
      status: 'active',
      districtCode: 'tz_arusha__karatu',
      districtName: 'Karatu DC',
    },
  ]);
  listClients.mockResolvedValue({ items: [], nextCursor: null });
});

describe('what the screen does not do', () => {
  it('offers no interest rate, accrual or posting control anywhere', async () => {
    // §13.4 is unanswered. A rate on this screen would be a fabricated credit
    // on a saver's account.
    renderPage();

    await screen.findByText('SAV-0001');
    expect(screen.queryByLabelText(/interest/i)).toBeNull();
    expect(screen.queryByText(/interest rate/i)).toBeNull();
    expect(screen.getByText(/No interest is accrued/)).toBeInTheDocument();
  });

  it('never sends a balance, only the amount and the date', async () => {
    // The balance is the server's: it locks the row, refuses an overdraft, and
    // writes the entry and the new balance together. A browser-computed figure
    // would be computed from a balance that may already be stale.
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));
    await userEvent.type(screen.getByLabelText('Amount'), '50000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));

    const sent = recordEntry.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(sent['amount']).toBe('50000.00');
    expect('balance' in sent).toBe(false);
    expect('balanceAfter' in sent).toBe(false);
  });

  it('omits a blank narrative rather than sending an empty string', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));
    await userEvent.type(screen.getByLabelText('Amount'), '50000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record' }));

    const sent = recordEntry.mock.calls[0]?.[1] as Record<string, unknown>;
    expect('narrative' in sent).toBe(false);
  });
});

describe('compulsory savings', () => {
  it('marks a compulsory account, because the flag decides three BOT forms', async () => {
    renderPage();

    const row = (await screen.findByText('SAV-0001')).closest('tr');
    if (row === null) {
      throw new Error('The account was not rendered inside a table row.');
    }
    expect(within(row).getByText('Compulsory')).toBeInTheDocument();
  });

  it('leaves a voluntary account unmarked', async () => {
    listAccounts.mockResolvedValue({
      items: [account({ productName: 'Voluntary Savings', isCompulsory: false })],
      nextCursor: null,
    });
    renderPage();

    const row = (await screen.findByText('SAV-0001')).closest('tr');
    if (row === null) {
      throw new Error('The account was not rendered inside a table row.');
    }
    expect(within(row).queryByText('Compulsory')).toBeNull();
  });

  it('says which products are compulsory when opening an account', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Open one' }));

    const options = within(screen.getByLabelText('Product'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual([
      'Choose a product…',
      'Compulsory Savings (compulsory)',
      'Voluntary Savings',
    ]);
  });

  it('does not offer a withdrawn product', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Open one' }));

    const options = within(screen.getByLabelText('Product'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).not.toContain('Withdrawn Product');
  });
});

describe('the statement', () => {
  it('shows the balance each entry left behind, from the server', async () => {
    transactions.mockResolvedValue([
      entry(),
      entry({
        id: '019fef66-0000-7000-8000-0000000000t2',
        direction: 'withdrawal',
        amount: '50000.00',
        balanceAfter: '400000.00',
        transactionDate: '2026-02-01',
        narrative: 'Partial withdrawal',
      }),
    ]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));

    expect(await screen.findByText('400,000.00')).toBeInTheDocument();
    expect(screen.getByText('Partial withdrawal')).toBeInTheDocument();
  });

  it('marks a reversing entry, which is how a mistake is corrected', async () => {
    // The ledger is append-only and the database grants no update or delete, so
    // both the error and the correction stay on the statement.
    transactions.mockResolvedValue([
      entry(),
      entry({
        id: '019fef66-0000-7000-8000-0000000000t3',
        direction: 'withdrawal',
        amount: '450000.00',
        balanceAfter: '0.00',
        reversesId: '019fef66-0000-7000-8000-0000000000t1',
        narrative: 'Entered against the wrong account',
      }),
    ]);
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));

    expect(await screen.findByText('Reversal')).toBeInTheDocument();
  });

  it('says the account’s opening date is the earliest an entry can be dated', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));

    expect(screen.getByText(/Not before 15 Jan 2026/)).toBeInTheDocument();
  });

  it('takes no entries against a closed account', async () => {
    listAccounts.mockResolvedValue({
      items: [account({ status: 'closed', closedOn: '2026-03-01', balance: '0.00' })],
      nextCursor: null,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Statement' }));

    expect(screen.getByText(/takes no further entries/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record' })).toBeNull();
  });
});

describe('permissions', () => {
  it('shows a reader the balances but no way to change them', async () => {
    permissions = new Set(['savings.read']);
    renderPage();

    await screen.findByText('SAV-0001');
    expect(screen.getByText('450,000.00')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open one' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Statement' })).toBeNull();
  });
});
