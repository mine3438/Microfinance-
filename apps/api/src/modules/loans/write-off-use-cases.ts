import {
  type LoanRecovery,
  type LoanWriteOff,
  type RecordRecoveryRequest,
  type WriteOffLoanRequest,
} from '@mfi/contracts';
import { canActOnBranch, type Principal } from '@mfi/identity';

import { conflict, notFound, ruleViolation } from '../../http/errors.js';
import { type WriteOffRepository } from './write-off-repository.js';

/**
 * Writing a loan off, and recovering against one.
 *
 * The approved rules, and what enforces each:
 *
 * - **No automatic write-off.** There is no days-past-due threshold and no
 *   scheduled job anywhere in this module. The only entry point is an endpoint a
 *   person calls. Classification and arrears are shown elsewhere to inform the
 *   judgement; nothing here consults them, because consulting them is the first
 *   step towards deciding on the institution's behalf.
 * - **Only the Owner/Manager.** `loan.write_off` is held by `institution_admin`
 *   alone, which is this system's Owner/Manager. Enforced at the route, and
 *   again by the branch check below.
 * - **A reason is required**, by the contract and by a `CHECK` constraint.
 * - **A recovery is not a repayment.** It is refused unless the loan is written
 *   off, by this module and again by a database trigger.
 */

export async function writeOffLoan(
  principal: Principal,
  loanId: string,
  request: WriteOffLoanRequest,
  repository: WriteOffRepository,
): Promise<LoanWriteOff> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan.');
  }

  if (subject.alreadyWrittenOffAt !== null) {
    // Idempotent in the sense that matters: the second attempt changes nothing
    // and says so, rather than recording a second write-off of a zero balance.
    throw conflict('That loan has already been written off.');
  }

  if (subject.status !== 'active') {
    // Only a disbursed, live loan can be written off. Writing off an
    // application is writing off money that was never advanced, and writing off
    // a completed loan writes off nothing.
    throw ruleViolation(`Only an active loan can be written off; this one is ${subject.status}.`);
  }

  const written = await repository.writeOff(
    principal.institutionId,
    principal.userId,
    loanId,
    request.reason,
  );

  if (written === null) {
    // The conditional INSERT matched no row, which means the loan stopped being
    // active between the read above and the write. Refusing beats writing off a
    // loan whose state has moved underneath the decision.
    throw conflict('That loan changed while the write-off was being recorded. Try again.');
  }

  return written;
}

export async function getWriteOff(
  principal: Principal,
  loanId: string,
  repository: WriteOffRepository,
): Promise<LoanWriteOff> {
  const found = await repository.findWriteOff(principal.institutionId, principal.userId, loanId);

  if (found === null) {
    throw notFound('That loan has not been written off.');
  }

  return found;
}

export async function recordRecovery(
  principal: Principal,
  loanId: string,
  request: RecordRecoveryRequest,
  repository: WriteOffRepository,
  now: () => Date,
): Promise<LoanRecovery> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan.');
  }

  if (subject.status !== 'written_off') {
    // Money against a live loan is a repayment and belongs on the payment path,
    // where it moves a balance and consumes a schedule. Routing it here would
    // report it on MSP2-02's recovery line instead of as interest and
    // principal — the same cash under the wrong heading.
    throw ruleViolation(
      `A recovery can only be recorded against a written-off loan; this one is ${subject.status}. ` +
        'Money received against a live loan is a repayment.',
    );
  }

  const today = formatDateOnly(now());
  const recoveredOn = request.recoveredOn ?? today;

  if (recoveredOn > today) {
    // The same refusal a payment gets, for the same reason: a future-dated
    // receipt lands on a quarter that has not happened.
    throw ruleViolation('A recovery cannot be dated in the future.');
  }

  return repository.recordRecovery(principal.institutionId, principal.userId, {
    loanId,
    amount: request.amount,
    recoveredOn,
    method: request.method ?? null,
    reference: request.reference ?? null,
    notes: request.notes ?? null,
  });
}

export async function listRecoveries(
  principal: Principal,
  loanId: string,
  repository: WriteOffRepository,
): Promise<LoanRecovery[]> {
  return repository.listRecoveries(principal.institutionId, principal.userId, loanId);
}

/** Today, as a calendar date, in the server's zone. Matches the payment path. */
function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
