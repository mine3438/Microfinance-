import { type Client, type Page } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The borrower picker.
 *
 * It exists because both screens that needed a borrower loaded the first
 * hundred active clients into a `<select>`, so an institution with more than a
 * hundred had a borrower it could not serve at all — and the loan screen did
 * not say so. These tests pin the two things that fix: the search reaches the
 * server, and a truncated result says it is truncated. The debounce that keeps
 * that search to one request is tested where it lives, in
 * `shared/lib/use-debounced.test.ts` — driving fake timers through
 * `userEvent.type` deadlocks, and a real-timer race would be flaky rather than
 * informative.
 */

const list = vi.fn<(parameters?: unknown) => Promise<Page<Client>>>();

vi.mock('../api/endpoints.js', () => ({
  clients: { list: (parameters?: unknown): Promise<Page<Client>> => list(parameters) },
}));

const { ClientPicker } = await import('./client-picker.js');

const client = (id: string, fullName: string, clientCode: string): Client => ({
  id,
  clientCode,
  branchId: '019fef66-0000-7000-8000-0000000000b1',
  branchName: 'Head Office',
  fullName,
  gender: 'female',
  dateOfBirth: '1990-01-01',
  phone: '+255713111222',
  districtCode: 'arusha_cc',
  districtName: 'Arusha CC',
  sectorCode: 'trade',
  sectorName: 'Trade',
  status: 'active',
  createdAt: '2026-01-01T08:00:00.000Z',
  updatedAt: '2026-01-01T08:00:00.000Z',
});

const AMINA = client('019fef66-0000-7000-8000-0000000000c1', 'Amina Hassan', 'CL-0001');
const NEEMA = client('019fef66-0000-7000-8000-0000000000c2', 'Neema Kimaro', 'CL-0002');

/** A harness that reports what the picker selected. */
function Harness(): ReactNode {
  const [value, setValue] = useState('');
  return (
    <>
      <ClientPicker id="borrower" label="Borrower" value={value} onChange={setValue} />
      <output data-testid="chosen">{value}</output>
    </>
  );
}

function renderPicker(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [AMINA, NEEMA], nextCursor: null });
});

describe('searching', () => {
  it('sends the search term to the server rather than filtering in the browser', async () => {
    // The browser holds twenty-five names at most; the book holds thousands.
    // Filtering here would search the twenty-five it happens to have.
    const user = userEvent.setup();
    renderPicker();

    await waitFor(() => {
      expect(list).toHaveBeenCalled();
    });

    await user.type(screen.getByLabelText('Search borrower'), 'Amina');

    await waitFor(() => {
      const sent = list.mock.calls.at(-1)?.[0] as Record<string, unknown>;
      expect(sent['search']).toBe('Amina');
    });
  });

  it('asks for active clients only, and for a readable number of them', async () => {
    renderPicker();

    await waitFor(() => {
      expect(list).toHaveBeenCalled();
    });

    const sent = list.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent['status']).toBe('active');
    expect(sent['limit']).toBe(25);
  });

  it('omits the search entirely when the box is empty', async () => {
    renderPicker();

    await waitFor(() => {
      expect(list).toHaveBeenCalled();
    });

    const sent = list.mock.calls[0]?.[0] as Record<string, unknown>;
    expect('search' in sent).toBe(false);
  });
});

describe('what the picker says about its own results', () => {
  it('warns when more match than it can show', async () => {
    list.mockResolvedValue({ items: [AMINA, NEEMA], nextCursor: 'more' });
    renderPicker();

    expect(await screen.findByText(/More than 25 match/)).toBeInTheDocument();
  });

  it('says nothing about truncation when everything matching is shown', async () => {
    renderPicker();

    await screen.findByRole('option', { name: /Amina Hassan/ });
    expect(screen.queryByText(/More than/)).toBeNull();
  });

  it('says so when nothing matches, rather than showing an empty chooser', async () => {
    list.mockResolvedValue({ items: [], nextCursor: null });
    renderPicker();

    await waitFor(() => {
      expect(within(screen.getByLabelText('Borrower')).getByRole('option')).toHaveTextContent(
        'No matches',
      );
    });
  });
});

describe('choosing', () => {
  it('reports the client’s identifier, never the name shown beside it', async () => {
    const user = userEvent.setup();
    renderPicker();

    await screen.findByRole('option', { name: /Amina Hassan/ });
    await user.selectOptions(screen.getByLabelText('Borrower'), AMINA.id);

    expect(screen.getByTestId('chosen')).toHaveTextContent(AMINA.id);
  });

  it('shows the client code beside the name, because two savers share a name', async () => {
    renderPicker();

    expect(
      await screen.findByRole('option', { name: 'Amina Hassan — CL-0001' }),
    ).toBeInTheDocument();
  });
});
