/**
 * Identity primitives: password hashing, token handling, and the permission model.
 *
 * Deliberately free of storage and transport. Everything here is a pure
 * function over values, so the security-critical logic — how a password is
 * hashed, how a token is compared, who may approve whose work — can be tested
 * exhaustively without a database, an HTTP server, or a running clock.
 */

export {
  ARGON2_PARAMETERS,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  assertPasswordPolicy,
  dummyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

export {
  TOKEN_BYTES,
  TOKEN_LIFETIMES,
  generateToken,
  hashToken,
  isExpired,
  issueToken,
  tokenMatchesHash,
} from './tokens.js';
export type { IssuedToken } from './tokens.js';

export {
  PERMISSIONS,
  ROLES,
  can,
  canActOnBranch,
  canAll,
  canAny,
  canApproveWorkOf,
  canGrantRole,
  isPermission,
  isRoleCode,
} from './permissions.js';
export type { Permission, Principal, RoleCode, RoleScope } from './permissions.js';

export { IdentityError, TokenReuseDetectedError, WeakPasswordError } from './errors.js';
