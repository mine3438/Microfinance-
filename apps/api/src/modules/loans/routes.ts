import {
  botLoanTypeSchema,
  createLoanProductRequestSchema,
  createLoanRequestSchema,
  decideLoanRequestSchema,
  disburseLoanRequestSchema,
  loanListQuerySchema,
  loanProductSchema,
  applicationFeeSchema,
  collectApplicationFeeRequestSchema,
  loanRecoverySchema,
  refundApplicationFeeRequestSchema,
  loanRestructuringSchema,
  restructureLoanRequestSchema,
  settleLoanRequestSchema,
  settlementQuoteQuerySchema,
  settlementQuoteSchema,
  loanSchema,
  loanWithScheduleSchema,
  loanWriteOffSchema,
  recordRecoveryRequestSchema,
  writeOffLoanRequestSchema,
  secureLoanRequestSchema,
  pageSchema,
  previewScheduleRequestSchema,
  repaymentScheduleSchema,
  updateLoanProductRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type LoanRepository } from './loan-repository.js';
import { type ApplicationFeeRepository } from './application-fee-repository.js';
import {
  collectApplicationFee,
  getApplicationFee,
  refundApplicationFee,
} from './application-fee-use-cases.js';
import { type RestructuringRepository } from './restructuring-repository.js';
import { getRestructuring, restructureLoan } from './restructuring-use-cases.js';
import { type SettlementRepository } from './settlement-repository.js';
import { getSettlementQuote, settleLoan } from './settlement-use-cases.js';
import { type WriteOffRepository } from './write-off-repository.js';
import {
  getWriteOff,
  listRecoveries,
  recordRecovery,
  writeOffLoan,
} from './write-off-use-cases.js';
import {
  createLoan,
  decideLoan,
  disburseLoan,
  getLoan,
  listLoans,
  previewSchedule,
  secureLoan,
  setLoanProductStatus,
  submitLoan,
} from './use-cases.js';

const loanPageSchema = pageSchema(loanSchema);
const productListSchema = z.array(loanProductSchema);
const botLoanTypeListSchema = z.array(botLoanTypeSchema);
const recoveryListSchema = z.array(loanRecoverySchema);

export interface LoanRouteOptions {
  readonly loans: LoanRepository;
  readonly writeOffs: WriteOffRepository;
  readonly applicationFees: ApplicationFeeRepository;
  readonly settlements: SettlementRepository;
  readonly restructurings: RestructuringRepository;
  /**
   * Whether the restructuring endpoints are mounted.
   *
   * Off by default, and off means absent: the routes are never registered, so
   * they answer 404 the way any unknown path does. See RESTRUCT-06 and the
   * `RESTRUCTURING_ENABLED` note in `config/environment.ts`.
   */
  readonly restructuringEnabled?: boolean | undefined;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

function productIdOf(request: FastifyRequest): string {
  const parsed = uuidSchema.safeParse((request.params as { id?: unknown }).id);
  if (!parsed.success) {
    throw validationFailed(parsed.error, 'That is not a loan product identifier.');
  }
  return parsed.data;
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
  const { loans, writeOffs, applicationFees, settlements, restructurings, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  const restructuringEnabled = options.restructuringEnabled ?? false;

  /**
   * BOT's loan type taxonomy.
   *
   * Served rather than embedded in the client, for the reason the finance
   * module's reference endpoints exist: a second copy of BOT's list is a list
   * that can disagree with BOT's, and this one decides which MSP2-04 row every
   * loan of a product reports on.
   */
  app.get(
    '/reference/loan-types',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (): Promise<unknown> => botLoanTypeListSchema.parse(await loans.listBotLoanTypes()),
  );

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

  /**
   * Retire a product, or bring one back.
   *
   * `settings.manage`, as creating one is. Only the status moves: terms are
   * never amended in place, because a product describing terms no loan on the
   * book was written under is worse than a retired product.
   */
  app.patch(
    '/loan-products/:id',
    { preHandler: [authenticated, requirePermission('settings.manage')] },
    async (request): Promise<unknown> => {
      const body = updateLoanProductRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That loan product cannot be changed as entered.');
      }

      return loanProductSchema.parse(
        await setLoanProductStatus(
          principalOf(request),
          productIdOf(request),
          body.data.status,
          loans,
        ),
      );
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

  /**
   * Write a loan off.
   *
   * `loan.write_off`, which only `institution_admin` holds — this system's
   * Owner/Manager. There is deliberately no threshold parameter and no
   * scheduled counterpart: the approved rule is that a person judges the debt
   * unrecoverable, and a system that could reach this state on a timer would be
   * taking that judgement.
   */
  app.post(
    '/loans/:id/write-off',
    { preHandler: [authenticated, requirePermission('loan.write_off')] },
    async (request, reply): Promise<unknown> => {
      const body = writeOffLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'A write-off must say why the debt is unrecoverable.');
      }

      const written = await writeOffLoan(
        principalOf(request),
        loanIdOf(request),
        body.data,
        writeOffs,
      );

      void reply.status(201);
      return loanWriteOffSchema.parse(written);
    },
  );

  /** What was written off, after the live balance became zero. */
  app.get(
    '/loans/:id/write-off',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> =>
      loanWriteOffSchema.parse(
        await getWriteOff(principalOf(request), loanIdOf(request), writeOffs),
      ),
  );

  /**
   * Record money received against a written-off loan.
   *
   * `payment.create`: it is a receipt, taken at the counter by the same people
   * who take repayments. What it is *not* is a repayment — the loan stays
   * written off, the balance stays zero, and this reaches MSP2-02's recovery
   * line rather than interest and principal.
   */
  app.post(
    '/loans/:id/recoveries',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request, reply): Promise<unknown> => {
      const body = recordRecoveryRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That recovery cannot be recorded as entered.');
      }

      const recorded = await recordRecovery(
        principalOf(request),
        loanIdOf(request),
        body.data,
        writeOffs,
        now,
      );

      void reply.status(201);
      return loanRecoverySchema.parse(recorded);
    },
  );

  app.get(
    '/loans/:id/recoveries',
    { preHandler: [authenticated, requirePermission('payment.read')] },
    async (request): Promise<unknown> =>
      recoveryListSchema.parse(
        await listRecoveries(principalOf(request), loanIdOf(request), writeOffs),
      ),
  );

  /**
   * Record the TZS 5,000 application/form fee.
   *
   * `payment.create`: it is cash taken at the counter by the people who take
   * cash. The request carries no amount — the charge is fixed policy, and a
   * caller stating it would let a counter typo become the fee.
   */
  app.post(
    '/loans/:id/application-fee',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request, reply): Promise<unknown> => {
      const body = collectApplicationFeeRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        throw validationFailed(body.error, 'That application fee cannot be recorded as entered.');
      }

      const collected = await collectApplicationFee(
        principalOf(request),
        loanIdOf(request),
        body.data,
        applicationFees,
        now,
      );

      void reply.status(201);
      return applicationFeeSchema.parse(collected);
    },
  );

  app.get(
    '/loans/:id/application-fee',
    { preHandler: [authenticated, requirePermission('payment.read')] },
    async (request): Promise<unknown> =>
      applicationFeeSchema.parse(
        await getApplicationFee(principalOf(request), loanIdOf(request), applicationFees),
      ),
  );

  /**
   * Hand the fee back after a rejected application.
   *
   * A POST recording a refund rather than a DELETE removing the collection: the
   * requirement is that what was taken stays evidenced, and a deleted row
   * evidences nothing.
   */
  app.post(
    '/loans/:id/application-fee/refund',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request): Promise<unknown> => {
      const body = refundApplicationFeeRequestSchema.safeParse(request.body ?? {});
      if (!body.success) {
        throw validationFailed(body.error, 'That refund cannot be recorded as entered.');
      }

      return applicationFeeSchema.parse(
        await refundApplicationFee(
          principalOf(request),
          loanIdOf(request),
          body.data,
          applicationFees,
          now,
        ),
      );
    },
  );

  /**
   * What it costs to settle this loan today, or on a stated date.
   *
   * A read, so it is a GET and it changes nothing. The figure is recomputed on
   * every call rather than stored: a quote taken an hour ago may have been
   * overtaken by a penalty accrual or an ordinary repayment, and the settlement
   * itself recomputes again before it closes anything.
   */
  app.get(
    '/loans/:id/settlement/quote',
    { preHandler: [authenticated, requirePermission('payment.read')] },
    async (request): Promise<unknown> => {
      const query = settlementQuoteQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'That settlement date is not valid.');
      }

      return settlementQuoteSchema.parse(
        await getSettlementQuote(
          principalOf(request),
          loanIdOf(request),
          query.data,
          settlements,
          now,
        ),
      );
    },
  );

  /**
   * Settle the loan.
   *
   * Its own operation, not an oversized repayment. The ordinary allocator
   * splits against everything a loan owes — which includes the whole remaining
   * scheduled interest — so it would consume interest the approved rule says is
   * never charged and leave principal outstanding.
   */
  app.post(
    '/loans/:id/settlement',
    { preHandler: [authenticated, requirePermission('payment.create')] },
    async (request, reply): Promise<unknown> => {
      const body = settleLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That settlement cannot be recorded as entered.');
      }

      const settled = await settleLoan(
        principalOf(request),
        loanIdOf(request),
        body.data,
        settlements,
        now,
      );

      void reply.status(201);
      return settlementQuoteSchema.parse(settled);
    },
  );

  /**
   * Restructure the loan into a successor.
   *
   * `loan.write_off`, which only `institution_admin` holds — this system's
   * Owner/Manager, and the same permission the penalty accrual uses for the
   * same stated reason: it is the one seeded permission representing authority
   * to change what a borrower owes without a payment behind it.
   *
   * Nothing is forgiven. The new principal is what the old loan still owed, and
   * the old loan is kept, closed to repayment, and linked to its successor.
   */
  /**
   * Restructuring is mounted only when it is explicitly enabled.
   *
   * Not a permission check and not a hidden button — the routes do not exist
   * when the flag is off, so no client, script or curl can reach the operation
   * however it authenticates. RESTRUCT-06 is unresolved: a successor carries a
   * disbursement date and MSP2-09 counts loans disbursed in the quarter, while
   * no cash moves in a restructuring, so an institution filing a return could
   * overstate disbursements. The implementation below stays intact and tested
   * against a harness that sets the flag; production leaves it off until the
   * ruling arrives.
   */
  if (!restructuringEnabled) {
    return;
  }
  app.post(
    '/loans/:id/restructuring',
    { preHandler: [authenticated, requirePermission('loan.write_off')] },
    async (request, reply): Promise<unknown> => {
      const body = restructureLoanRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That restructuring cannot be recorded as entered.');
      }

      const restructured = await restructureLoan(
        principalOf(request),
        loanIdOf(request),
        body.data,
        restructurings,
        now,
      );

      void reply.status(201);
      return loanRestructuringSchema.parse(restructured);
    },
  );

  /**
   * The restructuring this loan was part of, from either side.
   *
   * Answers it for the old loan and for its successor, because an operator
   * holding either half of the pair needs the same record. Without this,
   * `loan_restructurings` was a table the application wrote and never read.
   */
  app.get(
    '/loans/:id/restructuring',
    { preHandler: [authenticated, requirePermission('loan.read')] },
    async (request): Promise<unknown> =>
      loanRestructuringSchema.parse(
        await getRestructuring(principalOf(request), loanIdOf(request), restructurings),
      ),
  );
}
