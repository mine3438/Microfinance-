/**
 * The wire contract, defined once and shared.
 *
 * The API validates every request against these schemas and shapes every
 * response to them; the web client imports the same objects. A change to a
 * request or response shape is therefore a compile error on both sides of the
 * wire rather than a runtime surprise on one of them — which is the whole
 * reason this package exists as something separate from the API.
 *
 * Two rules hold throughout:
 *
 * - **Money is a string, never a number.** A JSON number is a binary double and
 *   loses decimal fractions. See `scalars.ts`.
 * - **Objects are strict.** An unrecognised key is rejected, not stripped. §10.5
 *   of the architecture said "stripped", written before these schemas existed;
 *   this is the stricter reading and it is deliberate. Stripping means a client
 *   that misspells `principalAmount` gets a successful response describing a
 *   loan it did not ask for. On a request that moves money, silence is the
 *   wrong answer to a typo.
 */

export {
  ERROR_CODES,
  errorResponseSchema,
  fieldErrorSchema,
  type ErrorCode,
  type ErrorResponse,
  type FieldError,
} from './errors.js';

export {
  PERMISSIONS,
  ROLES,
  isPermission,
  isRoleCode,
  type Permission,
  type RoleCode,
  type RoleScope,
} from './authorization.js';

export {
  MONEY_PATTERN,
  RATE_PATTERN,
  emailSchema,
  isoDateSchema,
  isoTimestampSchema,
  moneyAmountSchema,
  nonNegativeMoneyAmountSchema,
  percentageSchema,
  positiveMoneyAmountSchema,
  rateFractionSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

export {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  pageSchema,
  paginationQuerySchema,
  type Page,
  type PaginationQuery,
} from './pagination.js';

export {
  CLIENT_STATUSES,
  GENDERS,
  clientListQuerySchema,
  clientSchema,
  createClientRequestSchema,
  dateOfBirthSchema,
  phoneInputSchema,
  updateClientRequestSchema,
  type Client,
  type ClientListQuery,
  type ClientStatus,
  type CreateClientRequest,
  type Gender,
  type UpdateClientRequest,
} from './clients.js';

export {
  INTEREST_METHODS,
  LOAN_STATUSES,
  MAXIMUM_TERM_MONTHS,
  createLoanRequestSchema,
  decideLoanRequestSchema,
  disburseLoanRequestSchema,
  loanListQuerySchema,
  loanProductSchema,
  loanSchema,
  loanTermsSchema,
  loanWithScheduleSchema,
  previewScheduleRequestSchema,
  repaymentScheduleSchema,
  scheduleInstalmentSchema,
  submitLoanRequestSchema,
  termMonthsSchema,
  type CreateLoanRequest,
  type DecideLoanRequest,
  type DisburseLoanRequest,
  type InterestMethod,
  type Loan,
  type LoanListQuery,
  type LoanProduct,
  type LoanStatus,
  type LoanWithSchedule,
  type PreviewScheduleRequest,
  type RepaymentSchedule,
  type ScheduleInstalment,
} from './loans.js';

export {
  allocationPreviewSchema,
  paymentAllocationSchema,
  paymentListQuerySchema,
  paymentSchema,
  previewAllocationRequestSchema,
  recordPaymentRequestSchema,
  reversePaymentRequestSchema,
  type AllocationPreview,
  type Payment,
  type PaymentAllocation,
  type PaymentListQuery,
  type PreviewAllocationRequest,
  type RecordPaymentRequest,
  type ReversePaymentRequest,
} from './payments.js';

export {
  FINANCE_DIRECTIONS,
  HOLDING_KINDS,
  bankAccountBalanceSchema,
  bankAccountSchema,
  bankBalanceListQuerySchema,
  createBankAccountRequestSchema,
  createFinanceEntryRequestSchema,
  financeEntryListQuerySchema,
  financeEntrySchema,
  financeTotalsSchema,
  financialInstitutionSchema,
  msp2_02LineSchema,
  recordBankBalanceRequestSchema,
  updateFinanceEntryRequestSchema,
  type BankAccount,
  type BankAccountBalance,
  type BankBalanceListQuery,
  type CreateBankAccountRequest,
  type CreateFinanceEntryRequest,
  type FinanceDirection,
  type FinanceEntry,
  type FinanceEntryListQuery,
  type FinanceTotals,
  type FinancialInstitution,
  type HoldingKind,
  type Msp2_02Line,
  type RecordBankBalanceRequest,
  type UpdateFinanceEntryRequest,
} from './finance.js';

export {
  LINE_SOURCES,
  STATEMENT_FORMS,
  msp2_01Schema,
  msp2_05Schema,
  saveStatementLinesRequestSchema,
  statementLineInputSchema,
  statementRowSchema,
  type LineSource,
  type Msp2_01,
  type Msp2_05,
  type SaveStatementLinesRequest,
  type StatementForm,
  type StatementRow,
} from './statements.js';

export {
  COMPLAINT_STATES,
  REFERRAL_DESTINATIONS,
  RESOLUTION_ROUTES,
  complaintListQuerySchema,
  complaintNatureSchema,
  complaintSchema,
  logComplaintRequestSchema,
  referComplaintRequestSchema,
  resolveComplaintRequestSchema,
  type Complaint,
  type ComplaintListQuery,
  type ComplaintNature,
  type ComplaintState,
  type LogComplaintRequest,
  type ReferComplaintRequest,
  type ReferralDestination,
  type ResolutionRoute,
  type ResolveComplaintRequest,
} from './complaints.js';

export {
  AGE_BANDS,
  AMORTISATION_METHODS,
  ANNUALISATION_CONVENTIONS,
  OVERDUE_CLASSIFICATIONS,
  QUARTERS,
  VALIDATION_SEVERITIES,
  compileReturnQuerySchema,
  compiledReturnSchema,
  msp2_02RowSchema,
  msp2_02Schema,
  msp2_03RowSchema,
  msp2_03Schema,
  msp2_04RowSchema,
  msp2_04Schema,
  msp2_06RowSchema,
  msp2_06Schema,
  msp2_07RowSchema,
  msp2_07Schema,
  msp2_07SectionSchema,
  msp2_08Schema,
  msp2_09RowSchema,
  msp2_09Schema,
  msp2_10RowSchema,
  msp2_10Schema,
  msp2_10SubtotalSchema,
  rateBandSchema,
  reportingPeriodSchema,
  unavailableFormSchema,
  validationFindingSchema,
  validationResultSchema,
  type AgeBand,
  type AmortisationMethod,
  type AnnualisationConvention,
  type CompileReturnQuery,
  type CompiledReturn,
  type DemographicKey,
  type Msp2_02,
  type Msp2_03,
  type Msp2_04,
  type Msp2_06,
  type Msp2_07,
  type Msp2_08,
  type Msp2_09,
  type Msp2_10,
  type OverdueClassification,
  type ReportingPeriod,
  type UnavailableForm,
  type ValidationFinding,
  type ValidationResult,
  type ValidationSeverity,
} from './reporting.js';

export {
  filedReturnDetailSchema,
  filedReturnSchema,
  fileReturnRequestSchema,
  recordSubmissionReferenceRequestSchema,
  type FileReturnRequest,
  type FiledReturn,
  type FiledReturnDetail,
  type RecordSubmissionReferenceRequest,
} from './filings.js';

export {
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  acknowledgementSchema,
  loginRequestSchema,
  loginResponseSchema,
  passwordSchema,
  refreshResponseSchema,
  sessionBranchSchema,
  sessionUserSchema,
  type Acknowledgement,
  type LoginRequest,
  type LoginResponse,
  type RefreshResponse,
  type SessionUser,
} from './auth.js';
