import { type ApplicationFee, type LoanWithSchedule } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../shared/api/client.js';

/**
 * The application/form fee.
 *
 * These tests pin the three things about this fee that are easy to get wrong
 * and expensive to get wrong.
 *
 * A resubmitted application must never be asked for a second TZS 5,000. The
 * approved rule is once per *application*, and because a rejection returns the
 * loan to `draft`, a screen keyed on status would ask again on every resubmission.
 *
 * Refund entitlement must not come from `status === 'rejected'` — that is false
 * for exactly the applications a refund is owed on, for the same reason.
 *
 * And "we owe you this" must not read as "we have paid you this".
 */

const applicationFee = vi.fn<() => Promise<ApplicationFee | null>>();
const collectApplicationFee = vi.fn<(...args: unknown[]) => Promise<ApplicationFee>>();
const refundApplicationFee = vi.fn<(...args: unknown[]) => Promise<ApplicationFee>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  loanEvents: {
    applicationFee: (): Promise<ApplicationFee | null> => applicationFee(),
    collectApplicationFee: (...args: unknown[]): Promise<ApplicationFee> =>
      collectApplicationFee(...args),
    refundApplicationFee: (...args: unknown[]): Promise<ApplicationFee> =>
      refundApplicationFee(...args),
  },
}));

let permissions = new Set<string>(['payment.read', 'payment.create']);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: null },
  }),
}));

const { ApplicationFeePanel } = await import('./application-fee-panel.js');

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
    status: 'draft',
    outstandingBalance: null,
    penaltyBalance: null,
    disbursementDate: null,
    rejectionReason: null,
    restructuredIntoLoanId: null,
    restructuredFromLoanId: null,
    createdAt: '2026-02-01T08:00:00.000Z',
    schedule: null,
    ...overrides,
  }) as LoanWithSchedule;

const fee = (overrides: Partial<ApplicationFee> = {}): ApplicationFee => ({
  id: '019fef66-0000-7000-8000-0000000000f1',
  loanId: LOAN_ID,
  amount: '5000.00',
  collectedOn: '2026-02-01',
  method: 'Cash',
  reference: 'RCT-0001',
  collectedBy: '019fef66-0000-7000-8000-0000000000u1',
  collectedByName: 'Asha Mwakalinga',
  state: 'collected',
  refundedOn: null,
  refundedBy: null,
  refundedByName: null,
  refundReason: null,
  ...overrides,
});

function renderPanel(loanOverrides: Partial<LoanWithSchedule> = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <ApplicationFeePanel loan={loan(loanOverrides)} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['payment.read', 'payment.create']);
  applicationFee.mockResolvedValue(null);
  collectApplicationFee.mockResolvedValue(fee());
  refundApplicationFee.mockResolvedValue(
    fee({ state: 'refunded', refundedOn: '2026-03-01', refundedByName: 'Asha Mwakalinga' }),
  );
});

describe('before a fee is taken', () => {
  it('names the fixed charge and offers to record it', async () => {
    renderPanel();

    // The figure appears in the sentence and again on the button, so the
    // sentence is matched by its own wording rather than by the amount alone.
    expect(await screen.findByText(/The charge is/)).toHaveTextContent('TZS 5,000.00');
    expect(
      screen.getByRole('button', { name: 'Record TZS 5,000.00 received' }),
    ).toBeInTheDocument();
  });

  /**
   * The amount is never sent.
   *
   * It is fixed policy held by the server. A request that could carry it is a
   * request through which a counter typo becomes the fee.
   */
  it('sends no amount, because the figure is not the teller’s to choose', async () => {
    renderPanel();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Record TZS 5,000.00 received' }),
    );

    expect(collectApplicationFee).toHaveBeenCalledWith(
      LOAN_ID,
      expect.not.objectContaining({ amount: expect.anything() as unknown }),
    );
  });

  it('offers no collection control to someone who may only read', async () => {
    permissions = new Set(['payment.read']);
    renderPanel();

    expect(await screen.findByText(/No application fee has been recorded/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Record/ })).not.toBeInTheDocument();
  });
});

describe('once a fee has been taken', () => {
  it('shows it as collected while the application is undecided', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'collected' }));
    renderPanel();

    // 'Collected' is both the state badge and the label of the date it was
    // taken on, so the badge is identified by its class rather than its text.
    const badge = (await screen.findByText(/has not been decided yet/))
      .closest('.panel__body')
      ?.querySelector('.badge');
    expect(badge).toHaveTextContent('Collected');
  });

  it('shows it as retained once the application is approved', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'retained' }));
    renderPanel({ status: 'approved' });

    expect(await screen.findByText('Retained')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record a cash refund' })).not.toBeInTheDocument();
  });

  /**
   * The resubmission rule, asserted directly.
   *
   * A rejected application is back in `draft` and can be resubmitted. The fee
   * record still exists, so the panel shows that record — it does not fall back
   * to the "no fee has been recorded" branch and ask for another TZS 5,000.
   */
  it('never asks for a second fee when a rejected application is back in draft', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'refund_due' }));
    renderPanel({ status: 'draft', rejectionReason: 'Insufficient security offered.' });

    await screen.findByText('Refund due');

    expect(
      screen.queryByRole('button', { name: 'Record TZS 5,000.00 received' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/No fee has been recorded/)).not.toBeInTheDocument();
    expect(screen.getByText(/Charged once per application/)).toBeInTheDocument();
  });

  /**
   * Entitlement comes from the server's derived state, not the loan's status.
   *
   * Here the loan reads `draft` — as a rejected application does — and the
   * refund control is offered anyway, because the server said `refund_due`.
   */
  it('offers the refund from the server’s state even though the loan reads draft', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'refund_due' }));
    renderPanel({ status: 'draft' });

    expect(await screen.findByRole('button', { name: 'Record a cash refund' })).toBeInTheDocument();
  });

  it('does not offer a refund on a fee the institution keeps', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'retained' }));
    renderPanel({ status: 'active' });

    await screen.findByText('Retained');
    expect(screen.queryByRole('button', { name: 'Record a cash refund' })).not.toBeInTheDocument();
  });
});

describe('owed and paid are different things', () => {
  it('says a refund is due without claiming it was paid', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'refund_due' }));
    renderPanel();

    expect(await screen.findByText('Refund due')).toBeInTheDocument();
    expect(screen.getByText(/has not been handed over yet/)).toBeInTheDocument();
    expect(screen.queryByText('Refunded')).not.toBeInTheDocument();
  });

  it('records the refund only when someone confirms the cash was handed over', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'refund_due' }));
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Record a cash refund' }));
    expect(screen.getByText(/once the TZS 5,000.00 has actually been handed/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Confirm the refund was paid' }));

    expect(refundApplicationFee).toHaveBeenCalledWith(
      LOAN_ID,
      expect.objectContaining({ refundedOn: expect.any(String) as string }),
    );
  });

  it('shows the refund once it has been recorded, keeping the collection', async () => {
    applicationFee.mockResolvedValue(
      fee({ state: 'refunded', refundedOn: '2026-03-01', refundedByName: 'Asha Mwakalinga' }),
    );
    renderPanel();

    expect(await screen.findByText('Refunded')).toBeInTheDocument();
    expect(screen.getByText('1 Mar 2026')).toBeInTheDocument();
    // The original collection is still on screen: what was taken stays evidenced.
    expect(screen.getByText('1 Feb 2026')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record a cash refund' })).not.toBeInTheDocument();
  });
});

describe('failures and double submission', () => {
  it('surfaces a refusal rather than appearing to succeed', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'refund_due' }));
    refundApplicationFee.mockRejectedValue(
      new ApiRequestError('conflict', 'This fee has already been refunded.', 409),
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Record a cash refund' }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the refund was paid' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This fee has already been refunded.',
    );
  });

  it('disables the collect button while the request is in flight', async () => {
    let release = (): void => undefined;
    collectApplicationFee.mockReturnValue(
      new Promise<ApplicationFee>((resolve) => {
        release = () => {
          resolve(fee());
        };
      }),
    );

    renderPanel();
    const button = await screen.findByRole('button', { name: 'Record TZS 5,000.00 received' });
    await userEvent.click(button);

    expect(await screen.findByRole('button', { name: 'Recording…' })).toBeDisabled();
    expect(collectApplicationFee).toHaveBeenCalledTimes(1);

    release();
  });

  it('shows nothing at all to someone without the read permission', () => {
    permissions = new Set([]);
    renderPanel();

    expect(screen.queryByText('Application fee')).not.toBeInTheDocument();
    expect(applicationFee).not.toHaveBeenCalled();
  });
});

/**
 * FEE-04 is unresolved: nothing decides how a collection or a refund posts to
 * the accounts, and nothing in this system writes a journal entry for either.
 * The screen must not imply otherwise.
 */
describe('no accounting language', () => {
  it('never claims the fee was posted anywhere', async () => {
    applicationFee.mockResolvedValue(fee({ state: 'retained' }));
    renderPanel();

    await screen.findByText('Retained');
    expect(document.body.textContent).not.toMatch(
      /posted|ledger|journal|debit|credit|account code/i,
    );
  });
});
