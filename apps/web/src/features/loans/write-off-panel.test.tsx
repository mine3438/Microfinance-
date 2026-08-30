import { type LoanRecovery, type LoanWithSchedule, type LoanWriteOff } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../shared/api/client.js';

/**
 * Writing a loan off, and recording what comes back afterwards.
 *
 * Two boundaries these tests defend.
 *
 * **A write-off is a person's judgement.** It requires a stated reason and an
 * explicit confirmation, and it is offered only to whoever holds the permission
 * for it. There is no threshold and no automatic trigger anywhere in this
 * feature.
 *
 * **A recovery is not a repayment.** It is recorded in its own place, described
 * in its own words, and it leaves the loan written off. The single most
 * damaging mistake available here would be presenting recovered money as a
 * repayment against a debt that is no longer owed, so several tests assert the
 * absence of that framing rather than only the presence of the right one.
 */

const writeOff = vi.fn<() => Promise<LoanWriteOff | null>>();
const recordWriteOff = vi.fn<(...args: unknown[]) => Promise<LoanWriteOff>>();
const recoveries = vi.fn<() => Promise<LoanRecovery[]>>();
const recordRecovery = vi.fn<(...args: unknown[]) => Promise<LoanRecovery>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  loanEvents: {
    writeOff: (): Promise<LoanWriteOff | null> => writeOff(),
    recordWriteOff: (...args: unknown[]): Promise<LoanWriteOff> => recordWriteOff(...args),
    recoveries: (): Promise<LoanRecovery[]> => recoveries(),
    recordRecovery: (...args: unknown[]): Promise<LoanRecovery> => recordRecovery(...args),
  },
}));

let permissions = new Set<string>([
  'loan.read',
  'loan.write_off',
  'payment.read',
  'payment.create',
]);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: null },
  }),
}));

const { WriteOffPanel } = await import('./write-off-panel.js');

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
    penaltyBalance: '12000.00',
    disbursementDate: '2026-01-10',
    rejectionReason: null,
    restructuredIntoLoanId: null,
    restructuredFromLoanId: null,
    createdAt: '2026-01-01T08:00:00.000Z',
    schedule: null,
    ...overrides,
  }) as LoanWithSchedule;

const writtenOff = (overrides: Partial<LoanWriteOff> = {}): LoanWriteOff => ({
  id: '019fef66-0000-7000-8000-0000000000w1',
  loanId: LOAN_ID,
  loanCode: 'LN-0001',
  clientName: 'Neema Kimaro',
  principalWrittenOff: '720000.00',
  penaltyWrittenOff: '12000.00',
  totalWrittenOff: '732000.00',
  reason: 'Borrower ceased trading and cannot be traced.',
  approvedBy: '019fef66-0000-7000-8000-0000000000u1',
  approvedByName: 'Asha Mwakalinga',
  writtenOffAt: '2026-06-15T08:00:00.000Z',
  ...overrides,
});

const recovery = (overrides: Partial<LoanRecovery> = {}): LoanRecovery => ({
  id: '019fef66-0000-7000-8000-0000000000r1',
  loanId: LOAN_ID,
  loanCode: 'LN-0001',
  clientName: 'Neema Kimaro',
  amount: '150000.00',
  recoveredOn: '2026-08-01',
  method: 'Cash',
  reference: 'RCV-0001',
  notes: null,
  recordedBy: '019fef66-0000-7000-8000-0000000000u1',
  recordedByName: 'Asha Mwakalinga',
  createdAt: '2026-08-01T08:00:00.000Z',
  ...overrides,
});

function renderPanel(loanOverrides: Partial<LoanWithSchedule> = {}): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChanged = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  render(
    <QueryClientProvider client={queryClient}>
      <WriteOffPanel loan={loan(loanOverrides)} onChanged={onChanged} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['loan.read', 'loan.write_off', 'payment.read', 'payment.create']);
  writeOff.mockResolvedValue(null);
  recordWriteOff.mockResolvedValue(writtenOff());
  recoveries.mockResolvedValue([]);
  recordRecovery.mockResolvedValue(recovery());
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

describe('writing a loan off', () => {
  it('shows what is owed before anything is decided', async () => {
    renderPanel();

    expect(await screen.findByText(/TZS 720,000.00/)).toBeInTheDocument();
    expect(screen.getByText(/Neema Kimaro/)).toBeInTheDocument();
  });

  it('requires a confirmation step rather than writing off on one click', async () => {
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Write this loan off' }));

    expect(screen.getByRole('alert')).toHaveTextContent(
      /significant financial decision and it is not reversible/,
    );
    expect(recordWriteOff).not.toHaveBeenCalled();
  });

  it('will not submit without a stated reason', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Write this loan off' }));

    expect(screen.getByRole('button', { name: 'Confirm the write-off' })).toBeDisabled();
  });

  it('sends the reason once one is given', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Write this loan off' }));
    await userEvent.type(
      screen.getByLabelText('Why is this debt unrecoverable?'),
      'Borrower ceased trading.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the write-off' }));

    expect(recordWriteOff).toHaveBeenCalledWith(LOAN_ID, {
      reason: 'Borrower ceased trading.',
    });
  });

  it('warns that the loan will stop taking ordinary repayments', async () => {
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Write this loan off' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/no longer take ordinary repayments/);
    expect(screen.getByRole('alert')).toHaveTextContent(/recorded as a recovery/);
  });

  it('surfaces a refusal rather than appearing to have written the loan off', async () => {
    recordWriteOff.mockRejectedValue(
      new ApiRequestError('forbidden', 'Only the owner or manager may write a loan off.', 403),
    );

    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Write this loan off' }));
    await userEvent.type(
      screen.getByLabelText('Why is this debt unrecoverable?'),
      'Unrecoverable.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Confirm the write-off' }));

    expect(
      await screen.findByText('Only the owner or manager may write a loan off.'),
    ).toBeInTheDocument();
  });

  it('offers no write-off to someone without the authority', async () => {
    permissions = new Set(['loan.read', 'payment.read']);
    renderPanel();

    expect(await screen.findByText(/reserved to the owner or manager/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write this loan off' })).not.toBeInTheDocument();
  });

  it('shows nothing on a loan that can be neither written off nor is', () => {
    renderPanel({ status: 'completed' });

    expect(screen.queryByText('Write-off')).not.toBeInTheDocument();
  });
});

describe('a loan that has been written off', () => {
  beforeEach(() => {
    writeOff.mockResolvedValue(writtenOff());
  });

  it('shows principal and penalty separately, and the reason', async () => {
    renderPanel({ status: 'written_off', outstandingBalance: '0.00' });

    expect(await screen.findByText('TZS 720,000.00')).toBeInTheDocument();
    expect(screen.getByText('TZS 12,000.00')).toBeInTheDocument();
    expect(screen.getByText('TZS 732,000.00')).toBeInTheDocument();
    expect(screen.getByText('Borrower ceased trading and cannot be traced.')).toBeInTheDocument();
  });

  it('does not offer to write it off again', async () => {
    renderPanel({ status: 'written_off', outstandingBalance: '0.00' });

    await screen.findByText('TZS 732,000.00');
    expect(screen.queryByRole('button', { name: 'Write this loan off' })).not.toBeInTheDocument();
  });

  /**
   * WRITEOFF-02 is unresolved. The operational record exists and keeps its
   * parts apart so the eventual treatment can be applied; no journal entry is
   * written, and none is claimed.
   */
  it('claims no accounting treatment', async () => {
    renderPanel({ status: 'written_off', outstandingBalance: '0.00' });

    await screen.findByText('TZS 732,000.00');
    expect(document.body.textContent).not.toMatch(
      /posted|ledger|journal|debit|credit|provision account/i,
    );
  });
});

describe('recoveries', () => {
  beforeEach(() => {
    writeOff.mockResolvedValue(writtenOff());
  });

  const renderWrittenOff = (): void => {
    renderPanel({ status: 'written_off', outstandingBalance: '0.00' });
  };

  it('appears only once the loan has been written off', async () => {
    writeOff.mockResolvedValue(null);
    renderPanel();

    await screen.findByRole('button', { name: 'Write this loan off' });
    expect(screen.queryByText('Recoveries')).not.toBeInTheDocument();
    expect(recoveries).not.toHaveBeenCalled();
  });

  it('says so when nothing has been recovered', async () => {
    renderWrittenOff();

    expect(await screen.findByText('Nothing recovered yet')).toBeInTheDocument();
  });

  it('lists what has been recovered', async () => {
    recoveries.mockResolvedValue([recovery()]);
    renderWrittenOff();

    expect(await screen.findByText('150,000.00')).toBeInTheDocument();
    expect(screen.getByText('1 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText('RCV-0001')).toBeInTheDocument();
  });

  it('records a recovery with its amount, date and reference', async () => {
    renderWrittenOff();

    await userEvent.click(await screen.findByRole('button', { name: 'Record a recovery' }));
    await userEvent.type(screen.getByLabelText('Amount received (TZS)'), '150000.00');
    await userEvent.type(screen.getByLabelText('Reference'), 'RCV-0002');
    await userEvent.click(screen.getByRole('button', { name: 'Record the recovery' }));

    expect(recordRecovery).toHaveBeenCalledWith(
      LOAN_ID,
      expect.objectContaining({ amount: '150000.00', reference: 'RCV-0002' }),
    );
  });

  it('will not submit an empty amount', async () => {
    renderWrittenOff();

    await userEvent.click(await screen.findByRole('button', { name: 'Record a recovery' }));
    expect(screen.getByRole('button', { name: 'Record the recovery' })).toBeDisabled();
  });

  it('surfaces a refusal rather than appearing to have recorded it', async () => {
    recordRecovery.mockRejectedValue(
      new ApiRequestError('validation_failed', 'That loan has not been written off.', 422),
    );
    renderWrittenOff();

    await userEvent.click(await screen.findByRole('button', { name: 'Record a recovery' }));
    await userEvent.type(screen.getByLabelText('Amount received (TZS)'), '150000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record the recovery' }));

    expect(await screen.findByText('That loan has not been written off.')).toBeInTheDocument();
  });

  it('offers no recording control to someone who may only read', async () => {
    permissions = new Set(['loan.read', 'payment.read']);
    recoveries.mockResolvedValue([recovery()]);
    renderWrittenOff();

    await screen.findByText('150,000.00');
    expect(screen.queryByRole('button', { name: 'Record a recovery' })).not.toBeInTheDocument();
  });

  /**
   * The framing test.
   *
   * A recovery must never be presented as a repayment. This asserts the absence
   * of that word around the recovery record, and the presence of the statement
   * that the loan stays written off.
   */
  it('is never called a repayment, and says the loan stays written off', async () => {
    recoveries.mockResolvedValue([recovery()]);
    renderWrittenOff();

    await screen.findByText('150,000.00');

    const panel = screen.getByText('Recoveries').closest('section');
    expect(panel).not.toBeNull();
    const scope = within(must(panel));

    // The mislabelling would happen in a control or a column header, not in
    // prose — the panel's own disclaimer has to use the word "repayment" to
    // deny it, so matching the whole panel's text would forbid saying the very
    // thing that must be said.
    for (const control of scope.getAllByRole('button')) {
      expect(control.textContent).not.toMatch(/repay|instalment|allocat/i);
    }
    for (const header of scope.getAllByRole('columnheader')) {
      expect(header.textContent).not.toMatch(/repay|instalment|allocat|balance/i);
    }

    expect(must(panel).textContent).toMatch(/A recovery is not a repayment/);
    expect(must(panel).textContent).toMatch(/the loan stays written off/i);
  });

  it('claims no accounting treatment for recovered money either', async () => {
    recoveries.mockResolvedValue([recovery()]);
    renderWrittenOff();

    await screen.findByText('150,000.00');
    expect(document.body.textContent).not.toMatch(/posted|ledger|journal|debit|credit/i);
  });
});
