import { type LoanWithSchedule, type Payment, type SettlementQuote } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../shared/api/client.js';

/**
 * Early settlement.
 *
 * The property under test throughout is that **the browser computes nothing**.
 * Every figure shown is rendered from the quote exactly as the server sent it,
 * and the amount submitted is the quoted total unchanged. The deliberately
 * inconsistent fixture below is how that is proved: its parts do not add up to
 * its total, and the screen still shows both, because a screen that recomputed
 * would show its own answer instead.
 */

const settlementQuote = vi.fn<(...args: unknown[]) => Promise<SettlementQuote>>();
const settle = vi.fn<(...args: unknown[]) => Promise<Payment>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  loanEvents: {
    settlementQuote: (...args: unknown[]): Promise<SettlementQuote> => settlementQuote(...args),
    settle: (...args: unknown[]): Promise<Payment> => settle(...args),
  },
}));

let permissions = new Set<string>(['payment.read', 'payment.create']);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: null },
  }),
}));

const { SettlementPanel } = await import('./settlement-panel.js');

const LOAN_ID = '019fef66-0000-7000-8000-0000000000l1';

const loan = (overrides: Partial<LoanWithSchedule> = {}): LoanWithSchedule =>
  ({
    id: LOAN_ID,
    loanCode: 'LN-0001',
    clientId: '019fef66-0000-7000-8000-0000000000c1',
    clientName: 'Neema Kimaro',
    productId: '019fef66-0000-7000-8000-0000000000p1',
    productName: 'Business Loan',
    branchId: '019fef66-0000-7000-8000-0000000000b1',
    branchName: 'Head Office',
    principal: '1200000.00',
    monthlyRate: '0.0200',
    interestMethod: 'flat',
    termMonths: 10,
    status: 'active',
    outstandingBalance: '720000.00',
    penaltyBalance: '0.00',
    disbursementDate: '2026-01-10',
    rejectionReason: null,
    restructuredIntoLoanId: null,
    restructuredFromLoanId: null,
    createdAt: '2026-01-01T08:00:00.000Z',
    schedule: null,
    ...overrides,
  }) as LoanWithSchedule;

/**
 * A quote whose parts deliberately do not sum to its total.
 *
 * 720,000 + 24,000 + 5,500 is 749,500, and the total says 800,000. No real
 * quote looks like this. It is here so that any component that added the parts
 * up itself, or that checked them, would disagree with the server and fail —
 * which is exactly the behaviour these tests exist to forbid.
 */
const QUOTE: SettlementQuote = {
  loanId: LOAN_ID,
  settlementDate: '2026-06-15',
  chargedThrough: '2026-06-30',
  principal: '720000.00',
  interest: '24000.00',
  penalty: '5500.00',
  total: '800000.00',
  interestNotCharged: '48000.00',
};

const payment = (): Payment =>
  ({
    id: '019fef66-0000-7000-8000-0000000000y1',
    loanId: LOAN_ID,
    amountPaid: '800000.00',
    datePaid: '2026-06-15',
  }) as Payment;

function renderPanel(loanOverrides: Partial<LoanWithSchedule> = {}): {
  onSettled: () => Promise<void>;
} {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onSettled = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  render(
    <QueryClientProvider client={queryClient}>
      <SettlementPanel loan={loan(loanOverrides)} onSettled={onSettled} />
    </QueryClientProvider>,
  );

  return { onSettled };
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['payment.read', 'payment.create']);
  settlementQuote.mockResolvedValue(QUOTE);
  settle.mockResolvedValue(payment());
});

/**
 * Narrow away the `null` that DOM traversal returns.
 *
 * `closest()` is typed as possibly null, but a test that reached this line has
 * already found the element it started from. Throwing here fails the test with
 * a readable message instead of an assertion the lint rules forbid.
 */
function must<T>(value: T | null): T {
  if (value === null) {
    throw new Error('Expected an element, and the DOM had none.');
  }
  return value;
}

describe('the quote', () => {
  it('comes from the server rather than from the loan on screen', async () => {
    renderPanel();

    await screen.findByText('720,000.00');
    expect(settlementQuote).toHaveBeenCalledWith(LOAN_ID, expect.any(String));
  });

  it('shows the four figures the server sent, unaltered', async () => {
    renderPanel();

    const table = (await screen.findByText('720,000.00')).closest('table');
    expect(table).not.toBeNull();

    const rows = within(must(table)).getAllByRole('row');
    const cells = rows.map((row) => row.textContent);

    expect(cells.some((text) => text.includes('720,000.00'))).toBe(true);
    expect(cells.some((text) => text.includes('24,000.00'))).toBe(true);
    expect(cells.some((text) => text.includes('5,500.00'))).toBe(true);
    // The total the server sent, not the sum of the three above it.
    expect(cells.some((text) => text.includes('TZS 800,000.00'))).toBe(true);
  });

  it('names the month interest is charged through', async () => {
    renderPanel();

    expect(await screen.findByText(/Interest to 30 Jun 2026/)).toBeInTheDocument();
  });

  it('reports what settling early saves, from the server’s figure', async () => {
    renderPanel();

    expect(await screen.findByText(/TZS 48,000.00/)).toBeInTheDocument();
  });

  it('re-requests the quote when the settlement date changes', async () => {
    renderPanel();
    await screen.findByText('720,000.00');

    await userEvent.clear(screen.getByLabelText('Settlement date'));
    await userEvent.type(screen.getByLabelText('Settlement date'), '2026-07-20');

    await vi.waitFor(() => {
      expect(settlementQuote).toHaveBeenCalledWith(LOAN_ID, '2026-07-20');
    });
  });

  it('shows the failure rather than a blank breakdown', async () => {
    settlementQuote.mockRejectedValue(
      new ApiRequestError('not_found', 'That loan cannot be settled.', 404),
    );
    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('That loan cannot be settled.');
    expect(screen.queryByRole('button', { name: 'Settle this loan' })).not.toBeInTheDocument();
  });
});

describe('taking the settlement', () => {
  const confirm = async (): Promise<void> => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Settle this loan' }));
  };

  it('asks for confirmation before it closes anything', async () => {
    await confirm();

    expect(
      screen.getByText(/This closes the loan against a payment of TZS 800,000.00/),
    ).toBeInTheDocument();
    expect(settle).not.toHaveBeenCalled();
  });

  /**
   * The submitted amount is the quoted total, character for character.
   *
   * The server compares the two and refuses a mismatch, which is what makes a
   * stale screen safe — but only if the screen sends back what it was given
   * rather than a figure it worked out.
   */
  it('submits the quoted total exactly as it was received', async () => {
    await confirm();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm TZS 800,000.00 received' }));

    expect(settle).toHaveBeenCalledWith(
      LOAN_ID,
      expect.objectContaining({ amountPaid: '800000.00', settlementDate: '2026-06-15' }),
    );
  });

  it('refreshes the loan once the settlement is recorded', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSettled = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    render(
      <QueryClientProvider client={queryClient}>
        <SettlementPanel loan={loan()} onSettled={onSettled} />
      </QueryClientProvider>,
    );

    await userEvent.click(await screen.findByRole('button', { name: 'Settle this loan' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm TZS 800,000.00 received' }));

    await vi.waitFor(() => {
      expect(onSettled).toHaveBeenCalled();
    });
  });

  it('surfaces a refusal rather than appearing to have settled', async () => {
    settle.mockRejectedValue(
      new ApiRequestError(
        'conflict',
        'The settlement figure has changed since it was quoted.',
        409,
      ),
    );

    await confirm();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm TZS 800,000.00 received' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The settlement figure has changed since it was quoted.',
    );
  });

  it('cannot be submitted twice while the first request is in flight', async () => {
    let release = (): void => undefined;
    settle.mockReturnValue(
      new Promise<Payment>((resolve) => {
        release = () => {
          resolve(payment());
        };
      }),
    );

    await confirm();
    const button = screen.getByRole('button', { name: 'Confirm TZS 800,000.00 received' });
    await userEvent.click(button);

    const pending = await screen.findByRole('button', { name: 'Recording…' });
    expect(pending).toBeDisabled();
    await userEvent.click(pending);
    expect(settle).toHaveBeenCalledTimes(1);

    release();
  });
});

describe('who and when', () => {
  it('offers no settlement control to someone who may only read', async () => {
    permissions = new Set(['payment.read']);
    renderPanel();

    await screen.findByText('720,000.00');
    expect(screen.queryByRole('button', { name: 'Settle this loan' })).not.toBeInTheDocument();
  });

  it('shows nothing on a loan that is not active', () => {
    renderPanel({ status: 'completed' });

    expect(screen.queryByText('Settle early')).not.toBeInTheDocument();
    expect(settlementQuote).not.toHaveBeenCalled();
  });

  it('shows nothing to someone without the read permission', () => {
    permissions = new Set([]);
    renderPanel();

    expect(screen.queryByText('Settle early')).not.toBeInTheDocument();
    expect(settlementQuote).not.toHaveBeenCalled();
  });
});

/**
 * The application fee is not part of a settlement.
 *
 * It is not principal, not interest, and not a balance the allocator can
 * reach — so it must not appear in this figure or beside it as though it were.
 */
describe('what a settlement does not include', () => {
  it('says the application fee is separate', async () => {
    renderPanel();

    expect(
      await screen.findByText(/The application fee is separate and is not part of this figure/),
    ).toBeInTheDocument();
  });

  it('offers no restructuring alternative', async () => {
    renderPanel();
    await screen.findByText('720,000.00');

    expect(document.body.textContent).not.toMatch(/restructur/i);
  });
});
