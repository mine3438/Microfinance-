import {
  type AllocationPreview,
  type Payment,
  type PaymentAllocation,
  type PaymentListQuery,
  type PreviewAllocationRequest,
  type RecordPaymentRequest,
  type ReversePaymentRequest,
} from '@mfi/contracts';
import {
  DOCUMENTED_ALLOCATION_ORDER,
  allocatePayment,
  amountApplied,
  balanceAfter,
  type PaymentAllocation as DomainAllocation,
} from '@mfi/domain';
import { canActOnBranch, type Principal } from '@mfi/identity';
import { Money } from '@mfi/money';

import { type PagedRows } from '../../http/cursor.js';
import { forbidden, notFound, ruleViolation } from '../../http/errors.js';
import { type LoanBalance, type PaymentRepository } from './payment-repository.js';

function resolveBranchFilter(
  principal: Principal,
  requested: string | undefined,
): string | undefined {
  return principal.branchId ?? requested;
}

export async function listPayments(
  principal: Principal,
  query: PaymentListQuery,
  payments: PaymentRepository,
): Promise<PagedRows<Payment>> {
  return payments.list(principal.institutionId, principal.userId, {
    limit: query.limit,
    cursor: query.cursor,
    loanId: query.loanId,
    clientId: query.clientId,
    branchId: resolveBranchFilter(principal, undefined),
  });
}

export async function getPayment(
  principal: Principal,
  paymentId: string,
  payments: PaymentRepository,
): Promise<Payment> {
  const found = await payments.find(principal.institutionId, principal.userId, paymentId);

  if (found === null) {
    throw notFound('No such payment.');
  }

  return found;
}

/** A loan a payment may be recorded against, or a refusal saying why not. */
async function loadPayableLoan(
  principal: Principal,
  loanId: string,
  payments: PaymentRepository,
): Promise<LoanBalance> {
  const loan = await payments.loanBalance(principal.institutionId, principal.userId, loanId);

  if (loan === null || !canActOnBranch(principal, loan.branchId)) {
    throw notFound('No such loan.');
  }

  // Only a disbursed loan can receive money. A payment against a draft or a
  // rejected application is a payment against a loan that was never advanced,
  // which would put a receipt on a return with no lending behind it.
  if (loan.status !== 'active' && loan.status !== 'completed') {
    throw ruleViolation(
      `Payments can only be recorded against a disbursed loan; this one is ${loan.status}.`,
    );
  }

  return loan;
}

/**
 * Split an amount across what a loan owes.
 *
 * **The single implementation**, in the domain. The preview endpoint and the
 * write path both reach it through here. The system this replaces computed this
 * split twice — in the Edge Function that recorded the payment and again in the
 * browser to preview it — and its own technical document warned the preview
 * would lie if the two drifted.
 *
 * The order is `DOCUMENTED_ALLOCATION_ORDER`: interest, then principal. Those
 * are the only two things a payment can currently be applied to, so the order
 * is documented rather than chosen. Where penalties and fees belong once they
 * exist is an open question (01-ARCHITECTURE.md §13.2), which is why the
 * allocator takes the order as a parameter rather than assuming one.
 */
function allocate(loan: LoanBalance, amount: string): DomainAllocation {
  return allocatePayment({
    amountPaid: Money.fromDatabaseValue(amount),
    outstanding: {
      interest: Money.fromDatabaseValue(loan.interestOutstanding),
      principal: Money.fromDatabaseValue(loan.outstandingBalance),
    },
    order: DOCUMENTED_ALLOCATION_ORDER,
  });
}

function toWireAllocation(allocation: DomainAllocation): PaymentAllocation {
  return {
    penalty: amountApplied(allocation, 'penalty').toDatabaseValue(),
    fee: amountApplied(allocation, 'fee').toDatabaseValue(),
    interest: amountApplied(allocation, 'interest').toDatabaseValue(),
    principal: amountApplied(allocation, 'principal').toDatabaseValue(),
    unallocated: allocation.unallocated.toDatabaseValue(),
  };
}

/**
 * Show how an amount would be applied, without recording it.
 *
 * The endpoint that keeps the cashier's screen out of the arithmetic: what a
 * borrower is told at the counter comes from the same function that will write
 * the row.
 */
export async function previewAllocation(
  principal: Principal,
  loanId: string,
  request: PreviewAllocationRequest,
  payments: PaymentRepository,
): Promise<AllocationPreview> {
  const loan = await loadPayableLoan(principal, loanId, payments);
  const allocation = allocate(loan, request.amountPaid);

  const before = Money.fromDatabaseValue(loan.outstandingBalance);

  return {
    amountPaid: request.amountPaid,
    allocation: toWireAllocation(allocation),
    balanceBefore: before.toDatabaseValue(),
    balanceAfter: balanceAfter(before, allocation).toDatabaseValue(),
  };
}

export async function recordPayment(
  principal: Principal,
  loanId: string,
  request: RecordPaymentRequest,
  payments: PaymentRepository,
): Promise<Payment> {
  const loan = await loadPayableLoan(principal, loanId, payments);

  const today = new Date().toISOString().slice(0, 10);
  const datePaid = request.datePaid ?? today;

  if (datePaid > today) {
    // Backdating is ordinary — cash taken on Friday, keyed on Monday. A future
    // date is not: it would put a receipt on a BOT return for a quarter that
    // has not happened.
    throw ruleViolation('A payment cannot be dated in the future.');
  }

  const allocation = allocate(loan, request.amountPaid);
  const before = Money.fromDatabaseValue(loan.outstandingBalance);
  const after = balanceAfter(before, allocation);
  const wire = toWireAllocation(allocation);

  return payments.record(principal.institutionId, principal.userId, {
    loanId,
    amountPaid: request.amountPaid,
    penalty: wire.penalty,
    fee: wire.fee,
    interest: wire.interest,
    principal: wire.principal,
    unallocated: wire.unallocated,
    balanceBefore: before.toDatabaseValue(),
    balanceAfter: after.toDatabaseValue(),
    datePaid,
    notes: request.notes ?? null,
  });
}

/**
 * Undo a payment by recording its exact negation.
 *
 * Never an edit. The application holds INSERT and SELECT on `payments` and
 * nothing else, so the mistake and its correction both stay visible — which is
 * what an auditor needs and what the previous system lost by making payments
 * immutable and then never building the correction.
 */
export async function reversePayment(
  principal: Principal,
  paymentId: string,
  request: ReversePaymentRequest,
  payments: PaymentRepository,
): Promise<Payment> {
  const original = await payments.find(principal.institutionId, principal.userId, paymentId);

  if (original === null) {
    throw notFound('No such payment.');
  }

  if (original.reversesPaymentId !== null) {
    // Reversing a reversal would make the loan's balance depend on the order
    // rows are read. A unique index refuses it beneath this too.
    throw ruleViolation('A reversal cannot itself be reversed.');
  }

  if (original.reversedByPaymentId !== null) {
    throw ruleViolation('This payment has already been reversed.');
  }

  const loan = await payments.loanBalance(
    principal.institutionId,
    principal.userId,
    original.loanId,
  );
  if (loan === null || !canActOnBranch(principal, loan.branchId)) {
    throw forbidden('You can only reverse payments on loans in your own branch.');
  }

  if (loan.status === 'completed') {
    // Refused deliberately, rather than reopened.
    //
    // `completed` is terminal in the status machine — in the domain's
    // transition table and in a database trigger, both from stage 8. Reversing
    // the payment that settled a loan would have to move it back to `active`,
    // and nothing in the supplied documentation says whether that is permitted,
    // who may do it, or what happens to a loan already reported as closed on a
    // filed BOT return.
    //
    // A bounced settlement cheque is a real event, so this needs an answer —
    // recorded as an open question in 01-ARCHITECTURE.md §13.9. Until there is
    // one, the refusal names the situation instead of the alternatives:
    // inventing a transition the domain explicitly forbids, or letting the
    // trigger reject it with an error that explains nothing.
    throw ruleViolation(
      'This loan is closed, and reversing the payment that settled it would reopen a ' +
        'completed loan. That needs a documented rule about reopening — ask your ' +
        'administrator to record a separate correction instead.',
    );
  }

  const reversed = await payments.reverse(principal.institutionId, principal.userId, {
    originalPaymentId: paymentId,
    reason: request.reason,
    datePaid: new Date().toISOString().slice(0, 10),
  });

  if (reversed === null) {
    throw notFound('No such payment.');
  }

  return reversed;
}
