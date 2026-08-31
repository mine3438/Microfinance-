import { isoDateSchema } from '@mfi/contracts';
import { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type PenaltyRepository } from './penalty-repository.js';
import { accruePenalties } from './use-cases.js';

const accrualRequestSchema = z.object({ asAt: isoDateSchema }).strict();

const accrualResponseSchema = z
  .object({ loansConsidered: z.number().int().nonnegative(), charged: z.string() })
  .strict();

export interface PenaltyRouteOptions {
  readonly penalties: PenaltyRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

/**
 * The accrual, as an endpoint rather than a timer.
 *
 * A scheduled job would still call this, and having the operation reachable
 * means it can be re-run for a date after a failure, or caught up after an
 * outage, without waiting for a timer to come round again. It is idempotent by
 * date, so nothing is harmed by calling it twice.
 *
 * `loan.write_off` guards it — the only seeded permission that represents
 * authority to change what a borrower owes without a payment behind it.
 */
export function registerPenaltyRoutes(app: FastifyInstance, options: PenaltyRouteOptions): void {
  const { penalties, tokens } = options;
  const now = options.now ?? ((): Date => new Date());

  app.post(
    '/penalties/accrual',
    { preHandler: [authenticate(tokens), requirePermission('loan.write_off')] },
    async (request): Promise<unknown> => {
      const body = accrualRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That accrual date is not valid.');
      }

      const outcome = await accruePenalties(principalOf(request), body.data.asAt, penalties, now);

      return accrualResponseSchema.parse({
        loansConsidered: outcome.loansConsidered,
        charged: outcome.charged.toDatabaseValue(),
      });
    },
  );
}
