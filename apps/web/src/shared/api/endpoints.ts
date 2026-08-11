import {
  acknowledgementSchema,
  allocationPreviewSchema,
  bankAccountBalanceSchema,
  bankAccountSchema,
  clientSchema,
  compiledReturnSchema,
  financeEntrySchema,
  financialInstitutionSchema,
  msp2_02LineSchema,
  type AnnualisationConvention,
  type BankAccount,
  type BankAccountBalance,
  type CompiledReturn,
  type CreateBankAccountRequest,
  type CreateFinanceEntryRequest,
  type FinanceEntry,
  type FinanceEntryListQuery,
  type FinancialInstitution,
  type Msp2_02Line,
  type RecordBankBalanceRequest,
  type UpdateFinanceEntryRequest,
  loanProductSchema,
  loanSchema,
  loanWithScheduleSchema,
  loginResponseSchema,
  pageSchema,
  paymentSchema,
  repaymentScheduleSchema,
  sessionUserSchema,
  type AllocationPreview,
  type Client,
  type CreateClientRequest,
  type CreateLoanRequest,
  type DecideLoanRequest,
  type DisburseLoanRequest,
  type Loan,
  type LoanProduct,
  type LoanWithSchedule,
  type LoginRequest,
  type LoginResponse,
  type Page,
  type Payment,
  type PreviewScheduleRequest,
  type RecordPaymentRequest,
  type RepaymentSchedule,
  type ReversePaymentRequest,
  type SessionUser,
} from '@mfi/contracts';
import { z } from 'zod';

import { apiRequest } from './client.js';

/**
 * Every call this client makes, named.
 *
 * One function per endpoint, each parsing against the schema the server
 * validates with — the same object, imported from `@mfi/contracts`. There is no
 * hand-written response type anywhere in this app, so a field that changes
 * shape breaks the build here rather than rendering as `undefined`.
 */

const clientPageSchema = pageSchema(clientSchema);
const loanPageSchema = pageSchema(loanSchema);
const paymentPageSchema = pageSchema(paymentSchema);
const productListSchema = z.array(loanProductSchema);
const financeEntryPageSchema = pageSchema(financeEntrySchema);
const lineListSchema = z.array(msp2_02LineSchema);
const institutionListSchema = z.array(financialInstitutionSchema);
const bankAccountListSchema = z.array(bankAccountSchema);
const bankBalanceListSchema = z.array(bankAccountBalanceSchema);

/** Build a query string, omitting anything unset. */
function query(parameters: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(parameters)) {
    if (value !== undefined && value !== '') {
      search.set(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered === '' ? '' : `?${rendered}`;
}

export const auth = {
  async login(request: LoginRequest): Promise<LoginResponse> {
    return apiRequest('/auth/login', loginResponseSchema, {
      method: 'POST',
      body: request,
      authenticated: false,
    });
  },

  async logout(): Promise<void> {
    await apiRequest('/auth/logout', acknowledgementSchema, {
      method: 'POST',
      authenticated: false,
    });
  },

  async me(): Promise<SessionUser> {
    return apiRequest('/auth/me', sessionUserSchema);
  },
};

export interface ClientListParameters {
  readonly search?: string | undefined;
  readonly status?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export const clients = {
  async list(parameters: ClientListParameters = {}): Promise<Page<Client>> {
    return apiRequest(`/clients${query({ ...parameters })}`, clientPageSchema);
  },

  async get(id: string): Promise<Client> {
    return apiRequest(`/clients/${id}`, clientSchema);
  },

  async create(request: CreateClientRequest): Promise<Client> {
    return apiRequest('/clients', clientSchema, { method: 'POST', body: request });
  },
};

export const loans = {
  async products(): Promise<LoanProduct[]> {
    return apiRequest('/loan-products', productListSchema);
  },

  async list(
    parameters: {
      status?: string | undefined;
      clientId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<Page<Loan>> {
    return apiRequest(`/loans${query({ ...parameters })}`, loanPageSchema);
  },

  async get(id: string): Promise<LoanWithSchedule> {
    return apiRequest(`/loans/${id}`, loanWithScheduleSchema);
  },

  /**
   * What a set of terms would produce.
   *
   * The only way this app obtains a repayment figure. Nothing here multiplies a
   * principal by a rate — the server runs the same generator the disbursement
   * path runs, so the borrower is shown what will be recorded.
   */
  async previewSchedule(request: PreviewScheduleRequest): Promise<RepaymentSchedule> {
    return apiRequest('/loans/preview-schedule', repaymentScheduleSchema, {
      method: 'POST',
      body: request,
    });
  },

  async create(request: CreateLoanRequest): Promise<Loan> {
    return apiRequest('/loans', loanSchema, { method: 'POST', body: request });
  },

  async submit(id: string): Promise<Loan> {
    return apiRequest(`/loans/${id}/submit`, loanSchema, { method: 'POST', body: {} });
  },

  async decide(id: string, request: DecideLoanRequest): Promise<Loan> {
    return apiRequest(`/loans/${id}/decision`, loanSchema, { method: 'POST', body: request });
  },

  async disburse(id: string, request: DisburseLoanRequest = {}): Promise<LoanWithSchedule> {
    return apiRequest(`/loans/${id}/disbursement`, loanWithScheduleSchema, {
      method: 'POST',
      body: request,
    });
  },
};

export const payments = {
  async list(
    parameters: {
      loanId?: string | undefined;
      clientId?: string | undefined;
      cursor?: string | undefined;
      limit?: number | undefined;
    } = {},
  ): Promise<Page<Payment>> {
    return apiRequest(`/payments${query({ ...parameters })}`, paymentPageSchema);
  },

  /** How an amount would be applied, from the same allocator that will apply it. */
  async previewAllocation(loanId: string, amountPaid: string): Promise<AllocationPreview> {
    return apiRequest(`/loans/${loanId}/payments/preview`, allocationPreviewSchema, {
      method: 'POST',
      body: { amountPaid },
    });
  },

  async record(loanId: string, request: RecordPaymentRequest): Promise<Payment> {
    return apiRequest(`/loans/${loanId}/payments`, paymentSchema, {
      method: 'POST',
      body: request,
    });
  },

  async reverse(paymentId: string, request: ReversePaymentRequest): Promise<Payment> {
    return apiRequest(`/payments/${paymentId}/reversal`, paymentSchema, {
      method: 'POST',
      body: request,
    });
  },
};

/**
 * BOT's own reference data.
 *
 * Fetched rather than embedded. The MSP2-02 line list and the published
 * institution lists are BOT's, they change when BOT revises a template, and a
 * copy compiled into this bundle is a copy that can disagree with the one the
 * database enforces.
 */
export const reference = {
  async msp2_02Lines(): Promise<Msp2_02Line[]> {
    return apiRequest('/reference/msp2-02-lines', lineListSchema);
  },

  async financialInstitutions(): Promise<FinancialInstitution[]> {
    return apiRequest('/reference/financial-institutions', institutionListSchema);
  },
};

export const finance = {
  async listEntries(parameters: Partial<FinanceEntryListQuery> = {}): Promise<Page<FinanceEntry>> {
    return apiRequest(`/finance/entries${query({ ...parameters })}`, financeEntryPageSchema);
  },

  async recordEntry(request: CreateFinanceEntryRequest): Promise<FinanceEntry> {
    return apiRequest('/finance/entries', financeEntrySchema, { method: 'POST', body: request });
  },

  async amendEntry(id: string, request: UpdateFinanceEntryRequest): Promise<FinanceEntry> {
    return apiRequest(`/finance/entries/${id}`, financeEntrySchema, {
      method: 'PATCH',
      body: request,
    });
  },

  async removeEntry(id: string): Promise<void> {
    await apiRequest(`/finance/entries/${id}`, z.unknown(), { method: 'DELETE' });
  },

  async listBankAccounts(): Promise<BankAccount[]> {
    return apiRequest('/finance/bank-accounts', bankAccountListSchema);
  },

  async openBankAccount(request: CreateBankAccountRequest): Promise<BankAccount> {
    return apiRequest('/finance/bank-accounts', bankAccountSchema, {
      method: 'POST',
      body: request,
    });
  },

  async listBankBalances(year: number, quarter: number): Promise<BankAccountBalance[]> {
    return apiRequest(`/finance/bank-balances${query({ year, quarter })}`, bankBalanceListSchema);
  },

  /** One figure per account per quarter, so recording is a replace. */
  async recordBankBalance(
    accountId: string,
    request: RecordBankBalanceRequest,
  ): Promise<BankAccountBalance> {
    return apiRequest(`/finance/bank-accounts/${accountId}/balances`, bankAccountBalanceSchema, {
      method: 'PUT',
      body: request,
    });
  },
};

export const reports = {
  /**
   * Compile a quarterly BOT return.
   *
   * A `GET` that computes. Nothing is stored, the same quarter asked twice
   * gives the same answer, and the figures are produced entirely on the server
   * — this app receives a finished return and renders it.
   *
   * It fails often and on purpose: a 422 when classifications are stale or a
   * loan falls outside every provisioning band, carrying one detail per
   * problem. Those refusals are the feature, so the screen renders them rather
   * than reducing them to "something went wrong".
   */
  async quarterlyReturn(
    year: number,
    quarter: number,
    annualisation?: AnnualisationConvention,
  ): Promise<CompiledReturn> {
    return apiRequest(
      `/reports/msp2/${String(year)}/${String(quarter)}${query({ annualisation })}`,
      compiledReturnSchema,
    );
  },
};
