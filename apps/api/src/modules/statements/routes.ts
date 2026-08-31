import {
  STATEMENT_FORMS,
  msp2_01Schema,
  msp2_05Schema,
  saveStatementLinesRequestSchema,
  type StatementForm,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type ReportRepository } from '../reporting/report-repository.js';
import { type StatementRepository } from './statement-repository.js';
import { saveStatementLines, viewStatement } from './use-cases.js';

/**
 * The quarterly statement dataset.
 *
 * Two forms and two verbs. A `GET` returns the form compiled — derived lines
 * filled in, totals rolled up — and a `PUT` saves figures and returns the same
 * thing, so a total that moved is visible without a second call.
 *
 * A `PUT` rather than a `POST` because there is one figure per line per
 * quarter: sending the same line twice replaces it, which is what preparing a
 * statement over several days actually involves.
 */
const paramsSchema = z
  .object({
    form: z.enum(STATEMENT_FORMS),
    year: z.coerce.number().int().min(2000).max(9999),
    quarter: z.coerce.number().int().min(1).max(4),
  })
  .strict();

const viewSchema = z
  .object({
    form: z.enum(STATEMENT_FORMS),
    year: z.number().int(),
    quarter: z.number().int(),
    msp2_01: msp2_01Schema.optional(),
    msp2_05: msp2_05Schema.optional(),
  })
  .strict();

export interface StatementRouteOptions {
  readonly statements: StatementRepository;
  readonly reports: ReportRepository;
  readonly tokens: AccessTokenService;
}

function periodOf(request: FastifyRequest): {
  form: StatementForm;
  year: number;
  quarter: number;
} {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a statement this system prepares.');
  }
  return parsed.data;
}

export function registerStatementRoutes(
  app: FastifyInstance,
  options: StatementRouteOptions,
): void {
  const { statements, reports, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/statements/:form/:year/:quarter',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> => {
      const { form, year, quarter } = periodOf(request);

      return viewSchema.parse(
        await viewStatement(principalOf(request), form, year, quarter, reports),
      );
    },
  );

  app.put(
    '/statements/:form/:year/:quarter',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request): Promise<unknown> => {
      const { form, year, quarter } = periodOf(request);

      const body = saveStatementLinesRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'Those figures cannot be saved as entered.');
      }

      return viewSchema.parse(
        await saveStatementLines(
          principalOf(request),
          form,
          year,
          quarter,
          body.data.lines,
          statements,
          reports,
        ),
      );
    },
  );
}
