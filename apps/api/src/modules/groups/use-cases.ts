import {
  type AddGroupMemberRequest,
  type CreateGroupRequest,
  type EndGroupMembershipRequest,
  type Group,
  type GroupMember,
  type UpdateGroupRequest,
} from '@mfi/contracts';
import { canActOnBranch, type Principal } from '@mfi/identity';

import { conflict, forbidden, notFound, ruleViolation } from '../../http/errors.js';
import { type GroupRepository } from './group-repository.js';

/**
 * Lending groups, and membership over time.
 *
 * Guarded by the borrower permissions rather than a new `group.*` set. A group
 * is a borrower-side record, and inventing permissions would mean inventing
 * which roles hold them — a policy decision nobody has made. Reusing
 * `client.read`, `client.create` and `client.update` gives exactly the people
 * who may register and amend borrowers the ability to do the same for groups,
 * which is the answer that requires no new policy.
 *
 * There is deliberately no way to lend to a group here. GROUP-05 records why:
 * every MSP2 exposure query reaches borrower attributes through
 * `loans.client_id`, and a group has no single sector, gender, age or district.
 */

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function listGroups(principal: Principal, groups: GroupRepository): Promise<Group[]> {
  // A branch-scoped user sees their own branch's groups, the same way they see
  // their own branch's borrowers.
  return groups.list(principal.institutionId, principal.userId, principal.branchId);
}

export async function getGroup(
  principal: Principal,
  groupId: string,
  groups: GroupRepository,
): Promise<Group> {
  const found = await groups.find(principal.institutionId, principal.userId, groupId);

  if (found === null || !canActOnBranch(principal, found.branchId)) {
    throw notFound('No such group.');
  }

  return found;
}

/**
 * Which branch a group belongs to.
 *
 * The borrower form's rule, applied unchanged: a branch-scoped user has it
 * filled in and is refused if they name a different one; an institution-wide
 * user must say.
 */
function resolveBranch(principal: Principal, requested: string | undefined): string {
  if (principal.branchId !== null) {
    if (requested !== undefined && requested !== principal.branchId) {
      throw forbidden('You can only create groups in your own branch.');
    }
    return principal.branchId;
  }

  if (requested === undefined) {
    throw ruleViolation('Name the branch that will administer this group.');
  }

  return requested;
}

export async function createGroup(
  principal: Principal,
  request: CreateGroupRequest,
  groups: GroupRepository,
  now: () => Date,
): Promise<Group> {
  const branchId = resolveBranch(principal, request.branchId);

  if (request.formedOn > formatDateOnly(now())) {
    throw ruleViolation('A group cannot have been formed in the future.');
  }

  return groups.create(principal.institutionId, principal.userId, {
    code: request.code,
    name: request.name,
    branchId,
    formedOn: request.formedOn,
  });
}

export async function updateGroup(
  principal: Principal,
  groupId: string,
  request: UpdateGroupRequest,
  groups: GroupRepository,
): Promise<Group> {
  // Read first, so a group in another branch is refused as absent rather than
  // amended.
  await getGroup(principal, groupId, groups);

  const updated = await groups.update(principal.institutionId, principal.userId, groupId, {
    ...(request.name === undefined ? {} : { name: request.name }),
    ...(request.status === undefined ? {} : { status: request.status }),
  });

  if (updated === null) {
    throw notFound('No such group.');
  }

  return updated;
}

export async function listMembers(
  principal: Principal,
  groupId: string,
  asAt: string | undefined,
  groups: GroupRepository,
): Promise<GroupMember[]> {
  await getGroup(principal, groupId, groups);

  return groups.members(principal.institutionId, principal.userId, groupId, asAt ?? null);
}

export async function addMember(
  principal: Principal,
  groupId: string,
  request: AddGroupMemberRequest,
  groups: GroupRepository,
  now: () => Date,
): Promise<GroupMember> {
  const group = await getGroup(principal, groupId, groups);

  if (group.status !== 'active') {
    throw ruleViolation('That group is closed, so members cannot be added to it.');
  }

  const exists = await groups.clientExists(
    principal.institutionId,
    principal.userId,
    request.clientId,
  );
  if (!exists) {
    // Reported as a rule violation naming the field rather than a bare 404,
    // because the group was found and the *borrower* was not.
    throw ruleViolation('That borrower is not registered at this institution.');
  }

  const today = formatDateOnly(now());
  const joinedOn = request.joinedOn ?? today;

  if (joinedOn > today) {
    throw ruleViolation('A member cannot join in the future.');
  }
  if (joinedOn < group.formedOn) {
    throw ruleViolation('A member cannot join before the group was formed.');
  }

  const added = await groups.addMember(
    principal.institutionId,
    principal.userId,
    groupId,
    request.clientId,
    joinedOn,
  );

  if (added === null) {
    throw conflict('That borrower is already a member of this group.');
  }

  return added;
}

export async function endMembership(
  principal: Principal,
  groupId: string,
  clientId: string,
  request: EndGroupMembershipRequest,
  groups: GroupRepository,
  now: () => Date,
): Promise<GroupMember> {
  await getGroup(principal, groupId, groups);

  const today = formatDateOnly(now());
  const leftOn = request.leftOn ?? today;

  if (leftOn > today) {
    throw ruleViolation('A member cannot leave in the future.');
  }

  const ended = await groups.endMembership(
    principal.institutionId,
    principal.userId,
    groupId,
    clientId,
    leftOn,
  );

  if (ended === null) {
    // Either they were never a member, or they have already left. Both are the
    // same to a caller trying to close an interval that is not open.
    throw conflict('That borrower is not currently a member of this group.');
  }

  return ended;
}
