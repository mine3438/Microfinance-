import { classificationRunSchema, portfolioSummarySchema } from '@mfi/contracts';
import { type FastifyInstance } from 'fastify';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { type ClassificationRepository } from './classification-repository.js';

export interface PortfolioRouteOptions {
  readonly classification: ClassificationRepository;
  readonly tokens: AccessTokenService;
}

/**
 * Running the overdue classification on demand.
 *
 * `report.generate`, because the person this exists for is the one the reports
 * screen has just refused: "classifications were last computed 30 hours ago"
 * is only actionable if the same person can act on it. A refusal that sends its
 * reader to a database console is how the previous build's job came to be run
 * by hand and then forgotten.
 *
 * The scheduled run is the CLI (`apps/api/src/jobs/classify.ts`). This endpoint
 * does not replace it — an institution relying on someone noticing a red banner
 * is an institution whose figures go stale the first quiet week.
 */
export function registerPortfolioRoutes(
  app: FastifyInstance,
  options: PortfolioRouteOptions,
): void {
  const { classification, tokens } = options;
  const authenticated = authenticate(tokens);

  /**
   * The book by BOT's five classifications, as at the last run.
   *
   * `loan.read`, because this is the loan book — an officer looking at arrears
   * is looking at their own portfolio, not at a report. The staleness stamp
   * travels with the figures so the screen can say how old they are, which is
   * the whole point: R5 was a dashboard showing a stopped job's last answer as
   * though it were current.
   */
  app.get(
    '/portfolio/summary',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> => {
      const principal = principalOf(request);
      return portfolioSummarySchema.parse(
        await classification.summary(principal.institutionId, principal.userId),
      );
    },
  );

  app.post(
    '/portfolio/classification',
    { preHandler: [authenticated, requirePermission('report.generate')] },
    async (request): Promise<unknown> => {
      const principal = principalOf(request);
      return classificationRunSchema.parse(
        await classification.reclassify(principal.institutionId, principal.userId),
      );
    },
  );
}
