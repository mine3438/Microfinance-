import { can, type Principal } from '@mfi/identity';
import type { Money } from '@mfi/money';

/**
 * The most an approver may sanction.
 *
 * `null` means no authority at all, which is the default: an institution that
 * has not configured a limit for a role has not granted that role approval
 * authority. Failing closed matters here — the alternative reading, that an
 * unconfigured limit means unlimited, hands every role the power to approve any
 * amount the moment someone forgets to set one.
 *
 * The values themselves are not in this system to invent.
 * `01-ARCHITECTURE.md` §13.3 asks for them and has no answer, so thresholds are
 * institution configuration, seeded empty.
 */
export interface ApprovalAuthority {
  readonly maxPrincipal: Money | null;
}

/** Why an approval was refused. */
export type ApprovalRefusal =
  /** The approver does not hold `loan.approve`. */
  | 'lacks_permission'
  /** The approver created the application. */
  | 'self_approval'
  /** The approver holds authority, but not for an amount this large. */
  | 'exceeds_authority'
  /** The loan belongs to a branch outside the approver's scope. */
  | 'outside_branch';

/** The outcome of assessing whether someone may approve an application. */
export type ApprovalAssessment =
  | { readonly permitted: true }
  | { readonly permitted: false; readonly reason: ApprovalRefusal; readonly message: string };

export interface ApprovalRequest {
  readonly approver: Principal;
  /** Who created the application. */
  readonly submittedByUserId: string;
  /** Branch the loan belongs to. */
  readonly branchId: string;
  readonly principal: Money;
  readonly authority: ApprovalAuthority;
}

/**
 * Decide whether a principal may approve an application, and say why not.
 *
 * Returns a reason rather than a boolean because every one of these refusals
 * needs to reach someone: the officer who submitted it needs to know it is
 * waiting on a manager rather than stuck, and the audit trail needs to record
 * that an approval was attempted and declined, not merely that it did not
 * happen.
 *
 * The checks run in order of how fundamental they are, so the message names the
 * most basic problem rather than an incidental one.
 */
export function assessApproval(request: ApprovalRequest): ApprovalAssessment {
  const { approver, submittedByUserId, branchId, principal, authority } = request;

  if (!can(approver, 'loan.approve')) {
    return {
      permitted: false,
      reason: 'lacks_permission',
      message: 'This role does not hold approval authority.',
    };
  }

  // Segregation of duties. Checked before the amount, because no threshold
  // makes it acceptable for the maker to also be the checker — and an
  // administrator holding every permission is not exempt. The point of
  // maker-checker is that two people saw it, not that one was senior enough.
  if (approver.userId === submittedByUserId) {
    return {
      permitted: false,
      reason: 'self_approval',
      message: 'An application cannot be approved by the person who submitted it.',
    };
  }

  // A branch-scoped approver may only sanction lending in their own branch.
  // Row-level security scopes by institution, not by branch, so this is the
  // only layer enforcing the narrower boundary.
  if (approver.branchId !== null && approver.branchId !== branchId) {
    return {
      permitted: false,
      reason: 'outside_branch',
      message: 'This approver’s authority does not extend to the branch that made the loan.',
    };
  }

  if (authority.maxPrincipal === null) {
    return {
      permitted: false,
      reason: 'exceeds_authority',
      message:
        'No approval limit is configured for this role, so it may not sanction any amount. ' +
        'Set a limit in institution settings.',
    };
  }

  if (principal.greaterThan(authority.maxPrincipal)) {
    return {
      permitted: false,
      reason: 'exceeds_authority',
      message:
        `This approver may sanction up to ${authority.maxPrincipal.toDatabaseValue()}; ` +
        `the application is for ${principal.toDatabaseValue()}.`,
    };
  }

  return { permitted: true };
}
