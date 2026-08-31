import {
  PERMISSIONS,
  ROLES,
  isPermission,
  isRoleCode,
  type Permission,
  type RoleCode,
  type RoleScope,
} from '@mfi/contracts';

/**
 * The permission catalogue, re-exported from `@mfi/contracts`.
 *
 * The catalogue itself moved there when the API stage landed, because these
 * codes travel on the wire — in the access token and the session response — and
 * the web client needs them to decide which routes to render. A browser bundle
 * cannot import this package, which loads a native argon2 binding, so the list
 * had to live somewhere both sides can reach.
 *
 * Re-exported rather than relocated-and-forgotten so that every existing
 * consumer of `@mfi/identity` keeps working, and so that permission *checks*
 * stay here beside the authentication primitives they are used with. The
 * database remains the authority over both: a test in `@mfi/db` reads the
 * seeded catalogue and fails if this list ever diverges from it.
 */
export {
  PERMISSIONS,
  ROLES,
  isPermission,
  isRoleCode,
  type Permission,
  type RoleCode,
  type RoleScope,
};

/**
 * A principal's resolved authority for one request.
 *
 * Built at the authentication boundary and passed inward. Nothing below that
 * boundary re-derives it, and nothing infers it from a request parameter —
 * authorisation that depends on user input is not authorisation.
 */
export interface Principal {
  readonly userId: string;
  readonly institutionId: string;
  /** Branch the user is assigned to, or null for institution-wide authority. */
  readonly branchId: string | null;
  readonly roles: readonly RoleCode[];
  readonly permissions: ReadonlySet<Permission>;
}

/** Whether the principal holds a permission. */
export function can(principal: Principal, permission: Permission): boolean {
  return principal.permissions.has(permission);
}

/** Whether the principal holds every listed permission. */
export function canAll(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.every((permission) => principal.permissions.has(permission));
}

/** Whether the principal holds at least one of the listed permissions. */
export function canAny(principal: Principal, permissions: readonly Permission[]): boolean {
  return permissions.some((permission) => principal.permissions.has(permission));
}

/**
 * Whether the principal may act on data belonging to a branch.
 *
 * A principal with no branch has institution-wide authority; one assigned to a
 * branch is confined to it. Row-level security scopes by institution, not by
 * branch, so this is the layer that enforces the narrower boundary — which is
 * why it is a function with a name rather than an inline comparison repeated at
 * each call site.
 */
export function canActOnBranch(principal: Principal, branchId: string | null): boolean {
  if (principal.branchId === null) {
    return true;
  }
  return branchId === principal.branchId;
}

/**
 * Whether `approver` may approve something `maker` created.
 *
 * Segregation of duties. The check is here, in the domain, rather than in a
 * controller or a UI: an approval that only the interface prevents is not a
 * control, because the interface is not the only way in.
 */
export function canApproveWorkOf(approver: Principal, makerUserId: string): boolean {
  return approver.userId !== makerUserId && can(approver, 'loan.approve');
}

/**
 * Whether `granter` may assign a role carrying `rolePermissions`.
 *
 * The no-escalation invariant: you cannot give away authority you do not hold.
 * Granting a permission you lack would let a user promote themselves by proxy —
 * invite an account with more authority than their own, then use it.
 *
 * This is a security invariant rather than a business rule, which is why it is
 * decided here and not left to configuration. It is not a claim about who
 * *should* be able to invite whom; that follows entirely from the permission
 * catalogue, and an institution that changes which role holds `user.invite`
 * changes who can invite whom without anything here needing to know.
 *
 * The role's permissions are passed in rather than derived, because the
 * authority on what a role grants is `reference.role_permissions` in the
 * database. Copying that mapping into this package would be a second
 * definition, and the two could disagree — the precise failure the catalogue's
 * drift test exists to prevent.
 */
export function canGrantRole(granter: Principal, rolePermissions: readonly Permission[]): boolean {
  return rolePermissions.every((permission) => granter.permissions.has(permission));
}
