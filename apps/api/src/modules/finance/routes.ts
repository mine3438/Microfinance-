import {
  bankAccountBalanceSchema,
  bankAccountSchema,
  bankBalanceListQuerySchema,
  createBankAccountRequestSchema,
  createFinanceEntryRequestSchema,
  financeEntryListQuerySchema,
  financeEntrySchema,
  financialInstitutionSchema,
  msp2_02LineSchema,
  pageSchema,
  recordBankBalanceRequestSchema,
  updateFinanceEntryRequestSchema,
  uuidSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf, requirePermission } from '../../http/authentication.js';
import { validationFailed } from '../../http/errors.js';
import { type FinanceRepository } from './finance-repository.js';
import {
  amendFinanceEntry,
  listBankAccounts,
  listBankBalances,
  listFinanceEntries,
  listFinancialInstitutions,
  listMsp2_02Lines,
  openBankAccount,
  recordBankBalance,
  recordFinanceEntry,
  removeFinanceEntry,
} from './use-cases.js';

const entryPageSchema = pageSchema(financeEntrySchema);
const lineListSchema = z.array(msp2_02LineSchema);
const institutionListSchema = z.array(financialInstitutionSchema);
const accountListSchema = z.array(bankAccountSchema);
const balanceListSchema = z.array(bankAccountBalanceSchema);

function idOf(request: FastifyRequest, key: string, subject: string): string {
  const parsed = uuidSchema.safeParse((request.params as Record<string, unknown>)[key]);
  if (!parsed.success) {
    throw validationFailed(parsed.error, `That is not a ${subject} identifier.`);
  }
  return parsed.data;
}

/**
 * Finance routes.
 *
 * Guarded on `expense.read` and `expense.manage`, which the seeded catalogue
 * gives the accountant and the institution administrator — §9.2 describes that
 * role as "finops, reports", and bank balances are finops. The permission's
 * name is narrower than what it now covers; splitting it would create an
 * authority no seeded role distinguishes, so it is recorded as a naming debt
 * rather than papered over with a second permission.
 *
 * Two of these endpoints serve BOT's own reference data. A client that needs
 * to show a line by name or offer a bank to choose from fetches it here rather
 * than embedding a copy, because a second list is a list that can disagree with
 * BOT's.
 */
export interface FinanceRouteOptions {
  readonly finance: FinanceRepository;
  readonly tokens: AccessTokenService;
}

export function registerFinanceRoutes(app: FastifyInstance, options: FinanceRouteOptions): void {
  const { finance, tokens } = options;
  const authenticated = authenticate(tokens);

  app.get(
    '/reference/msp2-02-lines',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> =>
      lineListSchema.parse(await listMsp2_02Lines(principalOf(request), finance)),
  );

  app.get(
    '/reference/financial-institutions',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> =>
      institutionListSchema.parse(await listFinancialInstitutions(principalOf(request), finance)),
  );

  app.get(
    '/finance/entries',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> => {
      const query = financeEntryListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Those list options are not valid.');
      }

      return entryPageSchema.parse(
        await listFinanceEntries(principalOf(request), query.data, finance),
      );
    },
  );

  app.post(
    '/finance/entries',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = createFinanceEntryRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That entry cannot be recorded as entered.');
      }

      const recorded = await recordFinanceEntry(principalOf(request), body.data, finance);

      void reply.status(201).header('location', `/finance/entries/${recorded.id}`);
      return financeEntrySchema.parse(recorded);
    },
  );

  app.patch(
    '/finance/entries/:id',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request): Promise<unknown> => {
      const body = updateFinanceEntryRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That change cannot be applied as entered.');
      }

      return financeEntrySchema.parse(
        await amendFinanceEntry(
          principalOf(request),
          idOf(request, 'id', 'entry'),
          body.data,
          finance,
        ),
      );
    },
  );

  app.delete(
    '/finance/entries/:id',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request, reply): Promise<null> => {
      await removeFinanceEntry(principalOf(request), idOf(request, 'id', 'entry'), finance);

      void reply.status(204);
      return null;
    },
  );

  app.get(
    '/finance/bank-accounts',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> =>
      accountListSchema.parse(await listBankAccounts(principalOf(request), finance)),
  );

  app.post(
    '/finance/bank-accounts',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request, reply): Promise<unknown> => {
      const body = createBankAccountRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That account cannot be opened as entered.');
      }

      const account = await openBankAccount(principalOf(request), body.data, finance);

      void reply.status(201).header('location', `/finance/bank-accounts/${account.id}`);
      return bankAccountSchema.parse(account);
    },
  );

  app.get(
    '/finance/bank-balances',
    { preHandler: [authenticated, requirePermission('expense.read')] },
    async (request): Promise<unknown> => {
      const query = bankBalanceListQuerySchema.safeParse(request.query);
      if (!query.success) {
        throw validationFailed(query.error, 'Name the year and quarter to list balances for.');
      }

      return balanceListSchema.parse(
        await listBankBalances(principalOf(request), query.data.year, query.data.quarter, finance),
      );
    },
  );

  /**
   * Record a quarter-end balance.
   *
   * A `PUT`, because there is exactly one balance per account per quarter and
   * restating it as bank statements arrive is expected. A `POST` would suggest
   * a second figure could exist beside the first, which is precisely what the
   * unique key forbids.
   */
  app.put(
    '/finance/bank-accounts/:id/balances',
    { preHandler: [authenticated, requirePermission('expense.manage')] },
    async (request): Promise<unknown> => {
      const body = recordBankBalanceRequestSchema.safeParse(request.body);
      if (!body.success) {
        throw validationFailed(body.error, 'That balance cannot be recorded as entered.');
      }

      return bankAccountBalanceSchema.parse(
        await recordBankBalance(
          principalOf(request),
          idOf(request, 'id', 'account'),
          body.data,
          finance,
        ),
      );
    },
  );
}
