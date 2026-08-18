import {
  acknowledgementSchema,
  allocationPreviewSchema,
  approvalThresholdSchema,
  botLoanTypeSchema,
  classificationRunSchema,
  branchSchema,
  complaintNatureSchema,
  complaintSchema,
  savingsAccountSchema,
  savingsProductSchema,
  savingsTransactionSchema,
  bankAccountBalanceSchema,
  bankAccountSchema,
  clientSchema,
  compiledReturnSchema,
  financeEntrySchema,
  financialInstitutionSchema,
  msp2_01Schema,
  msp2_02LineSchema,
  msp2_05Schema,
  type AnnualisationConvention,
  type ApprovalThreshold,
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
  type SaveStatementLinesRequest,
  type StatementForm,
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
  type BotLoanType,
  type Branch,
  type ClassificationRun,
  type Client,
  type Complaint,
  type ComplaintListQuery,
  type ComplaintNature,
  type CreateClientRequest,
  type CreateLoanProductRequest,
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
  type LogComplaintRequest,
  type ReferComplaintRequest,
  type OpenSavingsAccountRequest,
  type RecordSavingsEntryRequest,
  type RepaymentSchedule,
  type ResolveComplaintRequest,
  type ReversePaymentRequest,
  type ReverseSavingsEntryRequest,
  type SavingsAccount,
  type SavingsAccountListQuery,
  type SavingsProduct,
  type SavingsTransaction,
  type RoleCode,
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
const botLoanTypeListSchema = z.array(botLoanTypeSchema);
const approvalThresholdListSchema = z.array(approvalThresholdSchema);
const branchListSchema = z.array(branchSchema);
const complaintNatureListSchema = z.array(complaintNatureSchema);
const complaintPageSchema = pageSchema(complaintSchema);
const savingsProductListSchema = z.array(savingsProductSchema);
const savingsAccountPageSchema = pageSchema(savingsAccountSchema);
const savingsTransactionListSchema = z.array(savingsTransactionSchema);
const financeEntryPageSchema = pageSchema(financeEntrySchema);
const lineListSchema = z.array(msp2_02LineSchema);
const institutionListSchema = z.array(financialInstitutionSchema);
const bankAccountListSchema = z.array(bankAccountSchema);
const bankBalanceListSchema = z.array(bankAccountBalanceSchema);

/**
 * A statement view.
 *
 * One form comes back per request and the other field is absent, so the shape
 * is optional on both. Parsed rather than cast: a response naming a form this
 * client did not ask for is a version mismatch, not something to render.
 */
const statementViewSchema = z
  .object({
    form: z.enum(['MSP2-01', 'MSP2-05']),
    year: z.number().int(),
    quarter: z.number().int(),
    msp2_01: msp2_01Schema.optional(),
    msp2_05: msp2_05Schema.optional(),
  })
  .strict();

export type StatementView = z.infer<typeof statementViewSchema>;

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

  /**
   * Define a product.
   *
   * The penalty terms are omitted together or sent together; the server refuses
   * a half-set, and a product without them charges no penalty.
   */
  async createProduct(request: CreateLoanProductRequest): Promise<LoanProduct> {
    return apiRequest('/loan-products', loanProductSchema, { method: 'POST', body: request });
  },

  /**
   * Retire a product, or bring one back.
   *
   * Only the status moves. Terms are never amended in place: a loan copies its
   * rate and term at creation, so editing a product would leave it describing
   * terms no loan on the book was written under.
   */
  async setProductStatus(id: string, status: 'active' | 'retired'): Promise<LoanProduct> {
    return apiRequest(`/loan-products/${id}`, loanProductSchema, {
      method: 'PATCH',
      body: { status },
    });
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
export const branches = {
  /**
   * The institution's branches.
   *
   * Changes rarely, so callers cache it for the session. Closed branches come
   * back too — a record filed against one still has to render with a name —
   * and a picker filters to the active ones itself.
   */
  async list(): Promise<Branch[]> {
    return apiRequest('/branches', branchListSchema);
  },
};

export const complaints = {
  async natures(): Promise<ComplaintNature[]> {
    return apiRequest('/reference/complaint-natures', complaintNatureListSchema);
  },

  async list(parameters: Partial<ComplaintListQuery> = {}): Promise<Page<Complaint>> {
    return apiRequest(`/complaints${query({ ...parameters })}`, complaintPageSchema);
  },

  async get(id: string): Promise<Complaint> {
    return apiRequest(`/complaints/${id}`, complaintSchema);
  },

  async log(request: LogComplaintRequest): Promise<Complaint> {
    return apiRequest('/complaints', complaintSchema, { method: 'POST', body: request });
  },

  /**
   * Resolve a complaint.
   *
   * The route is required by the contract, and that is MSP2-06's doing: lines 3
   * and 4 are the only ways a complaint leaves the unresolved population, so a
   * resolution naming neither would vanish from the roll-forward.
   */
  async resolve(id: string, request: ResolveComplaintRequest): Promise<Complaint> {
    return apiRequest(`/complaints/${id}/resolution`, complaintSchema, {
      method: 'POST',
      body: request,
    });
  },

  /** Refer one onward. Dated, because MSP2-06 counts referrals as at a date. */
  async refer(id: string, request: ReferComplaintRequest): Promise<Complaint> {
    return apiRequest(`/complaints/${id}/referral`, complaintSchema, {
      method: 'POST',
      body: request,
    });
  },
};

export const savings = {
  async products(): Promise<SavingsProduct[]> {
    return apiRequest('/savings/products', savingsProductListSchema);
  },

  /**
   * Define a savings product.
   *
   * `settings.manage`, not `savings.manage`: whether a product is compulsory
   * decides whether its balances appear on three BOT forms or on none.
   */
  async createProduct(request: {
    code: string;
    name: string;
    isCompulsory: boolean;
  }): Promise<SavingsProduct> {
    return apiRequest('/savings/products', savingsProductSchema, {
      method: 'POST',
      body: request,
    });
  },

  /** Close a product to new accounts, or reopen it. Accounts already open are untouched. */
  async setProductStatus(id: string, status: 'active' | 'closed'): Promise<SavingsProduct> {
    return apiRequest(`/savings/products/${id}`, savingsProductSchema, {
      method: 'PATCH',
      body: { status },
    });
  },

  async listAccounts(
    parameters: Partial<SavingsAccountListQuery> = {},
  ): Promise<Page<SavingsAccount>> {
    return apiRequest(`/savings/accounts${query({ ...parameters })}`, savingsAccountPageSchema);
  },

  async openAccount(request: OpenSavingsAccountRequest): Promise<SavingsAccount> {
    return apiRequest('/savings/accounts', savingsAccountSchema, {
      method: 'POST',
      body: request,
    });
  },

  async transactions(accountId: string): Promise<SavingsTransaction[]> {
    return apiRequest(`/savings/accounts/${accountId}/transactions`, savingsTransactionListSchema);
  },

  /**
   * Record a deposit or a withdrawal.
   *
   * The balance is never sent. The server locks the account row, reads the
   * balance, refuses an overdraft and writes both the entry and the new
   * balance in one transaction — a browser computing the result would be
   * computing it from a figure that may already be stale.
   */
  async recordEntry(
    accountId: string,
    request: RecordSavingsEntryRequest,
  ): Promise<SavingsTransaction> {
    return apiRequest(`/savings/accounts/${accountId}/transactions`, savingsTransactionSchema, {
      method: 'POST',
      body: request,
    });
  },

  /** Reverse an entry. A mistake is corrected by a reversing entry, never by an edit. */
  async reverseEntry(
    transactionId: string,
    request: ReverseSavingsEntryRequest,
  ): Promise<SavingsTransaction> {
    return apiRequest(`/savings/transactions/${transactionId}/reversal`, savingsTransactionSchema, {
      method: 'POST',
      body: request,
    });
  },
};

export const reference = {
  /**
   * BOT's loan type taxonomy, in BOT's own order.
   *
   * Fetched rather than embedded: a second copy of BOT's list is a list that
   * can disagree with BOT's. It changes only by migration, so it is cached for
   * the life of the page.
   */
  async loanTypes(): Promise<BotLoanType[]> {
    return apiRequest('/reference/loan-types', botLoanTypeListSchema);
  },

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

export const statements = {
  async view(form: StatementForm, year: number, quarter: number): Promise<StatementView> {
    return apiRequest(
      `/statements/${form}/${String(year)}/${String(quarter)}`,
      statementViewSchema,
    );
  },

  /**
   * Save figures and receive the form they produce.
   *
   * The response is the recompiled statement rather than an acknowledgement, so
   * every total that moved is visible without a second call — including a
   * balance sheet that has stopped balancing.
   */
  async save(
    form: StatementForm,
    year: number,
    quarter: number,
    request: SaveStatementLinesRequest,
  ): Promise<StatementView> {
    return apiRequest(
      `/statements/${form}/${String(year)}/${String(quarter)}`,
      statementViewSchema,
      {
        method: 'PUT',
        body: request,
      },
    );
  },
};

export const portfolio = {
  /**
   * Recompute overdue classifications for the signed-in institution.
   *
   * The scheduled job is what normally keeps these fresh. This exists so the
   * person the reports screen has just refused can act on the refusal from the
   * screen that raised it — a refusal answerable only at a database console is
   * how the previous build's job came to be run by hand and then forgotten.
   */
  async reclassify(): Promise<ClassificationRun> {
    return apiRequest('/portfolio/classification', classificationRunSchema, {
      method: 'POST',
      body: {},
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

export const settings = {
  /**
   * Every role's approval limit, including the roles that have none.
   *
   * The server lists all of them rather than only those with a row, because a
   * screen has to be able to show "no authority" as a state. An absent limit
   * means a role may sanction nothing — never that it may sanction anything.
   */
  async approvalThresholds(): Promise<ApprovalThreshold[]> {
    return apiRequest('/settings/approval-thresholds', approvalThresholdListSchema);
  },

  /** Set one role's limit, or pass `null` to remove the authority entirely. */
  async setApprovalThreshold(
    roleCode: RoleCode,
    maxPrincipal: string | null,
  ): Promise<ApprovalThreshold[]> {
    return apiRequest(`/settings/approval-thresholds/${roleCode}`, approvalThresholdListSchema, {
      method: 'PUT',
      body: { maxPrincipal },
    });
  },
};
