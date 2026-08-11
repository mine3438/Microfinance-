/**
 * Business rules and value objects.
 *
 * Pure TypeScript by construction: no framework, no database driver, no I/O.
 * An ESLint boundary rule fails the build if any of those are imported here,
 * which is what keeps these rules testable without standing anything up — and
 * what stops a regulatory calculation from quietly acquiring a dependency on
 * the shape of an HTTP request.
 */

export { DomainError, DomainValidationError } from './errors.js';

export {
  ALLOCATION_BUCKETS,
  DOCUMENTED_ALLOCATION_ORDER,
  allocatePayment,
  amountApplied,
  balanceAfter,
} from './repayment/allocation.js';
export type {
  AllocationBucket,
  AllocationRequest,
  OutstandingAmounts,
  PaymentAllocation,
} from './repayment/allocation.js';

export {
  AGE_BAND_LABELS,
  AGE_BAND_THRESHOLD_YEARS,
  ageBandAt,
  completedYearsBetween,
} from './client/age-band.js';
export type { AgeBand } from './client/age-band.js';

export { GENDERS, isGender, parseGender } from './client/gender.js';
export type { Gender } from './client/gender.js';

export { PhoneNumber } from './client/phone-number.js';

export {
  NON_PERFORMING_CLASSIFICATIONS,
  OVERDUE_CLASSIFICATIONS,
  classifyByDaysOverdue,
  grossProvision,
  isOverdueClassification,
  netProvision,
  nonPerformingRatio,
} from './portfolio/classification.js';
export type {
  ClassificationResult,
  OverdueClassification,
  PortfolioByClassification,
  ProvisioningBand,
} from './portfolio/classification.js';

export {
  MAXIMUM_CLASSIFICATION_AGE_HOURS,
  assessReportingReadiness,
} from './portfolio/freshness.js';
export type {
  ReadinessProblem,
  ReadinessRequest,
  ReportingReadiness,
} from './portfolio/freshness.js';

export { addMonthsFromAnchor, monthlyDueDates } from './lending/due-dates.js';

export { assessApproval } from './lending/approval.js';
export type {
  ApprovalAssessment,
  ApprovalAuthority,
  ApprovalRefusal,
  ApprovalRequest,
} from './lending/approval.js';

export {
  LOAN_STATUSES,
  LOAN_TRANSITIONS,
  TERMINAL_LOAN_STATUSES,
  assertTransition,
  canTransition,
  isDisbursed,
  isLoanStatus,
  isOutstanding,
} from './lending/loan-status.js';
export type { LoanStatus } from './lending/loan-status.js';

export {
  INTEREST_METHODS,
  MAXIMUM_TERM_MONTHS,
  generateSchedule,
  isInterestMethod,
} from './lending/schedule.js';
export type {
  InterestMethod,
  RepaymentSchedule,
  ScheduleInstalment,
  ScheduleRequest,
} from './lending/schedule.js';

export {
  QUARTERS,
  formatPeriod,
  isQuarter,
  periodContaining,
  periodContains,
  reportingPeriod,
} from './reporting/period.js';
export type { Quarter, ReportingPeriod } from './reporting/period.js';

export type { FinanceDirection, FinanceEntry, Msp2_02Line } from './finance/entry.js';

export { compileMsp2_02 } from './reporting/msp2-02.js';
export type { Msp2_02, Msp2_02Request, Msp2_02Row } from './reporting/msp2-02.js';

export { HOLDING_KINDS, compileMsp2_07 } from './reporting/msp2-07.js';
export type {
  CounterpartyHolding,
  HoldingKind,
  Msp2_07,
  Msp2_07Request,
  Msp2_07Row,
  Msp2_07Section,
} from './reporting/msp2-07.js';

export { compileMsp2_08 } from './reporting/msp2-08.js';
export type {
  AgentBankingBalance,
  Msp2_08,
  Msp2_08Request,
  Msp2_08Row,
} from './reporting/msp2-08.js';

export { compileMsp2_03 } from './reporting/msp2-03.js';
export type {
  ClassifiedExposure,
  Msp2_03,
  Msp2_03Request,
  Msp2_03Row,
  SectorCollateral,
  SectorWriteOff,
} from './reporting/msp2-03.js';

export { amortisationMethodFor, compileMsp2_04 } from './reporting/msp2-04.js';
export type {
  AmortisationMethod,
  Msp2_04,
  Msp2_04Request,
  Msp2_04Row,
  RateBand,
  RateExposure,
} from './reporting/msp2-04.js';

export { compileMsp2_09 } from './reporting/msp2-09.js';
export type {
  Disbursement,
  GenderSplit,
  Msp2_09,
  Msp2_09Request,
  Msp2_09Row,
} from './reporting/msp2-09.js';

export { compileMsp2_10 } from './reporting/msp2-10.js';
export type {
  DemographicCell,
  DemographicKey,
  DistrictInHierarchy,
  DistrictPresence,
  GeographicExposure,
  Msp2_10,
  Msp2_10RegionSubtotal,
  Msp2_10Request,
  Msp2_10Row,
} from './reporting/msp2-10.js';

export { validatePortfolioForms } from './reporting/validation.js';
export type {
  PortfolioForms,
  ValidationFinding,
  ValidationResult,
  ValidationSeverity,
} from './reporting/validation.js';
