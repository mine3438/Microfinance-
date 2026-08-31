import {
  type AcceptInvitationRequest,
  type CreateInvitationRequest,
  type CreatedInvitation,
  type Invitation,
  type InvitationPreview,
  type StaffMember,
  type UpdateStaffRequest,
} from '@mfi/contracts';
import { TOKEN_LIFETIMES, canGrantRole, hashPassword, hashToken, issueToken } from '@mfi/identity';
import { type Principal } from '@mfi/identity';

import { conflict, forbidden, notFound, ruleViolation } from '../../http/errors.js';
import {
  type InvitationDelivery,
  type InvitationMessage,
} from '../../notifications/invitation-delivery.js';
import { type UserRepository } from './user-repository.js';

/**
 * Staff management.
 *
 * Three authorisation rules run here, and each closes a distinct way an
 * invitation could otherwise be used to gain authority nobody granted:
 *
 * 1. **Tenant.** The institution is taken from the inviter's session and never
 *    from the request. There is no field a caller could set to invite into
 *    somebody else's institution, and row-level security would refuse the write
 *    even if there were.
 * 2. **Branch.** A branch-scoped inviter may only invite into their own branch,
 *    enforced with the same `canActOnBranch` every other module uses.
 * 3. **Escalation.** An inviter may only assign a role whose permissions are a
 *    subset of their own, checked against `reference.role_permissions` rather
 *    than against a list held in this codebase.
 *
 * The third is the one that is easy to leave out and expensive to leave out.
 * Without it, anybody holding `user.invite` could mint an `institution_admin`
 * and sign in as it — which makes `user.invite` silently equal to every
 * permission in the catalogue.
 */

/** How long an invitation stays redeemable. Seven days, from `TOKEN_LIFETIMES`. */
export const INVITATION_LIFETIME_SECONDS = TOKEN_LIFETIMES.invitation;

export interface InvitationDependencies {
  readonly users: UserRepository;
  readonly delivery: InvitationDelivery;
  /** Base URL of the web app, for building the acceptance link. */
  readonly webBaseUrl: string;
  readonly now: () => Date;
}

export async function listStaff(
  principal: Principal,
  users: UserRepository,
): Promise<StaffMember[]> {
  return users.listStaff(principal.institutionId, principal.userId);
}

export async function listInvitations(
  principal: Principal,
  users: UserRepository,
  now: Date,
): Promise<Invitation[]> {
  return users.listInvitations(principal.institutionId, principal.userId, now);
}

/**
 * Which branch an invitation is for.
 *
 * The same rule the borrower form follows, and for the same reason: a
 * branch-scoped user has nothing to choose, so naming a different branch is a
 * mistake worth refusing rather than a preference worth honouring. An
 * institution-wide inviter states it, and `null` is a deliberate answer meaning
 * institution-wide authority.
 */
function resolveBranch(principal: Principal, requested: string | null | undefined): string | null {
  if (principal.branchId === null) {
    return requested ?? null;
  }

  if (requested !== undefined && requested !== null && requested !== principal.branchId) {
    throw forbidden('You can only invite staff into your own branch.');
  }

  return principal.branchId;
}

export async function inviteStaff(
  principal: Principal,
  request: CreateInvitationRequest,
  dependencies: InvitationDependencies,
): Promise<CreatedInvitation> {
  const { users, delivery, webBaseUrl, now } = dependencies;
  const at = now();

  const branchId = resolveBranch(principal, request.branchId);

  // Escalation check, before anything is written. The role's permissions come
  // from the database because that is what defines them; comparing against a
  // list compiled into this binary would pass whenever the two disagreed.
  const rolePermissions = await users.permissionsForRole(
    principal.institutionId,
    principal.userId,
    request.roleCode,
  );

  if (!canGrantRole(principal, rolePermissions)) {
    throw forbidden(
      `You cannot invite someone as ${request.roleCode}, because that role holds authority ` +
        'you do not. Ask an administrator whose own permissions cover it.',
    );
  }

  const existing = await users.findAccountByEmail(
    principal.institutionId,
    principal.userId,
    request.email,
  );

  if (existing !== null && existing.status !== 'invited') {
    throw conflict(
      'That email address already belongs to a member of staff here. Amend their account ' +
        'rather than inviting them again.',
    );
  }

  if (existing?.hasPassword === true) {
    // Invited, but with a password already set — an account mid-way through a
    // state this flow does not produce. Refusing beats overwriting a credential.
    throw conflict('That account already has a password set and cannot be re-invited.');
  }

  const token = issueToken(INVITATION_LIFETIME_SECONDS, at);

  const invitation = await users.createInvitation(
    principal.institutionId,
    principal.userId,
    {
      email: request.email,
      fullName: request.fullName,
      roleCode: request.roleCode,
      branchId,
      tokenHash: token.hash,
      expiresAt: token.expiresAt,
      invitedBy: principal.userId,
    },
    at,
  );

  // Read back for the institution's name, which the invitee needs in order to
  // know what they are being asked to join and which the principal does not
  // carry. Also the last chance to notice the write did not land.
  const subject = await users.loadInvitation(principal.institutionId, invitation.id);

  if (subject === null) {
    throw new Error('The invitation was created but could not be read back.');
  }

  const message: InvitationMessage = {
    email: invitation.email,
    fullName: invitation.fullName,
    institutionName: subject.institutionName,
    link: acceptanceLink(webBaseUrl, token.token),
    expiresAt: token.expiresAt,
  };

  const outcome = await delivery.deliver(message);

  return {
    invitation,
    delivery: outcome.mechanism,
    link: outcome.link,
  };
}

/**
 * Build the link an invitee follows.
 *
 * The token is a fragment-free query parameter on the web app's own origin. It
 * reaches this API only in a request body — the acceptance page reads it from
 * its own URL and posts it — so it is never in an API access log.
 */
export function acceptanceLink(webBaseUrl: string, token: string): string {
  const url = new URL('/accept-invitation', webBaseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

export async function revokeInvitation(
  principal: Principal,
  invitationId: string,
  users: UserRepository,
  now: Date,
): Promise<Invitation> {
  const revoked = await users.revokeInvitation(
    principal.institutionId,
    principal.userId,
    invitationId,
    now,
  );

  if (revoked === null) {
    // Either it does not exist, belongs to another institution, or is already
    // accepted or revoked. All four are reported the same way: a caller who
    // cannot see it should not learn which.
    throw notFound('No invitation is open under that reference.');
  }

  return revoked;
}

/** Why an invitation cannot be redeemed, in the words the invitee needs. */
const CANNOT_REDEEM = 'That invitation link is no longer valid. Ask for a new one.';

/**
 * Resolve a presented token to the invitation it names.
 *
 * Every refusal below uses the same message. Unlike login there is no
 * enumeration risk to manage — reaching this code at all requires a 256-bit
 * token — but the distinctions are not useful to the person holding a dead
 * link, and "expired" versus "revoked" tells whoever holds a *stolen* link
 * whether it was noticed.
 */
async function resolveInvitation(
  token: string,
  users: UserRepository,
  now: Date,
): Promise<{ institutionId: string; invitationId: string }> {
  const identity = await users.findInvitationByTokenHash(hashToken(token));

  if (identity === null) {
    throw notFound(CANNOT_REDEEM);
  }

  if (
    identity.acceptedAt !== null ||
    identity.revokedAt !== null ||
    identity.expiresAt.getTime() <= now.getTime()
  ) {
    throw ruleViolation(CANNOT_REDEEM);
  }

  if (identity.institutionStatus !== 'active') {
    throw ruleViolation(
      'The institution that invited you is not active. Contact its administrator.',
    );
  }

  return { institutionId: identity.institutionId, invitationId: identity.invitationId };
}

export async function previewInvitation(
  token: string,
  users: UserRepository,
  now: Date,
): Promise<InvitationPreview> {
  const { institutionId, invitationId } = await resolveInvitation(token, users, now);
  const subject = await users.loadInvitation(institutionId, invitationId);

  if (subject === null) {
    throw notFound(CANNOT_REDEEM);
  }

  return {
    institutionName: subject.institutionName,
    fullName: subject.fullName,
    email: subject.email,
    roleCode: subject.roleCode,
    branchName: subject.branchName,
    expiresAt: subject.expiresAt.toISOString(),
  };
}

export async function acceptInvitation(
  request: AcceptInvitationRequest,
  users: UserRepository,
  now: Date,
): Promise<void> {
  const { institutionId, invitationId } = await resolveInvitation(request.token, users, now);

  const passwordHash = await hashPassword(request.password);

  // The repository re-checks every gate inside the write. The check above is
  // for the message; this is for the guarantee — two requests carrying the same
  // token race here, and only one can consume it.
  const accepted = await users.acceptInvitation(institutionId, invitationId, passwordHash, now);

  if (!accepted) {
    throw ruleViolation(CANNOT_REDEEM);
  }
}

export async function updateStaff(
  principal: Principal,
  staffId: string,
  request: UpdateStaffRequest,
  users: UserRepository,
): Promise<StaffMember> {
  // Nobody amends their own account here.
  //
  // It stops the obvious lockout — an administrator suspending themselves — and
  // it is also what keeps an institution from losing its last administrator.
  // `user.manage` is held only by `institution_admin`, so every caller of this
  // endpoint is one; each can suspend the others but never themselves, which
  // leaves at least one active administrator no matter what order the calls
  // arrive in.
  if (staffId === principal.userId) {
    throw forbidden(
      'You cannot change your own account here. Ask another administrator at your institution.',
    );
  }

  const subject = await users.findStaff(principal.institutionId, principal.userId, staffId);

  if (subject === null) {
    throw notFound('No such member of staff.');
  }

  if (request.status === 'active' && subject.status === 'invited') {
    // `users_active_requires_password` would refuse this at the database, and
    // rightly: an account with no password that is marked active is an account
    // that cannot sign in but looks as though it can. Accepting the invitation
    // is what activates it.
    throw ruleViolation(
      'That person has not accepted their invitation yet, so their account cannot be ' +
        'activated from here.',
    );
  }

  if (request.branchId !== undefined && !canActOnBranchChange(principal, request.branchId)) {
    throw forbidden('You can only assign staff to your own branch.');
  }

  const updated = await users.updateStaff(principal.institutionId, principal.userId, staffId, {
    ...(request.status === undefined ? {} : { status: request.status }),
    ...(request.branchId === undefined ? {} : { branchId: request.branchId }),
  });

  if (updated === null) {
    throw notFound('No such member of staff.');
  }

  return updated;
}

/**
 * Whether a principal may move somebody to a branch.
 *
 * A branch-scoped administrator cannot move staff out of their own branch, and
 * cannot move them to institution-wide authority — which would be granting
 * reach the granter does not have, the same escalation the role check prevents
 * on the way in.
 */
function canActOnBranchChange(principal: Principal, branchId: string | null): boolean {
  if (principal.branchId === null) {
    return true;
  }
  return branchId === principal.branchId;
}
