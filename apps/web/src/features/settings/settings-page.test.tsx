import { type ApprovalThreshold, type BotLoanType, type LoanProduct } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The settings screen.
 *
 * What is asserted here is mostly what the screen does *not* do: it fills in no
 * penalty rate, it shows an unset approval limit as "no authority" rather than
 * as zero or blank, and it sends the penalty fields as a whole group or not at
 * all. Those are the properties that keep a fabricated figure off a borrower's
 * account, and they are invisible in a screenshot.
 */

const approvalThresholds = vi.fn<() => Promise<ApprovalThreshold[]>>();
const setApprovalThreshold = vi.fn<(...args: unknown[]) => Promise<ApprovalThreshold[]>>();
const products = vi.fn<() => Promise<LoanProduct[]>>();
const createProduct = vi.fn<(...args: unknown[]) => Promise<LoanProduct>>();
const loanTypes = vi.fn<() => Promise<BotLoanType[]>>();
const setProductStatus = vi.fn<(...args: unknown[]) => Promise<LoanProduct>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  settings: {
    approvalThresholds: (): Promise<ApprovalThreshold[]> => approvalThresholds(),
    setApprovalThreshold: (...args: unknown[]): Promise<ApprovalThreshold[]> =>
      setApprovalThreshold(...args),
  },
  loans: {
    products: (): Promise<LoanProduct[]> => products(),
    createProduct: (...args: unknown[]): Promise<LoanProduct> => createProduct(...args),
    setProductStatus: (...args: unknown[]): Promise<LoanProduct> => setProductStatus(...args),
  },
  reference: {
    loanTypes: (): Promise<BotLoanType[]> => loanTypes(),
  },
}));

const { SettingsPage } = await import('./settings-page.js');

const THRESHOLDS: ApprovalThreshold[] = [
  {
    roleCode: 'branch_manager',
    roleName: 'Branch Manager',
    maxPrincipal: '5000000.00',
    updatedAt: '2026-01-05T09:00:00.000Z',
  },
  { roleCode: 'loan_officer', roleName: 'Loan Officer', maxPrincipal: null, updatedAt: null },
];

const LOAN_TYPES: BotLoanType[] = [
  {
    code: 'business_individual_loans',
    name: 'Business Individual Loans',
    sno: 3,
    parentCode: null,
    provisioningSchedule: 'standard',
  },
  {
    code: 'salaried_loans',
    name: 'Salaried Loans',
    sno: 10,
    parentCode: null,
    provisioningSchedule: 'standard',
  },
  {
    code: 'government_employees',
    name: 'Government Employees',
    sno: 11,
    parentCode: 'salaried_loans',
    provisioningSchedule: 'standard',
  },
];

const product = (overrides: Partial<LoanProduct> = {}): LoanProduct => ({
  id: '018f0000-0000-7000-8000-000000000001',
  code: 'BWC',
  name: 'Business Working Capital',
  botLoanType: 'business_individual_loans',
  interestMethod: 'reducing_balance',
  minMonthlyRate: '0.0100',
  maxMonthlyRate: '0.0500',
  minTermMonths: 3,
  maxTermMonths: 36,
  minPrincipal: '100000.00',
  maxPrincipal: '5000000.00',
  status: 'active',
  penaltyDailyRate: null,
  penaltyGraceDays: null,
  penaltyCapFraction: null,
  ...overrides,
});

/**
 * The table row a piece of text sits in.
 *
 * `closest` returns `Element | null`, and a test that reaches through that with
 * `!` reports "cannot read property of null" when the row is missing — naming
 * the assertion rather than the row that was not found.
 */
async function rowContaining(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest('tr');
  if (row === null) {
    throw new Error(`Expected "${text}" to be rendered inside a table row.`);
  }
  return row;
}

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  render(
    <QueryClientProvider client={queryClient}>
      <SettingsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  approvalThresholds.mockResolvedValue(THRESHOLDS);
  setApprovalThreshold.mockResolvedValue(THRESHOLDS);
  loanTypes.mockResolvedValue(LOAN_TYPES);
  products.mockResolvedValue([product()]);
  createProduct.mockResolvedValue(product());
  setProductStatus.mockResolvedValue(product({ status: 'retired' }));
});

describe('approval limits', () => {
  it('shows a role with no limit as having no authority, not as zero', async () => {
    // An absent row means the role may sanction nothing. Rendering it as
    // "0.00" would read as a limit somebody set, and blank would read as
    // still loading.
    renderPage();

    const row = await rowContaining('Loan Officer');
    expect(within(row).getByText('No authority')).toBeTruthy();
  });

  it('offers to remove the authority only where there is one to remove', async () => {
    renderPage();

    const manager = await rowContaining('Branch Manager');
    await userEvent.click(within(manager).getByRole('button', { name: 'Change' }));
    expect(screen.getByRole('button', { name: 'Remove authority' })).toBeTruthy();
  });

  it('sends null to remove a limit, rather than zero or an empty string', async () => {
    renderPage();

    const manager = await rowContaining('Branch Manager');
    await userEvent.click(within(manager).getByRole('button', { name: 'Change' }));
    await userEvent.click(screen.getByRole('button', { name: 'Remove authority' }));

    expect(setApprovalThreshold).toHaveBeenCalledWith('branch_manager', null);
  });

  it('sends the amount as the string that was typed', async () => {
    renderPage();

    const officer = await rowContaining('Loan Officer');
    await userEvent.click(within(officer).getByRole('button', { name: 'Set' }));
    await userEvent.type(screen.getByLabelText('Maximum principal'), '2500000.00');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setApprovalThreshold).toHaveBeenCalledWith('loan_officer', '2500000.00');
  });
});

describe('loan products', () => {
  it('says a product charges no penalty rather than leaving the cell blank', async () => {
    renderPage();

    const row = await rowContaining('Business Working Capital');
    expect(within(row).getByText('None')).toBeTruthy();
  });

  it('describes the terms of a product that does charge one', async () => {
    products.mockResolvedValue([
      product({ penaltyDailyRate: '0.0015', penaltyGraceDays: 5, penaltyCapFraction: '0.2000' }),
    ]);
    renderPage();

    const row = await rowContaining('Business Working Capital');
    expect(within(row).getByText(/0\.0015\/day after 5 days/)).toBeTruthy();
    expect(within(row).getByText(/capped at 0\.2000 of principal/)).toBeTruthy();
  });

  it('names the BOT loan type rather than showing its code', async () => {
    renderPage();

    const row = await rowContaining('Business Working Capital');
    expect(within(row).getByText('Business Individual Loans')).toBeTruthy();
  });

  it('offers BOT’s taxonomy in BOT’s order, marking sub-types', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Define a product' }));

    const select = screen.getByLabelText('BOT loan type');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent);

    expect(options).toEqual([
      'Choose from BOT’s list…',
      'Business Individual Loans',
      'Salaried Loans',
      '— Government Employees',
    ]);
  });

  it('pre-fills no penalty figure, because there is no default to offer', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Define a product' }));
    await userEvent.click(screen.getByLabelText(/charges a late-payment penalty/));

    expect(screen.getByLabelText('Daily penalty rate')).toHaveValue('');
    expect(screen.getByLabelText('Grace days')).toHaveValue(null);
  });

  it('omits the penalty fields entirely when the product charges none', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Define a product' }));
    await fillRequiredFields();
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }));

    expect(createProduct).toHaveBeenCalledTimes(1);
    const request = createProduct.mock.calls[0]?.[0] as Record<string, unknown>;
    // Absent, not an empty string. The server would have to interpret '' and
    // the whole-or-absent rule exists so it never has to.
    expect('penaltyDailyRate' in request).toBe(false);
    expect('penaltyGraceDays' in request).toBe(false);
    expect('penaltyCapFraction' in request).toBe(false);
  });

  it('sends the penalty group whole, with the cap omitted when left blank', async () => {
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Define a product' }));
    await fillRequiredFields();
    await userEvent.click(screen.getByLabelText(/charges a late-payment penalty/));
    await userEvent.type(screen.getByLabelText('Daily penalty rate'), '0.0010');
    await userEvent.type(screen.getByLabelText('Grace days'), '7');
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }));

    const request = createProduct.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['penaltyDailyRate']).toBe('0.0010');
    expect(request['penaltyGraceDays']).toBe(7);
    expect('penaltyCapFraction' in request).toBe(false);
  });

  it('sends every amount and rate as the string that was typed', async () => {
    // The screen performs no arithmetic and no reformatting. A rate typed as
    // 0.0250 arrives as "0.0250", not as 0.025 through a JavaScript number.
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Define a product' }));
    await fillRequiredFields({ minMonthlyRate: '0.0250', minPrincipal: '250000.50' });
    await userEvent.click(screen.getByRole('button', { name: 'Create product' }));

    const request = createProduct.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request['minMonthlyRate']).toBe('0.0250');
    expect(request['minPrincipal']).toBe('250000.50');
  });
});

/** Fill everything the form requires, so a test can vary one thing at a time. */
async function fillRequiredFields(
  overrides: { minMonthlyRate?: string; minPrincipal?: string } = {},
): Promise<void> {
  await userEvent.type(screen.getByLabelText('Code'), 'BWC2');
  await userEvent.type(screen.getByLabelText('Name'), 'Another Product');
  await userEvent.selectOptions(
    screen.getByLabelText('BOT loan type'),
    'business_individual_loans',
  );
  await userEvent.type(
    screen.getByLabelText('Lowest monthly rate'),
    overrides.minMonthlyRate ?? '0.0100',
  );
  await userEvent.type(screen.getByLabelText('Highest monthly rate'), '0.0500');
  await userEvent.type(
    screen.getByLabelText('Smallest principal'),
    overrides.minPrincipal ?? '100000.00',
  );
  await userEvent.type(screen.getByLabelText('Largest principal'), '5000000.00');
}

describe('retiring a product', () => {
  it('retires an active product, which nothing could do before', async () => {
    renderPage();

    const row = await rowContaining('Business Working Capital');
    await userEvent.click(within(row).getByRole('button', { name: 'Retire' }));

    expect(setProductStatus).toHaveBeenCalledWith(
      '018f0000-0000-7000-8000-000000000001',
      'retired',
    );
  });

  it('offers to bring back a retired one, so a mis-click is not permanent', async () => {
    products.mockResolvedValue([product({ status: 'retired' })]);
    renderPage();

    const row = await rowContaining('Business Working Capital');
    expect(within(row).getByText('Retired')).toBeTruthy();

    await userEvent.click(within(row).getByRole('button', { name: 'Bring back' }));
    expect(setProductStatus).toHaveBeenCalledWith('018f0000-0000-7000-8000-000000000001', 'active');
  });

  it('still shows a retired product rather than hiding it', async () => {
    // Hiding it would leave an administrator no way to bring it back, and the
    // loans written against it still name it.
    products.mockResolvedValue([product({ status: 'retired' })]);
    renderPage();

    expect(await screen.findByText('Business Working Capital')).toBeTruthy();
  });
});
