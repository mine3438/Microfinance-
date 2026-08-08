import { DomainValidationError } from '../errors.js';

/**
 * The states a loan moves through.
 *
 * The previous system had three — active, completed, written_off — and a loan
 * simply appeared as `active` the moment an officer created it. There was no
 * point at which anyone approved it, which is what PRD §4.2 records as
 * "maker-checker: cut".
 */
export const LOAN_STATUSES = [
  /** Being prepared. Terms may still change. */
  'draft',
  /** Submitted for a decision. Terms are frozen. */
  'pending_approval',
  /** Approved, awaiting disbursement. No money has moved. */
  'approved',
  /** Declined. */
  'rejected',
  /** Disbursed and outstanding. The schedule exists from this point. */
  'active',
  /** Repaid in full. */
  'completed',
  /** Recognised as irrecoverable. */
  'written_off',
] as const;

export type LoanStatus = (typeof LOAN_STATUSES)[number];

/**
 * Permitted transitions, as data rather than as branches.
 *
 * A table can be read, tested exhaustively, and compared against the database's
 * own CHECK constraint. A chain of conditionals spread through a service can be
 * none of those things.
 *
 * **Rejection is terminal here.** Whether a declined application may be
 * reworked and resubmitted is unanswered — `01-ARCHITECTURE.md` §13.3 asks it
 * and has no reply. Terminal is the safer reading: the rejection stays on the
 * record, and re-applying creates a fresh application with its own approval
 * trail, rather than mutating the one that was refused. If the institution
 * wants rework, adding `rejected → draft` here is a one-line change plus a
 * migration.
 */
export const LOAN_TRANSITIONS: Readonly<Record<LoanStatus, readonly LoanStatus[]>> = Object.freeze({
  draft: ['pending_approval'],
  pending_approval: ['approved', 'rejected'],
  approved: ['active'],
  rejected: [],
  active: ['completed', 'written_off'],
  completed: [],
  written_off: [],
});

/** Statuses from which nothing further follows. */
export const TERMINAL_LOAN_STATUSES: readonly LoanStatus[] = Object.freeze(
  LOAN_STATUSES.filter((status) => LOAN_TRANSITIONS[status].length === 0),
);

/** Narrow an arbitrary string to a known status. */
export function isLoanStatus(value: string): value is LoanStatus {
  return (LOAN_STATUSES as readonly string[]).includes(value);
}

/** Whether a loan may move from one status to another. */
export function canTransition(from: LoanStatus, to: LoanStatus): boolean {
  return LOAN_TRANSITIONS[from].includes(to);
}

/**
 * Assert a transition is permitted.
 *
 * @throws {DomainValidationError} naming what was legal instead, so the caller
 * does not have to consult the table to understand the refusal.
 */
export function assertTransition(from: LoanStatus, to: LoanStatus): void {
  if (canTransition(from, to)) {
    return;
  }

  const allowed = LOAN_TRANSITIONS[from];
  const options =
    allowed.length === 0
      ? `${from} is terminal — nothing follows it`
      : `from ${from} a loan may only become ${allowed.join(' or ')}`;

  throw new DomainValidationError(`A loan cannot move from ${from} to ${to}: ${options}.`);
}

/** Whether money has been advanced against this loan. */
export function isDisbursed(status: LoanStatus): boolean {
  return status === 'active' || status === 'completed' || status === 'written_off';
}

/**
 * Whether a loan in this status counts toward the outstanding portfolio.
 *
 * Only `active` does. MSP2-01's loans-to-clients line and MSP2-03's sectoral
 * classification both report what is still owed, so an approved-but-undisbursed
 * loan must not appear — no money has left the institution.
 */
export function isOutstanding(status: LoanStatus): boolean {
  return status === 'active';
}
