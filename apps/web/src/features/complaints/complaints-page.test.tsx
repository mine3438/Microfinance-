import { type Branch, type Complaint, type ComplaintNature, type Page } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Complaints.
 *
 * MSP2-06 is a movement statement derived entirely from these records, so what
 * these tests protect is that the screen records **dated facts** and never a
 * tally: no field here asks "how many were resolved this quarter", because the
 * return works that out from when each one was received and resolved.
 */

const natures = vi.fn<() => Promise<ComplaintNature[]>>();
const list = vi.fn<() => Promise<Page<Complaint>>>();
const log = vi.fn<(request: unknown) => Promise<Complaint>>();
const resolve = vi.fn<(...args: unknown[]) => Promise<Complaint>>();
const refer = vi.fn<(...args: unknown[]) => Promise<Complaint>>();
const listBranches = vi.fn<() => Promise<Branch[]>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  complaints: {
    natures: (): Promise<ComplaintNature[]> => natures(),
    list: (): Promise<Page<Complaint>> => list(),
    log: (request: unknown): Promise<Complaint> => log(request),
    resolve: (...args: unknown[]): Promise<Complaint> => resolve(...args),
    refer: (...args: unknown[]): Promise<Complaint> => refer(...args),
  },
  branches: { list: (): Promise<Branch[]> => listBranches() },
}));

let permissions = new Set<string>(['complaint.read', 'complaint.manage']);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean; user: unknown } => ({
    can: (permission: string) => permissions.has(permission),
    user: { branch: { id: '019fef66-0000-7000-8000-0000000000b1', name: 'Head Office' } },
  }),
}));

const { ComplaintsPage } = await import('./complaints-page.js');

const NATURES: ComplaintNature[] = [
  { code: 'loan_related', sno: 1, name: 'Loan Related' },
  { code: 'interest_rate', sno: 2, name: 'Interest Rate' },
];

/** The branch the signed-in user belongs to, named so tests need no indexing. */
const HEAD_OFFICE_ID = '019fef66-0000-7000-8000-0000000000b1';

const BRANCHES: Branch[] = [
  {
    id: HEAD_OFFICE_ID,
    code: 'HO',
    name: 'Head Office',
    isHeadOffice: true,
    status: 'active',
  },
  {
    id: '019fef66-0000-7000-8000-0000000000b2',
    code: 'ARU',
    name: 'Arusha',
    isHeadOffice: false,
    status: 'active',
  },
  {
    id: '019fef66-0000-7000-8000-0000000000b3',
    code: 'OLD',
    name: 'Closed Branch',
    isHeadOffice: false,
    status: 'closed',
  },
];

const complaint = (overrides: Partial<Complaint> = {}): Complaint => ({
  id: '019fef66-0000-7000-8000-0000000000c1',
  complaintCode: 'CMP-0001',
  complainantName: 'Neema Kimaro',
  clientId: null,
  clientName: null,
  branchId: HEAD_OFFICE_ID,
  branchName: 'Head Office',
  natureCode: 'loan_related',
  natureName: 'Loan Related',
  summary: 'Disputed instalment',
  amount: '250000.00',
  receivedOn: '2026-02-10',
  resolvedOn: null,
  resolvedBy: null,
  resolutionNote: null,
  referredTo: null,
  referredOn: null,
  recordedBy: '019fef66-0000-7000-8000-0000000000u1',
  createdAt: '2026-02-10T08:00:00.000Z',
  updatedAt: '2026-02-10T08:00:00.000Z',
  ...overrides,
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <ComplaintsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['complaint.read', 'complaint.manage']);
  natures.mockResolvedValue(NATURES);
  listBranches.mockResolvedValue(BRANCHES);
  list.mockResolvedValue({ items: [complaint()], nextCursor: null });
  log.mockResolvedValue(complaint());
  resolve.mockResolvedValue(complaint({ resolvedOn: '2026-02-20', resolvedBy: 'institution' }));
  refer.mockResolvedValue(complaint({ referredTo: 'courts', referredOn: '2026-02-15' }));
});

describe('logging a complaint', () => {
  const openForm = async (): Promise<void> => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Log one' }));
    await screen.findByRole('option', { name: 'Loan Related' });
  };

  it('offers BOT’s six categories rather than free text', async () => {
    await openForm();

    const options = within(screen.getByLabelText('Nature'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual(['Choose a category…', 'Loan Related', 'Interest Rate']);
  });

  it('offers only branches that are open', async () => {
    await openForm();

    const options = within(screen.getByLabelText('Branch'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual(['Choose a branch…', 'Head Office', 'Arusha']);
    expect(options).not.toContain('Closed Branch');
  });

  it('defaults the branch to the user’s own, where they have one', async () => {
    await openForm();

    expect(screen.getByLabelText('Branch')).toHaveValue(HEAD_OFFICE_ID);
  });

  it('omits the disputed amount when blank rather than sending an empty string', async () => {
    // Blank means "no amount in dispute"; zero would mean an amount of nothing.
    // Sending '' would make the server decide which was meant.
    await openForm();

    await userEvent.type(screen.getByLabelText('Complainant'), 'Neema Kimaro');
    await userEvent.selectOptions(screen.getByLabelText('Nature'), 'loan_related');
    await userEvent.type(screen.getByLabelText('Summary'), 'Disputed instalment');
    await userEvent.click(screen.getByRole('button', { name: 'Record complaint' }));

    const sent = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('amount' in sent).toBe(false);
    expect(sent['complainantName']).toBe('Neema Kimaro');
  });

  it('sends a stated amount as the string that was typed', async () => {
    await openForm();

    await userEvent.type(screen.getByLabelText('Complainant'), 'Neema Kimaro');
    await userEvent.selectOptions(screen.getByLabelText('Nature'), 'loan_related');
    await userEvent.type(screen.getByLabelText('Summary'), 'Disputed instalment');
    await userEvent.type(screen.getByLabelText('Amount in dispute'), '250000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Record complaint' }));

    const sent = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent['amount']).toBe('250000.00');
  });

  it('asks when the complaint was received, never which quarter it belongs to', async () => {
    await openForm();

    expect(screen.getByLabelText('Received on')).toHaveAttribute('type', 'date');
    expect(screen.queryByLabelText(/quarter/i)).toBeNull();
  });
});

describe('resolving', () => {
  it('requires a route, because MSP2-06 has only two lines for one', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));

    const options = within(screen.getByLabelText('Resolved by'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual(['By the institution', 'By another party']);
  });

  it('sends the resolution date and route, not a count', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    await userEvent.clear(screen.getByLabelText('Resolved on'));
    await userEvent.type(screen.getByLabelText('Resolved on'), '2026-02-20');
    await userEvent.selectOptions(screen.getByLabelText('Resolved by'), 'other_party');
    await userEvent.type(screen.getByLabelText('What was done'), 'Settled by the ombudsman');
    await userEvent.click(screen.getByRole('button', { name: 'Record resolution' }));

    expect(resolve).toHaveBeenCalledWith('019fef66-0000-7000-8000-0000000000c1', {
      resolvedOn: '2026-02-20',
      resolvedBy: 'other_party',
      resolutionNote: 'Settled by the ombudsman',
    });
  });

  it('says the received date the resolution cannot precede', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));

    expect(screen.getByText(/Cannot precede/)).toBeInTheDocument();
  });

  it('offers no resolve or refer action once a complaint is resolved', async () => {
    list.mockResolvedValue({
      items: [complaint({ resolvedOn: '2026-02-20', resolvedBy: 'institution' })],
      nextCursor: null,
    });
    renderPage();

    await screen.findByText('CMP-0001');
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Refer' })).toBeNull();
  });
});

describe('referring', () => {
  it('offers BOT’s four destinations and no others', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Refer' }));

    const options = within(screen.getByLabelText('Referred to'))
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual([
      'Bank of Tanzania',
      'Fair Competition Commission',
      'Courts',
      'Other parties',
    ]);
  });

  it('sends the referral with its date', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Refer' }));
    await userEvent.selectOptions(screen.getByLabelText('Referred to'), 'courts');
    await userEvent.clear(screen.getByLabelText('Referred on'));
    await userEvent.type(screen.getByLabelText('Referred on'), '2026-02-15');
    await userEvent.click(screen.getByRole('button', { name: 'Record referral' }));

    expect(refer).toHaveBeenCalledWith('019fef66-0000-7000-8000-0000000000c1', {
      referredTo: 'courts',
      referredOn: '2026-02-15',
    });
  });
});

describe('permissions', () => {
  it('shows no way to log or act on a complaint to a reader', async () => {
    permissions = new Set(['complaint.read']);
    renderPage();

    await screen.findByText('CMP-0001');
    expect(screen.queryByRole('button', { name: 'Log one' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resolve' })).toBeNull();
  });
});

describe('an empty quarter', () => {
  it('says a quarter with no complaints is a legitimate return', async () => {
    list.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();

    expect(await screen.findByText('Nothing recorded')).toBeInTheDocument();
  });
});
