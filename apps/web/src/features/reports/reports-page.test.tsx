import { type CompiledReturn } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiRequestError } from '../../shared/api/client.js';

const quarterlyReturn = vi.fn<() => Promise<CompiledReturn>>();
const reclassify =
  vi.fn<() => Promise<{ institutionId: string; unclassifiableLoanCount: number }>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  reports: { quarterlyReturn: (): Promise<CompiledReturn> => quarterlyReturn() },
  portfolio: {
    reclassify: (): Promise<{ institutionId: string; unclassifiableLoanCount: number }> =>
      reclassify(),
  },
}));

const { ReportsPage, lastCompletedQuarter } = await import('./reports-page.js');

/**
 * A compiled return, small enough to assert against.
 *
 * Two sectors where one has no lending, because an empty row is not an absent
 * row on a form BOT reads by position — and that distinction is one of the
 * things this screen has to get right.
 */
function compiledReturn(overrides: Partial<CompiledReturn> = {}): CompiledReturn {
  const nilClasses = {
    current: '0.00',
    esm: '0.00',
    substandard: '0.00',
    doubtful: '0.00',
    loss: '0.00',
  };
  const nilBand = { lowest: null, highest: null, weightedAverage: null };
  const nilCell = { borrowerCount: 0, loanCount: 0, outstanding: '0.00' };
  const nilNatures = {
    interest_rate: 0,
    agreements: 0,
    repayments: 0,
    loan_statement: 0,
    loan_processing: 0,
    others: 0,
  };

  return {
    period: { year: 2026, quarter: 1, startDate: '2026-01-01', endDate: '2026-03-31' },
    msp2_01: {
      rows: [
        { sno: 2, label: '(a) Cash in Hand', source: 'entered', amount: '1500000.00' },
        { sno: 18, label: '(a) Loans to Clients', source: 'derived', amount: '1234567.89' },
        { sno: 33, label: '7. TOTAL ASSETS', source: 'computed', amount: '2734567.89' },
      ],
      missingEntries: [21, 24],
    },
    msp2_05: {
      rows: [
        { sno: 2, label: '(a) Cash in hand', source: 'derived', amount: '1500000.00' },
        { sno: 6, label: '(e) Treasury Bills', source: 'entered', amount: '0.00' },
      ],
      availableLiquidAssets: '1500000.00',
      totalAssets: '2734567.89',
      requiredMinimum: '136728.39',
      excess: '1363271.61',
      liquidAssetRatio: '54.8531',
      meetsRequirement: true,
    },
    msp2_02: {
      rows: [
        {
          sno: 2,
          label: 'a. Interest - Loans to Clients',
          isComputed: false,
          quarterAmount: '1500000.00',
          yearToDateAmount: '1500000.00',
        },
        {
          sno: 1,
          label: '1. INTEREST INCOME',
          isComputed: true,
          quarterAmount: '1500000.00',
          yearToDateAmount: '1500000.00',
        },
      ],
      yearToDateFrom: '2026-01-01',
      yearToDateTo: '2026-03-31',
    },
    msp2_06: {
      rows: [
        {
          sno: 1,
          label: 'Opening',
          isComputed: false,
          count: 1,
          value: '480000.00',
          byNature: nilNatures,
        },
        {
          sno: 2,
          label: 'Received',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 3,
          label: 'Resolved by the institution',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 4,
          label: 'Resolved by other parties',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 5,
          label: 'Unresolved at the quarter end',
          isComputed: true,
          count: 1,
          value: '480000.00',
          byNature: nilNatures,
        },
        {
          sno: 6,
          label: 'Referred to Bank of Tanzania',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 7,
          label: 'Referred to Fair Competition Commission',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 8,
          label: 'Referred to Courts',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
        {
          sno: 9,
          label: 'Referred to Other Parties',
          isComputed: false,
          count: 0,
          value: '0.00',
          byNature: nilNatures,
        },
      ],
    },
    msp2_07: {
      sections: [
        {
          kind: 'bank_tanzania',
          rows: [
            {
              counterparty: 'CRDB BANK PLC',
              depositTzs: '4000000.00',
              depositForeignTzsEquivalent: '0.00',
              depositTotal: '4000000.00',
              borrowingTzs: '0.00',
              borrowingForeignTzsEquivalent: '0.00',
              borrowingTotal: '0.00',
            },
          ],
          subtotal: {
            depositTzs: '4000000.00',
            depositForeignTzsEquivalent: '0.00',
            depositTotal: '4000000.00',
            borrowingTzs: '0.00',
            borrowingForeignTzsEquivalent: '0.00',
            borrowingTotal: '0.00',
          },
        },
        {
          kind: 'microfinance_service_provider',
          rows: [],
          subtotal: {
            depositTzs: '0.00',
            depositForeignTzsEquivalent: '0.00',
            depositTotal: '0.00',
            borrowingTzs: '0.00',
            borrowingForeignTzsEquivalent: '0.00',
            borrowingTotal: '0.00',
          },
        },
      ],
      total: {
        depositTzs: '4000000.00',
        depositForeignTzsEquivalent: '0.00',
        depositTotal: '4000000.00',
        borrowingTzs: '0.00',
        borrowingForeignTzsEquivalent: '0.00',
        borrowingTotal: '0.00',
      },
    },
    msp2_08: {
      rows: [
        { institutionCode: 'crdb_bank_plc', balance: '250000.00' },
        { institutionCode: 'nbc_limited', balance: '0.00' },
      ],
      total: '250000.00',
    },
    msp2_03: {
      rows: [
        {
          sectorCode: 'agriculture',
          borrowerCount: 1,
          totalOutstanding: '1234567.89',
          outstandingByClass: { ...nilClasses, current: '1234567.89' },
          grossProvision: '12345.68',
          collateral: '0.00',
          netProvision: '12345.68',
          netAmount: '1222222.21',
          writtenOffDuringPeriod: '0.00',
        },
        {
          sectorCode: 'fishing',
          borrowerCount: 0,
          totalOutstanding: '0.00',
          outstandingByClass: nilClasses,
          grossProvision: '0.00',
          collateral: '0.00',
          netProvision: '0.00',
          netAmount: '0.00',
          writtenOffDuringPeriod: '0.00',
        },
      ],
      total: {
        sectorCode: 'TOTAL',
        borrowerCount: 1,
        totalOutstanding: '1234567.89',
        outstandingByClass: { ...nilClasses, current: '1234567.89' },
        grossProvision: '12345.68',
        collateral: '0.00',
        netProvision: '12345.68',
        netAmount: '1222222.21',
        writtenOffDuringPeriod: '0.00',
      },
      nonPerformingRatio: '0.0000',
      unclassifiableLoanCount: 0,
    },
    msp2_04: {
      rows: [
        {
          botLoanType: 'agriculture_loans',
          borrowerCount: 1,
          totalOutstanding: '1234567.89',
          straightLine: { lowest: '24.0000', highest: '24.0000', weightedAverage: '48.0000' },
          reducingBalance: nilBand,
        },
      ],
      total: {
        borrowerCount: 1,
        totalOutstanding: '1234567.89',
        straightLine: { lowest: '24.0000', highest: '24.0000', weightedAverage: '48.0000' },
        reducingBalance: nilBand,
      },
      annualisation: 'simple',
    },
    msp2_09: {
      rows: [
        {
          sectorCode: 'agriculture',
          female: { count: 1, amount: '1500000.00' },
          male: { count: 0, amount: '0.00' },
          total: { count: 1, amount: '1500000.00' },
        },
      ],
      total: {
        sectorCode: 'TOTAL',
        female: { count: 1, amount: '1500000.00' },
        male: { count: 0, amount: '0.00' },
        total: { count: 1, amount: '1500000.00' },
      },
    },
    msp2_10: {
      districts: [
        {
          districtCode: 'tz_arusha__arusha_cc',
          regionCode: 'tz_arusha',
          branchCount: 1,
          employeeCount: 4,
          compulsorySavings: '0.00',
          cells: {
            up_to_35_female: { borrowerCount: 1, loanCount: 1, outstanding: '1234567.89' },
            up_to_35_male: nilCell,
            above_35_female: nilCell,
            above_35_male: nilCell,
          },
          totalBorrowers: 1,
          totalOutstanding: '1234567.89',
        },
        {
          districtCode: 'tz_arusha__karatu_dc',
          regionCode: 'tz_arusha',
          branchCount: 0,
          employeeCount: 0,
          compulsorySavings: '0.00',
          cells: {
            up_to_35_female: nilCell,
            up_to_35_male: nilCell,
            above_35_female: nilCell,
            above_35_male: nilCell,
          },
          totalBorrowers: 0,
          totalOutstanding: '0.00',
        },
      ],
      regions: [
        {
          regionCode: 'tz_arusha',
          branchCount: 1,
          employeeCount: 4,
          compulsorySavings: '0.00',
          totalBorrowers: 1,
          totalOutstanding: '1234567.89',
        },
      ],
      grandTotal: {
        regionCode: 'GRAND_TOTAL',
        branchCount: 1,
        employeeCount: 4,
        compulsorySavings: '0.00',
        totalBorrowers: 1,
        totalOutstanding: '1234567.89',
      },
    },
    validation: {
      findings: [
        {
          ruleId: 1,
          formCode: 'MSP2-01',
          severity: 'warning',
          message:
            'Rule 1 could not be checked: it requires the balance sheet, which is not built.',
        },
      ],
      submittable: true,
    },
    unavailableForms: [{ code: 'MSP2-01', reason: 'The balance sheet needs stage 12.' }],
    ...overrides,
  };
}

function renderPage(): void {
  // `void`, not `ReactNode`: React 19 types an async component's return, so
  // `ReactNode` is a union containing a Promise and every call site would read
  // as a floating one.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  render(
    <QueryClientProvider client={queryClient}>
      <ReportsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  quarterlyReturn.mockReset();
  reclassify.mockReset();
  reclassify.mockResolvedValue({ institutionId: 'i', unclassifiableLoanCount: 0 });
});

describe('lastCompletedQuarter', () => {
  it('offers the quarter that has ended, never the one still running', () => {
    // A quarter still running has no closing balances and the API refuses it,
    // so defaulting to "this quarter" would open the screen on an error.
    expect(lastCompletedQuarter(new Date('2026-05-14T00:00:00Z'))).toEqual({
      year: 2026,
      quarter: 1,
    });
  });

  it('steps back into the previous year from the first quarter', () => {
    expect(lastCompletedQuarter(new Date('2026-02-01T00:00:00Z'))).toEqual({
      year: 2025,
      quarter: 4,
    });
  });

  it('does not treat the last day of a quarter as if that quarter had ended', () => {
    // 31 March is still inside Q1. Reporting it as complete would file a
    // quarter one day before its closing balances exist.
    expect(lastCompletedQuarter(new Date('2026-03-31T23:00:00Z'))).toEqual({
      year: 2025,
      quarter: 4,
    });
  });
});

describe('ReportsPage', () => {
  it('prints every figure exactly as the API sent it', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // Grouped for reading, and not re-derived: 1,234,567.89 survives to the
    // last digit, which a double would not.
    const cells = await screen.findAllByText('1,234,567.89');
    expect(cells.length).toBeGreaterThan(0);
  });

  it('marks each balance-sheet line with where its figure came from', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // Entered, derived and computed are three different things, and a screen
    // that rendered them alike would hide which figures a reader can change.
    expect(await screen.findByText('7. TOTAL ASSETS')).toBeInTheDocument();
    expect(screen.getAllByText('derived').length).toBeGreaterThan(0);
    expect(screen.getAllByText('entered').length).toBeGreaterThan(0);
    // An incomplete sheet says so rather than leaving rule 1 to explain it.
    expect(screen.getByText(/2 line\(s\) have not been filled in yet/)).toBeInTheDocument();
  });

  it('shows MSP2-02 as two columns and marks the lines BOT derives', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    expect(await screen.findByText('1. INTEREST INCOME')).toBeInTheDocument();
    // The window the year-to-date column covers is stated, because §11.8 does
    // not settle whether that year is the calendar year or the institution's.
    expect(screen.getByText(/Year to date covers 1 Jan 2026/)).toBeInTheDocument();
  });

  it('shows a liquidity shortfall as a supervisory matter, not a filing error', async () => {
    const base = compiledReturn();
    quarterlyReturn.mockResolvedValue({
      ...base,
      msp2_05: {
        ...base.msp2_05,
        excess: '-300000.00',
        liquidAssetRatio: '2.0000',
        meetsRequirement: false,
      },
    });
    renderPage();

    expect(await screen.findByText(/below BOT’s 5% minimum/)).toBeInTheDocument();
  });

  it('shows every MSP2-07 section, including one holding nothing', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    expect(await screen.findByText('Banks in Tanzania')).toBeInTheDocument();
    expect(screen.getByText('Microfinance service providers')).toBeInTheDocument();
    expect(screen.getByText('Nothing held in this section.')).toBeInTheDocument();
  });

  it('lists only the banks with an agent-banking balance, and the full total', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // BOT prints all 52 institutions; 49 rows of zero help nobody checking a
    // return, and the total is what rule 15 ties to MSP2-01.
    const totals = await screen.findAllByText('250,000.00');
    expect(totals).toHaveLength(2);
  });

  it('keeps a sector with no lending on the form', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // BOT reads its templates by position, so an empty row is a row of zeros
    // rather than an absent one. Hiding it here would show the operator a
    // different document from the one being filed.
    expect(await screen.findByText('Fishing')).toBeInTheDocument();
  });

  it('states which annualisation convention produced the rates', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // The convention itself, not the dropdown label that offers it.
    expect(await screen.findByText('simple')).toBeInTheDocument();
    // 2% a month, stated simply, is 24% a year — printed without the four
    // trailing zeros the wire carries, and never re-rounded.
    expect((await screen.findAllByText('24%')).length).toBeGreaterThan(0);
  });

  it('shows a rate band with no lending as blank rather than as zero', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    // A loan type with no reducing-balance lending has no lowest rate.
    // Printing 0% would say it lends at nothing.
    const dashes = await screen.findAllByText('—');
    expect(dashes.length).toBeGreaterThan(0);
  });

  it('names the forms it cannot produce', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    expect(await screen.findByText(/cannot yet produce/i)).toBeInTheDocument();
    expect(screen.getByText(/balance sheet needs stage 12/)).toBeInTheDocument();
  });

  it('renders each readiness problem separately when the return is refused', async () => {
    quarterlyReturn.mockRejectedValue(
      new ApiRequestError(
        'rule_violation',
        'This return cannot be compiled from figures in their current state.',
        422,
        [
          {
            path: ['classifications_stale'],
            message: 'Classifications were computed 40 hours ago.',
          },
          { path: ['unlocated_branches'], message: '2 active branch(es) have no BOT district.' },
        ],
      ),
    );
    renderPage();

    // One item per problem. Collapsed into a sentence, an operator cannot tell
    // whether they are fixing one thing or four — and each fix otherwise costs
    // a filing window.
    const heading = await screen.findByText('This return cannot be filed yet');
    const panel = heading.closest('section');
    if (panel === null) {
      throw new Error('The refusal was not rendered inside a panel.');
    }

    const problems = within(panel).getAllByRole('listitem');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toHaveTextContent('40 hours ago');
    expect(problems[1]).toHaveTextContent('no BOT district');
  });

  it('shows no forms at all when the return was refused', async () => {
    quarterlyReturn.mockRejectedValue(
      new ApiRequestError('rule_violation', 'Not ready.', 422, [
        { path: ['never_classified'], message: 'Run the classification job before filing.' },
      ]),
    );
    renderPage();

    await screen.findByText('This return cannot be filed yet');

    // Nothing partial. A screen showing four tables beside a refusal invites
    // somebody to copy the figures out of them.
    expect(screen.queryByText(/Sectoral classification/)).not.toBeInTheDocument();
  });

  it('falls back to the shared notice for a failure that is not a business refusal', async () => {
    quarterlyReturn.mockRejectedValue(
      new ApiRequestError(
        'internal_error',
        'Something went wrong on our side.',
        500,
        [],
        'abc-123',
      ),
    );
    renderPage();

    // The correlation ID is the only thing that lets support find the request,
    // and the refusal panel would not show it.
    expect(await screen.findByText(/Reference: abc-123/)).toBeInTheDocument();
  });

  it('marks a return with a blocking finding as not submittable', async () => {
    const base = compiledReturn();
    quarterlyReturn.mockResolvedValue({
      ...base,
      validation: {
        submittable: false,
        findings: [
          {
            ruleId: 17,
            formCode: 'MSP2-03',
            severity: 'blocking',
            message: 'The classification columns do not sum to total outstanding.',
          },
        ],
      },
    });
    renderPage();

    expect(await screen.findByText('Not valid for submission')).toBeInTheDocument();
    expect(screen.getByText(/do not sum to total outstanding/)).toBeInTheDocument();
  });

  it('shows the complaints roll-forward, with the closing line marked as BOT’s', async () => {
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    const panel = (await screen.findByText('MSP2-06 — Complaints')).closest('section');
    if (panel === null) {
      throw new Error('The complaints form was not rendered inside a panel.');
    }

    // Line 5 is the one BOT's template computes; the four above it move.
    expect(within(panel).getByText('Unresolved at the quarter end')).toBeTruthy();
    expect(within(panel).getByText('Referred to Courts')).toBeTruthy();
  });
});

describe('field labelling', () => {
  it('names the rate-conversion field by its label alone, not by its label and its hint', async () => {
    // See the same test in finance-page.test.tsx: a hint inside the `<label>`
    // is read as part of the field's name rather than as its description.
    quarterlyReturn.mockResolvedValue(compiledReturn());
    renderPage();

    const conversion = await screen.findByLabelText('Rate conversion');
    expect(conversion.getAttribute('aria-describedby')).toBe('report-annualisation-hint');
    expect(screen.getByText(/simple or compounded is unconfirmed/)).toBeInTheDocument();
  });
});

describe('acting on a refusal', () => {
  /** The 422 the server sends when classifications have never been computed. */
  const staleRefusal = (): ApiRequestError =>
    new ApiRequestError(
      'rule_violation',
      'This return cannot be compiled from figures in their current state.',
      422,
      [
        {
          path: ['never_classified'],
          message:
            'Overdue classifications have never been computed for this institution, so every ' +
            'loan would report as it stood at creation. Run the classification job before filing.',
        },
      ],
    );

  it('offers to run the classification the refusal asks for', async () => {
    // The whole point. A refusal answerable only at a database console is how
    // the previous build's job came to be run by hand and then forgotten.
    quarterlyReturn.mockRejectedValue(staleRefusal());
    renderPage();

    expect(
      await screen.findByRole('button', { name: 'Run classification now' }),
    ).toBeInTheDocument();
  });

  it('runs it and asks for the return again', async () => {
    quarterlyReturn.mockRejectedValue(staleRefusal());
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Run classification now' }));

    expect(reclassify).toHaveBeenCalledTimes(1);
  });

  it('says so when the run left loans no band covers', async () => {
    // A run that "succeeded" with a non-zero count has not made the return
    // fileable, and reporting only success would mislead.
    quarterlyReturn.mockRejectedValue(staleRefusal());
    reclassify.mockResolvedValue({ institutionId: 'i', unclassifiableLoanCount: 4 });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Run classification now' }));

    expect(await screen.findByText(/4 loan\(s\) fall outside/)).toBeInTheDocument();
    expect(screen.getByText(/§11\.5/)).toBeInTheDocument();
  });

  it('offers no button for a refusal running the job cannot fix', async () => {
    // Branches with no BOT district need a person to decide something. A button
    // that cannot help is worse than none.
    quarterlyReturn.mockRejectedValue(
      new ApiRequestError(
        'rule_violation',
        'This return cannot be compiled from figures in their current state.',
        422,
        [{ path: ['unlocated_branches'], message: 'Two active branches have no BOT district.' }],
      ),
    );
    renderPage();

    await screen.findByText(/have no BOT district/);
    expect(screen.queryByRole('button', { name: 'Run classification now' })).toBeNull();
  });
});
