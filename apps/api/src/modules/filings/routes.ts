import {
  fileReturnRequestSchema,
  filedReturnDetailSchema,
  filedReturnSchema,
  recordSubmissionReferenceRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type ReportRepository } from '../reporting/report-repository.js';
import { type FilingRepository } from './filing-repository.js';
import { fileReturn, getFiling, listFilings, recordSubmissionReference } from './use-cases.js';

const filingListSchema = z.array(filedReturnSchema);

const periodParamsSchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(9999),
    quarter: z.coerce.number().int().min(1).max(4),
  })
  .strict();

export interface FilingRouteOptions {
  readonly filings: FilingRepository;
  readonly reports: ReportRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

function idOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)['id']);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a filing identifier.');
  }
  return parsed.data;
}

/**
 * Filing routes.
 *
 * `report.generate` files, because producing the figures an institution sends
 * its regulator is the same authority as compiling them. `report.read` reads
 * the archive, which a branch manager or an auditor may do without being able
 * to file anything.
 *
 * There is no `DELETE`, and the database grants no privilege for one. A filing
 * that can be removed is not a record of what was filed.
 */
export function registerFilingRoutes(app: FastifyInstance, options: FilingRouteOptions): void {
  const { filings, reports, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  /**
   * File a quarter.
   *
   * Compiles first, and refuses on a blocking validation finding — a return
   * BOT's validator would reject spends the submission window to learn what
   * this system already knew.
   */
  app.post(
    '/reports/msp2/:year/:quarter/filing',
    { preHandler: [authenticated, requirePermission('report.generate')] },
    async (request, reply): Promise<unknown> => {
      const params = periodParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw validationFailed(params.error, 'That is not a quarter that can be filed.');
      }

      const body = fileReturnRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        throw validationFailed(body.error, 'Those filing options are not valid.');
      }

      const filed = await fileReturn(
        principalOf(request),
        params.data.year,
        params.data.quarter,
        body.data,
        reports,
        filings,
        now,
      );

      void reply.status(201).header('location', `/filings/${filed.id}`);
      return filedReturnDetailSchema.parse(filed);
    },
  );

  app.get(
    '/filings',
    { preHandler: [authenticated, requirePermission('report.read')] },
    async (request): Promise<unknown> =>
      filingListSchema.parse(await listFilings(principalOf(request), filings)),
  );

  app.get(
    '/filings/:id',
    { preHandler: [authenticated, requirePermission('report.read')] },
    async (request): Promise<unknown> =>
      filedReturnDetailSchema.parse(await getFiling(principalOf(request), idOf(request), filings)),
  );

  /** Record BOT's acknowledgement. The only part of a filing that may change. */
  app.patch(
    '/filings/:id',
    { preHandler: [authenticated, requirePermission('report.generate')] },
    async (request): Promise<unknown> => {
      const body = recordSubmissionReferenceRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That acknowledgement cannot be recorded as entered.');
      }

      return filedReturnSchema.parse(
        await recordSubmissionReference(
          principalOf(request),
          idOf(request),
          body.data.submissionReference,
          filings,
        ),
      );
    },
  );
}
