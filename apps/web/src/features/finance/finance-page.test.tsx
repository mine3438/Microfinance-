import { type FinanceEntry, type Msp2_02Line, type Page } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const msp2_02Lines = vi.fn<() => Promise<Msp2_02Line[]>>();
const listEntries = vi.fn<() => Promise<Page<FinanceEntry>>>();
const recordEntry = vi.fn<(request: unknown) => Promise<FinanceEntry>>();
const removeEntry = vi.fn<() => Promise<void>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  reference: { msp2_02Lines: (): Promise<Msp2_02Line[]> => msp2_02Lines() },
  finance: {
    listEntries: (): Promise<Page<FinanceEntry>> => listEntries(),
    recordEntry: (request: unknown): Promise<FinanceEntry> => recordEntry(request),
    removeEntry: (): Promise<void> => removeEntry(),
  },
}));

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: () => boolean } => ({ can: () => true }),
}));

const { FinancePage } = await import('./finance-page.js');

/** A slice of BOT's taxonomy: two entered lines and one it computes. */
const LINES: Msp2_02Line[] = [
  {
    sno: 2,
    label: 'a. Interest - Loans to Clients',
    isComputed: false,
    entryDirection: 'income',
  },
  {
    sno: 23,
    label: '7. NON-INTEREST EXPENSES',
    isComputed: true,
    entryDirection: null,
  },
  {
    sno: 24,
    label: "a. Managements' Salaries and Benefits",
    isComputed: false,
    entryDirection: 'expense',
  },
];

const ENTRY: FinanceEntry = {
  id: '019fef66-0000-7000-8000-000000000001',
  direction: 'expense',
  sno: 24,
  lineLabel: "a. Managements' Salaries and Benefits",
  amount: '2400000.00',
  entryDate: '2026-02-15',
  branchId: null,
  branchName: null,
  description: 'February payroll',
  reference: null,
  recordedBy: '019fef66-0000-7000-8000-000000000002',
  createdAt: '2026-02-15T09:00:00.000Z',
  updatedAt: '2026-02-15T09:00:00.000Z',
};

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <FinancePage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  msp2_02Lines.mockReset();
  listEntries.mockReset();
  recordEntry.mockReset();
  removeEntry.mockReset();

  msp2_02Lines.mockResolvedValue(LINES);
  listEntries.mockResolvedValue({ items: [ENTRY], nextCursor: null });
  recordEntry.mockResolvedValue(ENTRY);
});

describe('FinancePage', () => {
  it('offers only the lines BOT accepts entries on, for the chosen side', async () => {
    renderPage();

    // Wait for the taxonomy, not merely for the form: the picker renders
    // immediately with only its placeholder.
    await screen.findByRole('option', { name: /Managements/ });
    const options = within(screen.getByLabelText('BOT line')).getAllByRole('option');

    // The subtotal BOT computes is absent entirely: an entry against it would
    // be counted twice, and leaving it out means nobody has to be told.
    expect(options.map((option) => option.textContent)).toEqual([
      'Choose a line…',
      "24. a. Managements' Salaries and Benefits",
    ]);
  });

  it('swaps the line list when the side changes, and clears a stale choice', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: /Managements/ });
    const picker = screen.getByLabelText<HTMLSelectElement>('BOT line');
    await user.selectOptions(picker, '24');
    expect(picker.value).toBe('24');

    await user.selectOptions(screen.getByLabelText('Side'), 'income');

    // The expense line no longer applies. Cleared rather than left for the
    // server to refuse.
    expect(screen.getByLabelText<HTMLSelectElement>('BOT line').value).toBe('');
    expect(
      within(screen.getByLabelText('BOT line'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a line…', '2. a. Interest - Loans to Clients']);
  });

  it('sends the amount as a string and the line as its BOT number', async () => {
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('option', { name: /Managements/ });
    await user.selectOptions(screen.getByLabelText('BOT line'), '24');
    await user.type(screen.getByLabelText('Amount (TZS)'), '2400000.00');
    await user.click(screen.getByRole('button', { name: 'Record' }));

    expect(recordEntry).toHaveBeenCalledTimes(1);

    const sent = recordEntry.mock.calls[0]?.[0] as Record<string, unknown>;
    // A JSON number would already have lost precision by the time it arrived.
    expect(sent['amount']).toBe('2400000.00');
    expect(sent['sno']).toBe(24);
    expect(sent['direction']).toBe('expense');
  });

  it('shows the BOT line an entry was recorded against, not a category', async () => {
    renderPage();

    // Scoped to the table: the same label is also an option in the picker,
    // which is the point — one taxonomy, shown in both places.
    const table = await screen.findByRole('table');
    expect(within(table).getByText(/Managements' Salaries/)).toBeInTheDocument();
    expect(within(table).getByText('2,400,000.00')).toBeInTheDocument();
  });
});

describe('field labelling', () => {
  it('names the date field by its label alone, not by its label and its hint', async () => {
    // A hint rendered *inside* the `<label>` becomes part of the control's
    // accessible name, so a screen reader announces the whole explanatory
    // paragraph where it should announce "Date". The shared `Field` primitive
    // puts the hint outside the label and ties it with `aria-describedby`.
    renderPage();

    const date = await screen.findByLabelText('Date');
    expect(date.getAttribute('type')).toBe('date');
    // The hint is still reachable — as a description, which is what it is.
    expect(date.getAttribute('aria-describedby')).toBe('entry-date-hint');
    expect(screen.getByText(/quarter is taken from this date/)).toBeInTheDocument();
  });
});
