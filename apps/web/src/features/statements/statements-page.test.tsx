import { type Msp2_01, type StatementRow } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface View {
  form: 'MSP2-01' | 'MSP2-05';
  year: number;
  quarter: number;
  msp2_01?: Msp2_01;
}

const view = vi.fn<() => Promise<View>>();
const save = vi.fn<(...args: unknown[]) => Promise<View>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  statements: {
    view: (): Promise<View> => view(),
    save: (...args: unknown[]): Promise<View> => save(...args),
  },
}));

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: () => boolean } => ({ can: () => true }),
}));

const { StatementsPage } = await import('./statements-page.js');

const row = (
  sno: number,
  label: string,
  source: StatementRow['source'],
  amount: string,
): StatementRow => ({ sno, label, source, amount });

/** A balance sheet that does not balance: assets exceed the other side. */
const UNBALANCED: Msp2_01 = {
  rows: [
    row(2, '(a) Cash in Hand', 'entered', '1500000.00'),
    row(18, '(a) Loans to Clients', 'derived', '4500000.00'),
    row(33, '7. TOTAL ASSETS', 'computed', '6000000.00'),
    row(52, '(a) Paid-up Ordinary Share Capital', 'entered', '0.00'),
    row(61, '16. TOTAL LIABILITIES AND CAPITAL', 'computed', '0.00'),
  ],
  missingEntries: [52],
};

const BALANCED: Msp2_01 = {
  rows: [
    row(2, '(a) Cash in Hand', 'entered', '1500000.00'),
    row(18, '(a) Loans to Clients', 'derived', '4500000.00'),
    row(33, '7. TOTAL ASSETS', 'computed', '6000000.00'),
    row(52, '(a) Paid-up Ordinary Share Capital', 'entered', '6000000.00'),
    row(61, '16. TOTAL LIABILITIES AND CAPITAL', 'computed', '6000000.00'),
  ],
  missingEntries: [],
};

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <StatementsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  view.mockReset();
  save.mockReset();
  view.mockResolvedValue({ form: 'MSP2-01', year: 2026, quarter: 1, msp2_01: UNBALANCED });
  save.mockResolvedValue({ form: 'MSP2-01', year: 2026, quarter: 1, msp2_01: BALANCED });
});

describe('StatementsPage', () => {
  it('offers an input only for the lines the institution enters', async () => {
    renderPage();

    // Entered lines are typed in; derived and computed ones are shown. A screen
    // that rendered all three alike would hide which figures can be changed.
    expect(await screen.findByLabelText('2. (a) Cash in Hand')).toBeInTheDocument();
    expect(screen.queryByLabelText('18. (a) Loans to Clients')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('33. 7. TOTAL ASSETS')).not.toBeInTheDocument();
  });

  it('shows a derived figure without offering to let anyone type over it', async () => {
    renderPage();

    const table = await screen.findByRole('table');
    const loans = within(table).getByText('(a) Loans to Clients').closest('tr');
    if (loans === null) {
      throw new Error('The derived line was not rendered as a row.');
    }

    expect(within(loans).getByText('derived')).toBeInTheDocument();
    expect(within(loans).getByText('4,500,000.00')).toBeInTheDocument();
  });

  it('says the sheet does not balance, and what to check first', async () => {
    renderPage();

    expect(await screen.findByText('The sheet does not balance')).toBeInTheDocument();
    expect(screen.getByText(/1 line\(s\) have not been filled in yet/)).toBeInTheDocument();
  });

  it('sends only the figures that were changed, as strings', async () => {
    const user = userEvent.setup();
    renderPage();

    const capital = await screen.findByLabelText('52. (a) Paid-up Ordinary Share Capital');
    await user.clear(capital);
    await user.type(capital, '6000000.00');
    await user.click(screen.getByRole('button', { name: /Save 1 figure/ }));

    expect(save).toHaveBeenCalledTimes(1);

    const request = save.mock.calls[0]?.[3] as { lines: { sno: number; amount: string }[] };
    // Cash was untouched, so it is not resent — and the amount travels as a
    // string, because a JSON number would already have lost precision.
    expect(request.lines).toEqual([{ sno: 52, amount: '6000000.00' }]);
  });

  it('shows the totals the save moved, without a second request', async () => {
    const user = userEvent.setup();
    renderPage();

    const capital = await screen.findByLabelText('52. (a) Paid-up Ordinary Share Capital');
    await user.clear(capital);
    await user.type(capital, '6000000.00');
    await user.click(screen.getByRole('button', { name: /Save 1 figure/ }));

    // The response is the recompiled form, so a sheet that started balancing
    // says so immediately rather than after a refetch.
    expect(await screen.findByText('The sheet balances')).toBeInTheDocument();
    expect(view).toHaveBeenCalledTimes(1);
  });

  it('offers nothing to save until something changes', async () => {
    renderPage();

    const button = await screen.findByRole('button', { name: 'No changes' });
    expect(button).toBeDisabled();
  });
});
