import { type ClassificationRun, type PortfolioSummary } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The portfolio screen.
 *
 * Almost everything asserted here is about the *age* of the figures rather than
 * the figures themselves. R5 — the defect this system replaces — was not wrong
 * arithmetic; it was a classification job that silently stopped while the
 * dashboard kept showing its last answer as though it were current. A screen
 * that renders these numbers without saying how old they are reproduces it
 * exactly, and no amount of correct summing would help.
 */

const summary = vi.fn<() => Promise<PortfolioSummary>>();
const reclassify = vi.fn<() => Promise<ClassificationRun>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  portfolio: {
    summary: (): Promise<PortfolioSummary> => summary(),
    reclassify: (): Promise<ClassificationRun> => reclassify(),
  },
}));

let permissions = new Set<string>(['loan.read', 'report.generate']);

vi.mock('../auth/session.js', () => ({
  useSession: (): { can: (permission: string) => boolean } => ({
    can: (permission: string) => permissions.has(permission),
  }),
}));

const { PortfolioPage } = await import('./portfolio-page.js');

const hoursAgo = (hours: number): string =>
  new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

const portfolioSummary = (overrides: Partial<PortfolioSummary> = {}): PortfolioSummary => ({
  classes: [
    { classification: 'current', loanCount: 12, outstanding: '4500000.00' },
    { classification: 'esm', loanCount: 3, outstanding: '900000.00' },
    { classification: 'substandard', loanCount: 2, outstanding: '600000.00' },
    { classification: 'doubtful', loanCount: 0, outstanding: '0.00' },
    { classification: 'loss', loanCount: 1, outstanding: '250000.00' },
  ],
  totalOutstanding: '6250000.00',
  totalLoans: 18,
  nonPerformingRatio: '13.60',
  classificationsUpdatedAt: hoursAgo(2),
  unclassifiedLoanCount: 0,
  ...overrides,
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PortfolioPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['loan.read', 'report.generate']);
  summary.mockResolvedValue(portfolioSummary());
  reclassify.mockResolvedValue({ institutionId: 'i', unclassifiableLoanCount: 0 });
});

describe('how old the figures are', () => {
  it('says the age in words before showing anything', async () => {
    renderPage();

    expect(await screen.findByText(/Classified 2 hours ago/)).toBeInTheDocument();
    expect(screen.getByText('Figures are current')).toBeInTheDocument();
  });

  it('warns when the run is older than the gate allows', async () => {
    // Beyond 24 hours the BOT return refuses to compile, so the screen must
    // not present these as current.
    summary.mockResolvedValue(portfolioSummary({ classificationsUpdatedAt: hoursAgo(30) }));
    renderPage();

    expect(await screen.findByText('These figures are out of date')).toBeInTheDocument();
    expect(screen.getByText(/may already understate arrears/)).toBeInTheDocument();
  });

  it('treats never-run as its own state, not as very stale', async () => {
    // An institution that has never classified has no figures at all; every
    // loan reads as it stood at creation, which is R5 exactly.
    summary.mockResolvedValue(portfolioSummary({ classificationsUpdatedAt: null }));
    renderPage();

    expect(await screen.findByText('These figures have never been computed')).toBeInTheDocument();
    expect(screen.getByText(/as it stood when it was created/)).toBeInTheDocument();
  });

  it('counts days once the run is old enough for hours to stop meaning anything', async () => {
    summary.mockResolvedValue(portfolioSummary({ classificationsUpdatedAt: hoursAgo(72) }));
    renderPage();

    expect(await screen.findByText(/Classified 3 days ago/)).toBeInTheDocument();
  });
});

describe('the book', () => {
  it('shows all five of BOT’s classes, including the ones reading nought', async () => {
    // An officer scanning for "Doubtful" must find it reading zero rather than
    // not find it.
    renderPage();

    const doubtful = (await screen.findByText('Doubtful')).closest('tr');
    if (doubtful === null) {
      throw new Error('Doubtful was not rendered in a row.');
    }
    expect(within(doubtful).getByText('0')).toBeInTheDocument();
  });

  it('keeps unclassified loans out of Current', async () => {
    // BOT has no column for them (§11.5). Folding them into Current makes the
    // book look healthier than it is.
    summary.mockResolvedValue(portfolioSummary({ unclassifiedLoanCount: 4 }));
    renderPage();

    const row = (await screen.findByText('Unclassified')).closest('tr');
    if (row === null) {
      throw new Error('The unclassified row was not rendered.');
    }
    expect(within(row).getByText('4')).toBeInTheDocument();

    const current = screen.getByText('Current').closest('tr');
    if (current === null) {
      throw new Error('The Current row was not rendered.');
    }
    expect(within(current).getByText('12')).toBeInTheDocument();
  });

  it('shows no unclassified row when there are none', async () => {
    renderPage();

    await screen.findByText('Current');
    expect(screen.queryByText('Unclassified')).toBeNull();
  });

  it('renders the ratio the server computed rather than recomputing it', async () => {
    // A second implementation on this side could disagree with MSP2-03 by a
    // shilling and nobody would know which was right.
    summary.mockResolvedValue(portfolioSummary({ nonPerformingRatio: '13.60' }));
    renderPage();

    expect(await screen.findByText('13.60%')).toBeInTheDocument();
  });

  it('says so when there is no book yet', async () => {
    summary.mockResolvedValue(
      portfolioSummary({
        classes: [
          { classification: 'current', loanCount: 0, outstanding: '0.00' },
          { classification: 'esm', loanCount: 0, outstanding: '0.00' },
          { classification: 'substandard', loanCount: 0, outstanding: '0.00' },
          { classification: 'doubtful', loanCount: 0, outstanding: '0.00' },
          { classification: 'loss', loanCount: 0, outstanding: '0.00' },
        ],
        totalLoans: 0,
        totalOutstanding: '0.00',
        nonPerformingRatio: '0.00',
      }),
    );
    renderPage();

    expect(await screen.findByText('No active loans')).toBeInTheDocument();
  });
});

describe('acting on staleness', () => {
  it('lets someone who can generate reports run the job from here', async () => {
    summary.mockResolvedValue(portfolioSummary({ classificationsUpdatedAt: hoursAgo(30) }));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Run classification now' }));

    expect(reclassify).toHaveBeenCalledTimes(1);
  });

  it('offers no button to someone who cannot', async () => {
    permissions = new Set(['loan.read']);
    summary.mockResolvedValue(portfolioSummary({ classificationsUpdatedAt: hoursAgo(30) }));
    renderPage();

    await screen.findByText('These figures are out of date');
    expect(screen.queryByRole('button', { name: 'Run classification now' })).toBeNull();
  });
});
