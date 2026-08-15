import {
  createSavingsProductRequestSchema,
  openSavingsAccountRequestSchema,
  pageSchema,
  recordSavingsEntryRequestSchema,
  reverseSavingsEntryRequestSchema,
  savingsAccountListQuerySchema,
  savingsAccountSchema,
  savingsProductSchema,
  savingsTransactionSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type SavingsRepository } from './savings-repository.js';
import {
  createSavingsProduct,
  getSavingsAccount,
  listSavingsAccounts,
  listSavingsProducts,
  listSavingsTransactions,
  openSavingsAccount,
  recordSavingsEntry,
  reverseSavingsEntry,
} from './use-cases.js';

const accountPageSchema = pageSchema(savingsAccountSchema);
const productListSchema = z.array(savingsProductSchema);
const transactionListSchema = z.array(savingsTransactionSchema);

function idOf(request: FastifyRequest, key: string, subject: string): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)[key]);
  if (!parsed.success) {
    throw validationFailed(parsed.error, `That is not a ${subject} identifier.`);
  }
  return parsed.data;
}

export interface SavingsRouteOptions {
  readonly savings: SavingsRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

/**
 * Savings routes.
 *
 * `savings.read` and `savings.manage`. Defining a product is `settings.manage`
 * instead: whether a product is compulsory decides whether its balances appear
 * on three BOT forms or on none, which is an institution-level decision rather
 * than something a teller does between transactions.
 *
 * There is no route to amend or delete a ledger entry, and the database grants
 * no privilege for either. A mistake is corrected by a reversing entry, which
 * leaves both the error and the correction on the statement.
 */
export function registerSavingsRoutes(app: FastifyInstance, options: SavingsRouteOptions): void {
  const { savings, tokens } = options;
  const now = options.now ?? ((): Date => new Date());
  const authenticated = authenticate(tokens);

  app.get(
    '/savings/products',
    { preHandler: [authenticated, requirePermission('savings.read')] },
    async (request): Promise<unknown> =>
      productListSchema.parse(await listSavingsProducts(principalOf(request), savings)),
  );

  app.post(
    '/savings/products',
    { preHandler: [authenticated, requirePermission('settings.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = createSavingsProductRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That savings product cannot be created as entered.');
      }

      const product = await createSavingsProduct(principalOf(request), body.data, savings);

      void reply.status(201);
      return savingsProductSchema.parse(product);
    },
  );

  app.get(
    '/savings/accounts',
    { preHandler: [authenticated, requirePermission('savings.read')] },
    async (request): Promise<unknown> => {
      const filters = savingsAccountListQuerySchema.safeParse(request.query);
      if (!filters.success) {
        throw validationFailed(filters.error, 'Those savings filters are not valid.');
      }

      return accountPageSchema.parse(
        await listSavingsAccounts(principalOf(request), filters.data, savings),
      );
    },
  );

  app.get(
    '/savings/accounts/:id',
    { preHandler: [authenticated, requirePermission('savings.read')] },
    async (request): Promise<unknown> =>
      savingsAccountSchema.parse(
        await getSavingsAccount(
          principalOf(request),
          idOf(request, 'id', 'savings account'),
          savings,
        ),
      ),
  );

  app.post(
    '/savings/accounts',
    { preHandler: [authenticated, requirePermission('savings.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = openSavingsAccountRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That savings account cannot be opened as entered.');
      }

      const account = await openSavingsAccount(principalOf(request), body.data, savings, now);

      void reply.status(201).header('location', `/savings/accounts/${account.id}`);
      return savingsAccountSchema.parse(account);
    },
  );

  /** The statement: every entry, newest first, with the balance each left. */
  app.get(
    '/savings/accounts/:id/transactions',
    { preHandler: [authenticated, requirePermission('savings.read')] },
    async (request): Promise<unknown> =>
      transactionListSchema.parse(
        await listSavingsTransactions(
          principalOf(request),
          idOf(request, 'id', 'savings account'),
          savings,
        ),
      ),
  );

  app.post(
    '/savings/accounts/:id/transactions',
    { preHandler: [authenticated, requirePermission('savings.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = recordSavingsEntryRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That savings entry cannot be recorded as entered.');
      }

      const entry = await recordSavingsEntry(
        principalOf(request),
        idOf(request, 'id', 'savings account'),
        body.data,
        savings,
        now,
      );

      void reply.status(201);
      return savingsTransactionSchema.parse(entry);
    },
  );

  /** Correcting an entry, by adding its opposite rather than editing it. */
  app.post(
    '/savings/transactions/:id/reversal',
    { preHandler: [authenticated, requirePermission('savings.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = reverseSavingsEntryRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That reversal cannot be recorded as entered.');
      }

      const entry = await reverseSavingsEntry(
        principalOf(request),
        idOf(request, 'id', 'savings entry'),
        body.data,
        savings,
        now,
      );

      void reply.status(201);
      return savingsTransactionSchema.parse(entry);
    },
  );
}
