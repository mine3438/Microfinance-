import {
  createLoanProductRequestSchema,
  createLoanRequestSchema,
  decideLoanRequestSchema,
  disburseLoanRequestSchema,
  loanListQuerySchema,
  loanProductSchema,
  loanSchema,
  loanWithScheduleSchema,
  secureLoanRequestSchema,
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
  secureLoan,
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

  /**
   * Define a product.
   *
   * `settings.manage` rather than `loan.create`, on the same reasoning as
   * savings products: a product fixes the rate band, the term band, the
   * principal band, the BOT loan type every loan of it reports under and the
   * penalty terms every borrower on it is charged. That is institution policy,
   * not something an officer settles while entering an application.
   *
   * This is where §13.1's figures enter the system. They are the institution's
   * to state — nothing here supplies a default, and a product created without
   * them charges no penalty.
   */
  app.post(
    '/loan-products',
    { preHandler: [authenticated, requirePermission('settings.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = createLoanProductRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That loan product cannot be created as entered.');
      }

      const principal = principalOf(request);
      const product = await loans.createProduct(
        principal.institutionId,
        principal.userId,
        body.data,
      );

      void reply.status(201).header('location', `/loan-products/${product.id}`);
      return loanProductSchema.parse(product);
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

  /**
   * Record the compulsory savings standing behind a loan.
   *
   * `loan.create` rather than `savings.manage`: this says what secures a loan,
   * not what a client holds. The money itself moves through the savings ledger,
   * and the database refuses more security than the borrower actually has.
   */
  app.put(
    '/loans/:id/collateral',
    { preHandler: [authenticated, requirePermission('loan.create')] },
    async (request): Promise<unknown> => {
      const body = secureLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That security cannot be recorded as entered.');
      }

      return loanSchema.parse(
        await secureLoan(
          principalOf(request),
          loanIdOf(request),
          body.data.compulsorySavingsSecured,
          loans,
        ),
      );
    },
  );
}
