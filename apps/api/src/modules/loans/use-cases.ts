import {
  type CreateLoanRequest,
  type DecideLoanRequest,
  type DisburseLoanRequest,
  type Loan,
  type LoanListQuery,
  type LoanProduct,
  type LoanWithSchedule,
  type PreviewScheduleRequest,
  type RepaymentSchedule,
} from '@mfi/contracts';
import {
  assessApproval,
  generateSchedule,
  type RepaymentSchedule as DomainSchedule,
} from '@mfi/domain';
import { canActOnBranch, type Principal } from '@mfi/identity';
import { Money, Rate } from '@mfi/money';

import { type PagedRows } from '../../http/cursor.js';
import { ApiError, forbidden, notFound, ruleViolation } from '../../http/errors.js';
import { type ApplicationContext, type LoanRepository } from './loan-repository.js';

function resolveBranchFilter(
  principal: Principal,
  requested: string | undefined,
): string | undefined {
  if (principal.branchId === null) {
    return requested;
  }
  if (requested !== undefined && requested !== principal.branchId) {
    throw forbidden('You can only see loans belonging to your own branch.');
  }
  return principal.branchId;
}

export async function listLoans(
  principal: Principal,
  query: LoanListQuery,
  loans: LoanRepository,
): Promise<PagedRows<Loan>> {
  return loans.list(principal.institutionId, principal.userId, {
    limit: query.limit,
    cursor: query.cursor,
    status: query.status,
    clientId: query.clientId,
    branchId: resolveBranchFilter(principal, query.branchId),
  });
}

export async function getLoan(
  principal: Principal,
  loanId: string,
  loans: LoanRepository,
): Promise<LoanWithSchedule> {
  const found = await loans.findWithSchedule(principal.institutionId, principal.userId, loanId);

  if (found === null || !canActOnBranch(principal, found.loan.branchId)) {
    throw notFound('No such loan.');
  }

  return { ...found.loan, schedule: found.schedule };
}

/**
 * Check an application against the product it was written for.
 *
 * The product defines the bounds an institution has decided it will lend
 * within. Applying them here rather than only at the database means the refusal
 * names the field and quotes the limit, which is what an officer needs to
 * correct it.
 */
function assertWithinProduct(
  request: { principal: string; monthlyRate: string; termMonths: number },
  context: ApplicationContext,
): void {
  const { product } = context;
  const problems: { path: (string | number)[]; message: string }[] = [];

  const principal = Money.fromDatabaseValue(request.principal);
  const minPrincipal = Money.fromDatabaseValue(product.minPrincipal);
  const maxPrincipal = Money.fromDatabaseValue(product.maxPrincipal);

  if (principal.lessThan(minPrincipal) || principal.greaterThan(maxPrincipal)) {
    problems.push({
      path: ['principal'],
      message: `${product.name} lends between ${product.minPrincipal} and ${product.maxPrincipal}.`,
    });
  }

  const rate = Rate.ofMonthlyFraction(request.monthlyRate);
  const minRate = Rate.ofMonthlyFraction(product.minMonthlyRate);
  const maxRate = Rate.ofMonthlyFraction(product.maxMonthlyRate);

  if (rate.lessThan(minRate) || rate.greaterThan(maxRate)) {
    problems.push({
      path: ['monthlyRate'],
      message:
        `${product.name} carries a monthly rate between ${product.minMonthlyRate} and ` +
        `${product.maxMonthlyRate}.`,
    });
  }

  if (request.termMonths < product.minTermMonths || request.termMonths > product.maxTermMonths) {
    problems.push({
      path: ['termMonths'],
      message:
        `${product.name} runs between ${String(product.minTermMonths)} and ` +
        `${String(product.maxTermMonths)} months.`,
    });
  }

  if (problems.length > 0) {
    throw new ApiError(
      'validation_failed',
      'Those terms fall outside what this product permits.',
      problems,
    );
  }
}

/** Load the client and product, refusing anything the caller may not use. */
async function loadContext(
  principal: Principal,
  request: { clientId: string; productId: string },
  loans: LoanRepository,
): Promise<ApplicationContext> {
  const context = await loans.applicationContext(
    principal.institutionId,
    principal.userId,
    request.clientId,
    request.productId,
  );

  if (context === null) {
    throw new ApiError('validation_failed', 'That client or product could not be found.', [
      { path: ['clientId'], message: 'Check the client and product are both yours.' },
    ]);
  }

  if (!canActOnBranch(principal, context.clientBranchId)) {
    // Same answer as a client that does not exist, for the same reason: a
    // distinct refusal would confirm the client is real.
    throw new ApiError('validation_failed', 'That client or product could not be found.', [
      { path: ['clientId'], message: 'Check the client and product are both yours.' },
    ]);
  }

  if (context.clientStatus !== 'active') {
    throw ruleViolation('That client is not active, so no new lending can be recorded for them.');
  }

  if (context.product.status !== 'active') {
    throw ruleViolation(
      `${context.product.name} has been retired and is not available for new lending.`,
    );
  }

  return context;
}

/**
 * Retire a product, or bring one back.
 *
 * `loan_products.status` has carried `'retired'` since migration 0008 with
 * nothing to set it, so a product entered in error stayed on the officer's list
 * for good. The refusal that makes retirement mean anything already existed —
 * `requireApplicationContext` above rejects lending on a retired product — so
 * this only supplies the transition it was waiting for.
 */
export async function setLoanProductStatus(
  principal: Principal,
  productId: string,
  status: 'active' | 'retired',
  loans: LoanRepository,
): Promise<LoanProduct> {
  const updated = await loans.setProductStatus(
    principal.institutionId,
    principal.userId,
    productId,
    status,
  );
  if (updated === null) {
    throw notFound('That loan product does not exist.');
  }
  return updated;
}

/**
 * Build a schedule from a request.
 *
 * **The single implementation.** The preview endpoint and the disbursement path
 * both call this, which both call `generateSchedule` in the domain. The system
 * this replaces computed the breakdown twice — once server-side to write the
 * schedule and once in the browser to preview it — and its own technical
 * document warned that if the two drifted, the preview would lie about what was
 * actually recorded. There is no second implementation here to drift from.
 */
function buildSchedule(
  request: { principal: string; monthlyRate: string; termMonths: number },
  interestMethod: 'flat' | 'reducing_balance',
  disbursementDate: Date,
): DomainSchedule {
  return generateSchedule({
    principal: Money.fromDatabaseValue(request.principal),
    monthlyRate: Rate.ofMonthlyFraction(request.monthlyRate),
    termMonths: request.termMonths,
    method: interestMethod,
    disbursementDate,
  });
}

/** Shape a domain schedule for the wire. */
function toWireSchedule(schedule: DomainSchedule): RepaymentSchedule {
  return {
    instalments: schedule.instalments.map((instalment) => ({
      monthNumber: instalment.monthNumber,
      dueDate: instalment.dueDate.toISOString().slice(0, 10),
      openingBalance: instalment.openingBalance.toDatabaseValue(),
      principalDue: instalment.principalDue.toDatabaseValue(),
      interestDue: instalment.interestDue.toDatabaseValue(),
      totalDue: instalment.totalDue.toDatabaseValue(),
      closingBalance: instalment.closingBalance.toDatabaseValue(),
      // A preview describes a loan that does not exist yet, so nothing is paid.
      isPaid: false,
    })),
    totalPrincipal: schedule.totalPrincipal.toDatabaseValue(),
    totalInterest: schedule.totalInterest.toDatabaseValue(),
    totalRepayable: schedule.totalRepayable.toDatabaseValue(),
  };
}

/**
 * Preview the schedule a set of terms would produce.
 *
 * Writes nothing. It exists so the browser never computes a repayment figure:
 * the frontend shows what this returns, and what this returns comes from the
 * same function the write path uses.
 */
export async function previewSchedule(
  principal: Principal,
  request: PreviewScheduleRequest,
  loans: LoanRepository,
): Promise<RepaymentSchedule> {
  const context = await loadContext(principal, request, loans);
  assertWithinProduct(request, context);

  const disbursementDate =
    request.disbursementDate === undefined
      ? new Date()
      : new Date(`${request.disbursementDate}T00:00:00Z`);

  return toWireSchedule(buildSchedule(request, context.product.interestMethod, disbursementDate));
}

export async function createLoan(
  principal: Principal,
  request: CreateLoanRequest,
  loans: LoanRepository,
): Promise<Loan> {
  const context = await loadContext(principal, request, loans);
  assertWithinProduct(request, context);

  // The interest method comes from the product, never from the request. It
  // determines the whole shape of the schedule, and letting an application
  // nominate one would let two loans on the same product be priced differently
  // with nothing recording why.
  return loans.create(principal.institutionId, principal.userId, {
    branchId: context.clientBranchId,
    clientId: request.clientId,
    productId: request.productId,
    principal: request.principal,
    monthlyRate: request.monthlyRate,
    interestMethod: context.product.interestMethod,
    termMonths: request.termMonths,
  });
}

/** A loan the caller may act on, or the same refusal as one that is absent. */
async function loadLoanForAction(
  principal: Principal,
  loanId: string,
  loans: LoanRepository,
): Promise<Loan> {
  const loan = await loans.find(principal.institutionId, principal.userId, loanId);

  if (loan === null || !canActOnBranch(principal, loan.branchId)) {
    throw notFound('No such loan.');
  }

  return loan;
}

export async function submitLoan(
  principal: Principal,
  loanId: string,
  loans: LoanRepository,
): Promise<Loan> {
  const loan = await loadLoanForAction(principal, loanId, loans);

  const submitted = await loans.submit(principal.institutionId, principal.userId, loanId);

  if (submitted === null) {
    // The guarded update matched nothing, so the status was not `draft`. Read
    // back rather than reported blindly, so the message names the state it is
    // actually in.
    throw ruleViolation(`Only a draft can be submitted for approval; this loan is ${loan.status}.`);
  }

  return submitted;
}

/**
 * Approve or reject an application.
 *
 * The authority check is the domain's `assessApproval`, which refuses for four
 * distinct reasons and says which. Two of them are worth naming here:
 *
 * - **Self-approval.** The person who submitted cannot approve, including an
 *   administrator holding every permission. The point of maker-checker is that
 *   two people saw it, not that one was senior enough. A database constraint
 *   enforces the same rule, because the interface is not the only way in.
 * - **Exceeding authority.** Thresholds are institution configuration, seeded
 *   empty, and an absent limit means *no* authority rather than unlimited
 *   (01-ARCHITECTURE.md §13.3 asks for the figures and has no answer). So until
 *   an institution sets them, every approval is refused — which is the failure
 *   direction to choose when the alternative is approving unlimited amounts
 *   because nobody configured a ceiling.
 */
export async function decideLoan(
  principal: Principal,
  loanId: string,
  request: DecideLoanRequest,
  loans: LoanRepository,
): Promise<Loan> {
  const loan = await loadLoanForAction(principal, loanId, loans);

  if (loan.status !== 'pending_approval') {
    throw ruleViolation(
      `Only an application awaiting approval can be decided; this loan is ${loan.status}.`,
    );
  }
  if (loan.submittedBy === null) {
    throw ruleViolation('This application has no submitter recorded, so it cannot be decided.');
  }

  const configuredLimit = await loans.approvalLimit(
    principal.institutionId,
    principal.userId,
    principal.roles,
  );

  const assessment = assessApproval({
    approver: principal,
    submittedByUserId: loan.submittedBy,
    branchId: loan.branchId,
    principal: Money.fromDatabaseValue(loan.principal),
    authority: {
      maxPrincipal: configuredLimit === null ? null : Money.fromDatabaseValue(configuredLimit),
    },
  });

  if (!assessment.permitted) {
    throw new ApiError('forbidden', assessment.message, undefined);
  }

  const decided =
    request.decision === 'approve'
      ? await loans.approve(principal.institutionId, principal.userId, loanId)
      : await loans.reject(principal.institutionId, principal.userId, loanId, request.reason);

  if (decided === null) {
    // The guarded update matched nothing, so another request decided it between
    // the read and the write.
    throw new ApiError('conflict', 'This application was decided by someone else. Reload it.');
  }

  return decided;
}

export async function disburseLoan(
  principal: Principal,
  loanId: string,
  request: DisburseLoanRequest,
  loans: LoanRepository,
): Promise<LoanWithSchedule> {
  const loan = await loadLoanForAction(principal, loanId, loans);

  if (loan.status !== 'approved') {
    throw ruleViolation(`Only an approved loan can be disbursed; this loan is ${loan.status}.`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const disbursementDate = request.disbursementDate ?? today;

  if (disbursementDate > today) {
    // Backdating is ordinary — a transfer recorded the following morning. A
    // future date is not: the schedule would start in the future and the loan
    // would report as active on a BOT return before any money had moved.
    throw ruleViolation('A disbursement cannot be dated in the future.');
  }

  const schedule = buildSchedule(
    { principal: loan.principal, monthlyRate: loan.monthlyRate, termMonths: loan.termMonths },
    loan.interestMethod,
    new Date(`${disbursementDate}T00:00:00Z`),
  );

  const disbursed = await loans.disburse(
    principal.institutionId,
    principal.userId,
    loanId,
    disbursementDate,
    schedule,
  );

  if (disbursed === null) {
    throw new ApiError('conflict', 'This loan was disbursed by someone else. Reload it.');
  }

  return { ...disbursed, schedule: toWireSchedule(schedule) };
}

/**
 * Record the compulsory savings standing behind a loan.
 *
 * The cap — that a borrower cannot secure more than they hold — is enforced by
 * a database trigger rather than here, because the question spans every loan
 * the borrower has. Checking it in this function would be a read-then-write
 * race, and two concurrent calls could each pass a check the pair then breaks.
 */
export async function secureLoan(
  principal: Principal,
  loanId: string,
  amount: string,
  loans: LoanRepository,
): Promise<Loan> {
  const loan = await loans.secure(principal.institutionId, principal.userId, loanId, amount);
  if (loan === null) {
    throw notFound('That loan does not exist.');
  }
  return loan;
}
