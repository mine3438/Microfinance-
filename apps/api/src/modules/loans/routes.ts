import {
  createLoanRequestSchema,
  decideLoanRequestSchema,
  disburseLoanRequestSchema,
  loanListQuerySchema,
  loanProductSchema,
  loanSchema,
  loanWithScheduleSchema,
  pageSchema,
  previewScheduleRequestSchema,
  repaymentScheduleSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type LoanRepository } from './loan-repository.js';
import {
  createLoan,
  decideLoan,
  disburseLoan,
  getLoan,
  listLoans,
  previewSchedule,
  submitLoan,
} from './use-cases.js';

const loanPageSchema = pageSchema(loanSchema);
const productListSchema = z.array(loanProductSchema);

export interface LoanRouteOptions {
  readonly loans: LoanRepository;
  readonly tokens: AccessTokenService;
}

function loanIdOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as { id?: unknown }).id);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a loan identifier.');
  }
  return parsed.data;
}

/**
 * Loan routes.
 *
 * The permissions are separate on purpose and match the seeded roles: an
 * officer holds `loan.create` and not `loan.approve`, so the two ends of
 * maker-checker cannot be held by one person through a role definition. The
 * domain then refuses self-approval even where somebody holds both, and a
 * database constraint refuses it again beneath that.
 */
export function registerLoanRoutes(app: FastifyInstance, options: LoanRouteOptions): void {
  const { loans, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/loan-products',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> => {
      const principal = principalOf(request);
      const products = await loans.listProducts(principal.institutionId, principal.userId);
      return productListSchema.parse(products);
    },
  );

  app.get(
    '/loans',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> => {
      const query = loanListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those list options are not valid.');
      }

      return loanPageSchema.parse(await listLoans(principalOf(request), query.data, loans));
    },
  );

  app.get(
    '/loans/:id',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> =>
      loanWithScheduleSchema.parse(await getLoan(principalOf(request), loanIdOf(request), loans)),
  );

  /**
   * Preview a schedule without creating anything.
   *
   * The endpoint that keeps the browser out of the arithmetic. It runs the same
   * `generateSchedule` the disbursement path runs, so what a borrower is shown
   * before signing is what the system will hold them to.
   */
  app.post(
    '/loans/preview-schedule',
    { preHandler: [authenticated, requirePermission('loan.create')] },
    async (request): Promise<unknown> => {
      const body = previewScheduleRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'A schedule cannot be produced for those terms.');
      }

      return repaymentScheduleSchema.parse(
        await previewSchedule(principalOf(request), body.data, loans),
      );
    },
  );

  app.post(
    '/loans',
    { preHandler: [authenticated, requirePermission('loan.create')] },
    async (request, reply): Promise<unknown> => {
      const body = createLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That application cannot be recorded as entered.');
      }

      const created = await createLoan(principalOf(request), body.data, loans);

      void reply.status(201).header('location', `/loans/${created.id}`);
      return loanSchema.parse(created);
    },
  );

  app.post(
    '/loans/:id/submit',
    { preHandler: [authenticated, requirePermission('loan.create')] },
    async (request): Promise<unknown> =>
      loanSchema.parse(await submitLoan(principalOf(request), loanIdOf(request), loans)),
  );

  app.post(
    '/loans/:id/decision',
    { preHandler: [authenticated, requirePermission('loan.approve')] },
    async (request): Promise<unknown> => {
      const body = decideLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(
          body.error,
          'A decision must be an approval, or a rejection with a reason.',
        );
      }

      return loanSchema.parse(
        await decideLoan(principalOf(request), loanIdOf(request), body.data, loans),
      );
    },
  );

  app.post(
    '/loans/:id/disbursement',
    { preHandler: [authenticated, requirePermission('loan.disburse')] },
    async (request): Promise<unknown> => {
      const body = disburseLoanRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        throw validationFailed(body.error, 'That disbursement cannot be recorded as entered.');
      }

      return loanWithScheduleSchema.parse(
        await disburseLoan(principalOf(request), loanIdOf(request), body.data, loans),
      );
    },
  );
}
