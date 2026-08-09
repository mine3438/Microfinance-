import {
  allocationPreviewSchema,
  pageSchema,
  paymentListQuerySchema,
  paymentSchema,
  previewAllocationRequestSchema,
  recordPaymentRequestSchema,
  reversePaymentRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type PaymentRepository } from './payment-repository.js';
import {
  getPayment,
  listPayments,
  previewAllocation,
  recordPayment,
  reversePayment,
} from './use-cases.js';

const paymentPageSchema = pageSchema(paymentSchema);

export interface PaymentRouteOptions {
  readonly payments: PaymentRepository;
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
 * Payment routes.
 *
 * Note what is absent: there is no `PATCH /payments/:id` and no `DELETE`. A
 * recorded payment is evidence, and evidence that can be edited is not
 * evidence. The only correction is a reversal, which is its own row with its
 * own reason — and `payment.reverse` is a separate permission from
 * `payment.create`, so recording money and undoing it are not the same
 * authority.
 */
export function registerPaymentRoutes(app: FastifyInstance, options: PaymentRouteOptions): void {
  const { payments, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/payments',
    { preHandler: [authenticated, requirePermission('payment.read')] },
    async (request): Promise<unknown> => {
      const query = paymentListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those list options are not valid.');
      }

      return paymentPageSchema.parse(
        await listPayments(principalOf(request), query.data, payments),
      );
    },
  );

  app.get(
    '/payments/:id',
    { preHandler: [authenticated, requirePermission('payment.read')] },
    async (request): Promise<unknown> =>
      paymentSchema.parse(
        await getPayment(principalOf(request), idOf(request, 'id', 'payment'), payments),
      ),
  );

  /**
   * What an amount would do, without doing it.
   *
   * Runs the same allocator the write path runs, so the figure quoted at the
   * counter is the figure that will be recorded.
   */
  app.post(
    '/loans/:loanId/payments/preview',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request): Promise<unknown> => {
      const body = previewAllocationRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That amount cannot be applied as entered.');
      }

      return allocationPreviewSchema.parse(
        await previewAllocation(
          principalOf(request),
          idOf(request, 'loanId', 'loan'),
          body.data,
          payments,
        ),
      );
    },
  );

  app.post(
    '/loans/:loanId/payments',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request, reply): Promise<unknown> => {
      const body = recordPaymentRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That payment cannot be recorded as entered.');
      }

      const recorded = await recordPayment(
        principalOf(request),
        idOf(request, 'loanId', 'loan'),
        body.data,
        payments,
      );

      void reply.status(201).header('location', `/payments/${recorded.id}`);
      return paymentSchema.parse(recorded);
    },
  );

  app.post(
    '/payments/:id/reversal',
    { preHandler: [authenticated, requirePermission('payment.reverse')] },
    async (request, reply): Promise<unknown> => {
      const body = reversePaymentRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(
          body.error,
          'A reversal must say why. An unexplained movement of money is worse than the ' +
            'mistake it corrects.',
        );
      }

      const reversal = await reversePayment(
        principalOf(request),
        idOf(request, 'id', 'payment'),
        body.data,
        payments,
      );

      void reply.status(201).header('location', `/payments/${reversal.id}`);
      return paymentSchema.parse(reversal);
    },
  );
}
