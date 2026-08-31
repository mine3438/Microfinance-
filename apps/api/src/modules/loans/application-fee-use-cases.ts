import {
  APPLICATION_FEE_AMOUNT,
  type ApplicationFee,
  type CollectApplicationFeeRequest,
  type RefundApplicationFeeRequest,
} from '@mfi/contracts';
import { canActOnBranch, type Principal } from '@mfi/identity';

import { conflict, notFound, ruleViolation } from '../../http/errors.js';
import { type ApplicationFeeRepository } from './application-fee-repository.js';

/**
 * Collecting and refunding the application/form fee.
 *
 * The approved rules: TZS 5,000, cash, at application. Retained if the
 * application is approved; refunded if it is rejected. The collection record
 * survives the refund.
 *
 * What this module deliberately does **not** do is as important as what it
 * does. It never touches a balance, a schedule or a payment. The fee is not
 * deducted from disbursement, not added to principal, not interest-bearing, and
 * cannot reach the repayment allocator — whose fee bucket keeps its fixed
 * position and still allocates nil.
 */

export async function collectApplicationFee(
  principal: Principal,
  loanId: string,
  request: CollectApplicationFeeRequest,
  repository: ApplicationFeeRepository,
  now: () => Date,
): Promise<ApplicationFee> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan application.');
  }

  if (subject.fee !== null) {
    // One fee per set of forms, enforced here for the message and by a unique
    // index for the guarantee.
    throw conflict('The application fee for that application has already been collected.');
  }

  if (!['draft', 'pending_approval'].includes(subject.status)) {
    // The charge is for submitting the forms. Taking it after a decision has
    // been made would be charging for an application that is already resolved.
    throw ruleViolation(
      `The application fee is collected while the application is being made; this one is ${subject.status}.`,
    );
  }

  const today = formatDateOnly(now());
  const collectedOn = request.collectedOn ?? today;

  if (collectedOn > today) {
    throw ruleViolation('An application fee cannot be dated in the future.');
  }

  const collected = await repository.collect(principal.institutionId, principal.userId, {
    loanId,
    // Never taken from the request. The charge is fixed policy, so a caller
    // stating it would let a counter typo become the fee.
    amount: APPLICATION_FEE_AMOUNT,
    collectedOn,
    method: request.method ?? null,
    reference: request.reference ?? null,
  });

  if (collected === null) {
    throw notFound('No such loan application.');
  }

  return collected;
}

export async function getApplicationFee(
  principal: Principal,
  loanId: string,
  repository: ApplicationFeeRepository,
): Promise<ApplicationFee> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan application.');
  }

  if (subject.fee === null) {
    throw notFound('No application fee has been collected for that application.');
  }

  return subject.fee;
}

/**
 * Hand the fee back after a rejected application.
 *
 * The eligibility test is the one place this module had to reason carefully.
 * The approved rule says the fee is refunded when the application is
 * **rejected** — but in this system rejection is not a resting state: the
 * decision path moves the loan through `rejected` and on to `draft` in one
 * transaction, so the officer can revise and resubmit (migration 0023).
 *
 * So a refund is permitted when a rejection has been recorded **and** the
 * application is still sitting as a draft. Once it is resubmitted it is live
 * again and the fee belongs to it; handing money back on an application that is
 * proceeding would be the more expensive mistake, so that case is refused.
 *
 * Whether the institution intends a refund the moment a decision is "reject",
 * even where the officer will revise and resubmit, is a timing question nobody
 * has answered. Nothing here issues a refund automatically — it records one a
 * person has made.
 */
export async function refundApplicationFee(
  principal: Principal,
  loanId: string,
  request: RefundApplicationFeeRequest,
  repository: ApplicationFeeRepository,
  now: () => Date,
): Promise<ApplicationFee> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan application.');
  }

  const fee = subject.fee;
  if (fee === null) {
    throw notFound('No application fee has been collected for that application.');
  }

  if (fee.state === 'refunded') {
    throw conflict('That application fee has already been refunded.');
  }

  if (fee.state !== 'refund_due') {
    throw ruleViolation(
      'The application fee is refunded when an application is rejected. This one is ' +
        `${fee.state === 'retained' ? 'on an application that was approved' : 'still under consideration'}.`,
    );
  }

  const today = formatDateOnly(now());
  const refundedOn = request.refundedOn ?? today;

  if (refundedOn > today) {
    throw ruleViolation('A refund cannot be dated in the future.');
  }

  if (refundedOn < fee.collectedOn) {
    throw ruleViolation('A refund cannot be dated before the fee was collected.');
  }

  const refunded = await repository.refund(
    principal.institutionId,
    principal.userId,
    loanId,
    refundedOn,
    request.reason ?? null,
  );

  if (refunded === null) {
    // The conditional UPDATE matched nothing, so another request refunded it
    // between the read and the write.
    throw conflict('That application fee has already been refunded.');
  }

  return refunded;
}

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
