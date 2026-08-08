/**
 * The permission and role catalogue, mirroring what migration `0005_identity.sql`
 * seeds.
 *
 * These live in `contracts` rather than in `identity` because they are wire
 * values: they travel in the access token and in the session response, and the
 * web client needs them to decide which routes to render. Holding them in
 * `identity` would mean either a browser bundle importing a package that loads
 * a native argon2 binding, or a second hand-maintained copy of the same
 * twenty-nine strings — and the second copy is the worse option, because a
 * client guarding on `report.generate` while the server checks
 * `reports.generate` fails open on the screen and closed at the API, which
 * presents to a user as a button that does nothing.
 *
 * `@mfi/identity` re-exports these, so nothing downstream had to change. The
 * database remains the authority; a test in `@mfi/db` reads the seeded
 * catalogue and fails if this list ever diverges from it.
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
