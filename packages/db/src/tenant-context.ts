import { MissingTenantContextError } from './errors.js';

/**
 * Canonical UUID form, any version.
 *
 * Validated before the value reaches `set_config`, so a malformed identifier
 * fails with a message naming the problem rather than a Postgres cast error
 * from inside a policy evaluation.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which institution a unit of work is acting for.
 *
 * Resolved from the authenticated principal at the edge of the application and
 * carried inward. Nothing below the API layer is permitted to infer it from a
 * request parameter — that would make tenancy a function of user input.
 */
export interface TenantContext {
  /** Institution the work belongs to. */
  readonly institutionId: string;
}

/**
 * Validate a tenant context before it is used to scope a transaction.
 *
 * Row-level security already fails closed when the context is missing, so an
 * unscoped query returns nothing rather than everything. But "no rows" is
 * indistinguishable from "this institution has no clients yet", which is the
 * silent-failure mode the analysis records as R4 — a perfectly functional UI
 * showing an empty database. Throwing here converts it into an error someone
 * can act on.
 *
 * @throws {MissingTenantContextError} if the context is absent or malformed.
 */
export function assertValidTenantContext(context: TenantContext | undefined): TenantContext {
  if (context === undefined) {
    throw new MissingTenantContextError(
      'A tenant-scoped operation was attempted with no tenant context. ' +
        'Resolve the institution from the authenticated principal before opening the transaction.',
    );
  }

  const { institutionId } = context;

  if (typeof institutionId !== 'string' || institutionId.trim() === '') {
    throw new MissingTenantContextError(
      'Tenant context carries no institutionId. Row-level security would return ' +
        'an empty result set, which is indistinguishable from an institution with no data.',
    );
  }

  if (!UUID_PATTERN.test(institutionId)) {
    throw new MissingTenantContextError(
      `Tenant context institutionId "${institutionId}" is not a UUID.`,
    );
  }

  return context;
}
