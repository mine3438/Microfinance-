/**
 * Postgres access for MFI Manager.
 *
 * Two guarantees this layer exists to hold, both of which fail silently if left
 * to convention:
 *
 * - **Tenancy.** Every tenant-scoped unit of work opens a transaction that
 *   adopts the least-privilege application role and sets the session value that
 *   row-level security policies read. Reaching outside a tenant requires a
 *   differently-named method, so it is visible in review rather than being the
 *   result of a forgotten argument.
 * - **Exact numerics.** The driver must return `NUMERIC` as a string, because
 *   `@mfi/money` builds amounts from strings and refuses floats. This is
 *   asserted when a {@link Database} is constructed, since a misconfiguration
 *   is undetectable afterwards.
 */

export {
  ACTING_USER_SETTING,
  Database,
  DEFAULT_APPLICATION_ROLE,
  TENANT_SETTING,
} from './database.js';
export type { DatabaseOptions, TransactionClient, TransactionWork } from './database.js';

export { assertExactNumericsAreSafe, TYPE_OIDS } from './driver-safety.js';

export {
  DatabaseError,
  MissingTenantContextError,
  SchemaVersionError,
  UnsafeDriverConfigurationError,
} from './errors.js';

export { assertValidTenantContext } from './tenant-context.js';
export type { TenantContext } from './tenant-context.js';
