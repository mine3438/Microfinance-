import {
  type AuditEntry,
  type AuditEntryDetail,
  type AuditListQuery,
  type AuditedTable,
  type Page,
} from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The audit screen.
 *
 * What is asserted here is mostly restraint. The list must not fetch payloads
 * it is not showing, the filters must not carry a stale cursor into a new
 * result set, and a change with no human actor must read as a system change
 * rather than as a blank cell — the last being the one most likely to be
 * mistaken for a defect in the trail.
 */

const list = vi.fn<(parameters?: Partial<AuditListQuery>) => Promise<Page<AuditEntry>>>();
const tables = vi.fn<() => Promise<AuditedTable[]>>();
const get = vi.fn<(id: string) => Promise<AuditEntryDetail>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  audit: {
    list: (parameters?: Partial<AuditListQuery>): Promise<Page<AuditEntry>> => list(parameters),
    tables: (): Promise<AuditedTable[]> => tables(),
    get: (id: string): Promise<AuditEntryDetail> => get(id),
  },
}));

const { AuditPage } = await import('./audit-page.js');

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: '018f0000-0000-7000-8000-000000000001',
  tableName: 'loan_products',
  rowId: '018f0000-0000-7000-8000-0000000000aa',
  operation: 'UPDATE',
  actorUserId: '018f0000-0000-7000-8000-0000000000bb',
  actorName: 'Asha Mrema',
  changedAt: '2026-05-04T09:30:00.000Z',
  changedColumns: ['status'],
  ...overrides,
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuditPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [entry()], nextCursor: null });
  tables.mockResolvedValue([{ name: 'clients' }, { name: 'loan_products' }, { name: 'loans' }]);
  get.mockResolvedValue({
    ...entry(),
    before: { status: 'active', name: 'Business loan' },
    after: { status: 'retired', name: 'Business loan' },
  });
});

describe('the trail', () => {
  it('names the table and the columns in words a reader uses', async () => {
    renderPage();

    expect(await screen.findByRole('cell', { name: 'Loan products' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'status' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Changed' })).toBeInTheDocument();
  });

  it('does not fetch a payload for a row nobody opened', async () => {
    renderPage();
    await screen.findByRole('cell', { name: 'Loan products' });

    // The whole reason the list omits before-and-after: browsing a quarter of
    // activity should not stream every row of the loan book through the
    // browser.
    expect(get).not.toHaveBeenCalled();
  });

  it('shows the values either side once a row is opened', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Show' }));

    const nested = await screen.findByRole('table', {
      name: /Values before and after this change/,
    });
    const row = within(nested).getByRole('row', { name: /status/ });

    expect(within(row).getByText('active')).toBeInTheDocument();
    expect(within(row).getByText('retired')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith(entry().id);
  });

  it('shows the whole row for a creation, where every column is the change', async () => {
    list.mockResolvedValue({
      items: [entry({ operation: 'INSERT', changedColumns: [] })],
      nextCursor: null,
    });
    get.mockResolvedValue({
      ...entry({ operation: 'INSERT', changedColumns: [] }),
      before: null,
      after: { status: 'active', name: 'Business loan' },
    });

    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Show' }));

    const nested = await screen.findByRole('table', {
      name: /Values before and after this change/,
    });
    expect(within(nested).getByRole('row', { name: /name/ })).toBeInTheDocument();
    expect(within(nested).getByRole('row', { name: /status/ })).toBeInTheDocument();
  });

  it('says "System" for a change no user made', async () => {
    list.mockResolvedValue({
      items: [entry({ actorUserId: null, actorName: null })],
      nextCursor: null,
    });

    renderPage();

    // A blank cell here reads as a defect in the trail. It is not one: a
    // migration and the nightly classification run change rows with no user
    // behind them at all.
    expect(await screen.findByText('System')).toBeInTheDocument();
  });
});

describe('filters', () => {
  it('offers the tables the server says are audited, not a list held here', async () => {
    renderPage();

    // Awaited, because the list of tables is fetched: the select renders
    // before the answer arrives, holding only "All tables".
    expect(await screen.findByRole('option', { name: 'Clients' })).toBeInTheDocument();
    const select = screen.getByLabelText('Table');
    expect(within(select).getByRole('option', { name: 'Loan products' })).toBeInTheDocument();
  });

  it('sends the name Postgres uses, whatever the option says', async () => {
    renderPage();
    await screen.findByRole('option', { name: 'Loan products' });

    await userEvent.selectOptions(screen.getByLabelText('Table'), 'loan_products');

    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ tableName: 'loan_products' }));
  });

  it('drops the cursor when a filter changes', async () => {
    list.mockResolvedValue({ items: [entry()], nextCursor: 'Y3Vyc29y' });
    renderPage();
    await screen.findByRole('cell', { name: 'Loan products' });

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'Y3Vyc29y' }));

    await userEvent.selectOptions(screen.getByLabelText('Change'), 'DELETE');

    // A cursor names the last row of a result set. Carried into a different
    // filter it points at a set that no longer exists, and the page returned is
    // not the page after the one just read.
    const parameters = list.mock.calls.at(-1)?.[0] ?? {};
    expect(parameters).toEqual(expect.objectContaining({ operation: 'DELETE' }));
    expect(parameters).not.toHaveProperty('cursor');
  });

  it('narrows to one actor when their name is clicked, and says so', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Asha Mrema' }));

    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ actorUserId: entry().actorUserId }),
    );
    expect(screen.getByText(/Showing changes made by Asha Mrema/)).toBeInTheDocument();
  });
});
