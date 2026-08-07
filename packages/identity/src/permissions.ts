/**
 * The permission catalogue, mirroring what migration `0005_identity.sql` seeds.
 *
 * Held as a typed constant so a permission check is a compile-time error when
 * misspelled, rather than a silent `false` at runtime — a denied permission
 * that should have been granted looks exactly like correct authorisation, and
 * a granted one that should have been denied is a security hole.
 *
 * The database is the authority; this is a typed view of it. A test in
 * `@mfi/db` reads the seeded catalogue and fails if the two ever diverge, so
 * this cannot quietly drift out of date.
 */
export const PERMISSIONS = [
  'client.read',
  'client.create',
  'client.update',
  'client.deactivate',
  'branch.read',
  'branch.manage',
  'user.read',
  'user.invite',
  'user.manage',
  'loan.read',
  'loan.create',
  'loan.approve',
  'loan.disburse',
  'loan.write_off',
  'payment.read',
  'payment.create',
  'payment.reverse',
  'savings.read',
  'savings.manage',
  'share.read',
  'share.manage',
  'expense.read',
  'expense.manage',
  'complaint.read',
  'complaint.manage',
  'report.read',
  'report.generate',
  'settings.manage',
  'audit.read',
] as const;

/** One of the permissions the application recognises. */
export type Permission = (typeof PERMISSIONS)[number];

/** Roles seeded by migration `0005_identity.sql`. */
export const ROLES = [
  'institution_admin',
  'branch_manager',
  'loan_officer',
  'accountant',
  'auditor',
] as const;

/** One of the seeded roles. */
export type RoleCode = (typeof ROLES)[number];

/** Whether a role's authority covers a whole institution or a single branch. */
export type RoleScope = 'institution' | 'branch';

/** Narrow an arbitrary string to a known permission. */
export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/** Narrow an arbitrary string to a known role. */
export function isRoleCode(value: string): value is RoleCode {
  return (ROLES as readonly string[]).includes(value);
}

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
