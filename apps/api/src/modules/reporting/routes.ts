import { compileReturnQuerySchema, compiledReturnSchema } from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { presentCompiledReturn } from './presentation.js';
import { type ReportRepository } from './report-repository.js';
import { compileQuarterlyReturn } from './use-cases.js';

/**
 * The period, taken from the path.
 *
 * Coerced from the path segments rather than read as numbers, because a path is
 * always text. `reportingPeriod` in the domain re-checks both — this schema
 * exists so a caller asking for `/reports/msp2/never/9` is told which segment is
 * wrong, instead of receiving the domain's message about a value it never saw.
 */
const periodParamsSchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(9999),
    quarter: z.coerce.number().int().min(1).max(4),
  })
  .strict();

export interface ReportRouteOptions {
  readonly reports: ReportRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

/**
 * Reporting routes.
 *
 * One endpoint, and it is a `GET` that computes rather than reads. Compiling a
 * return has no effect on anything stored: it is a question about the loan book
 * as at a date, and asking it twice gives the same answer. Making it a `POST`
 * would suggest otherwise and would put a compliance query outside the reach of
 * a bookmark or a link.
 *
 * `report.generate` rather than `report.read`, because the two are different
 * authorities. Reading a return that somebody compiled is a clerk's job;
 * producing the figures an institution files with its regulator is not.
 */
export function registerReportRoutes(app: FastifyInstance, options: ReportRouteOptions): void {
  const { reports, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  app.get(
    '/reports/msp2/:year/:quarter',
    { preHandler: [authenticated, requirePermission('report.generate')] },
    async (request: FastifyRequest): Promise<unknown> => {
      const params = periodParamsSchema.safeParse(request.params);
      if (!params.success) {
        throw validationFailed(params.error, 'That is not a quarter that can be reported.');
      }

      const query = compileReturnQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(
          query.error,
          'That annualisation convention is not one this system applies.',
        );
      }

      const compiled = await compileQuarterlyReturn(
        principalOf(request),
        {
          year: params.data.year,
          quarter: params.data.quarter,
          ...(query.data.annualisation === undefined
            ? {}
            : { annualisation: query.data.annualisation }),
        },
        reports,
        now,
      );

      // Parsed on the way out, not merely cast. A figure that fails its own
      // response schema — a negative percentage, an amount with three decimal
      // places — is a defect in the compilation, and the one place it can still
      // be caught before it becomes a filing is here.
      return compiledReturnSchema.parse(presentCompiledReturn(compiled));
    },
  );
}
