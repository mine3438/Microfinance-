import {
  auditEntryDetailSchema,
  auditEntrySchema,
  auditListQuerySchema,
  auditedTableSchema,
  pageSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type AuditRepository } from './audit-repository.js';
import { getAuditEntry, listAuditEntries, listAuditedTables } from './use-cases.js';

const auditPageSchema = pageSchema(auditEntrySchema);
const auditedTableListSchema = z.array(auditedTableSchema);

export interface AuditRouteOptions {
  readonly audit: AuditRepository;
  readonly tokens: AccessTokenService;
}

function idOf(request: FastifyRequest, key: string, subject: string): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)[key]);
  if (!parsed.success) {
    throw validationFailed(parsed.error, `That is not a ${subject} identifier.`);
  }
  return parsed.data;
}

/**
 * Audit routes.
 *
 * Three reads and no writes, which is the whole surface the trail should have.
 * There is no `POST /audit` for an application-recorded event and no
 * `DELETE /audit/:id` for tidying one away — the first would let a caller write
 * history it chose, and the second would make the trail evidence of nothing.
 * Neither is merely unimplemented: `mfi_app` holds no privilege that would let
 * either work.
 *
 * Every route is guarded by `audit.read`, and the guard is the outer of two.
 * The row-level policy on `audit_logs` checks the same permission, so a
 * mistake here — a route registered without its guard, a permission renamed on
 * one side only — returns an empty page rather than an institution's history.
 */
export function registerAuditRoutes(app: FastifyInstance, options: AuditRouteOptions): void {
  const { audit, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/audit',
    { preHandler: [authenticated, requirePermission('audit.read')] },
    async (request): Promise<unknown> => {
      const query = auditListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those list options are not valid.');
      }

      return auditPageSchema.parse(await listAuditEntries(principalOf(request), query.data, audit));
    },
  );

  /**
   * The tables the trail covers.
   *
   * Serves the filter on the audit screen. Offering the list is what makes the
   * filter a choice rather than a typed guess — the same reason the borrower
   * form picks a district from a list instead of accepting free text.
   */
  app.get(
    '/audit/tables',
    { preHandler: [authenticated, requirePermission('audit.read')] },
    async (request): Promise<unknown> =>
      auditedTableListSchema.parse(await listAuditedTables(principalOf(request), audit)),
  );

  /**
   * One change, with the row either side of it.
   *
   * Registered after `/audit/tables` for legibility only; Fastify's router
   * prefers the static segment over the parameter regardless of order.
   */
  app.get(
    '/audit/:id',
    { preHandler: [authenticated, requirePermission('audit.read')] },
    async (request): Promise<unknown> =>
      auditEntryDetailSchema.parse(
        await getAuditEntry(principalOf(request), idOf(request, 'id', 'audit entry'), audit),
      ),
  );
}
