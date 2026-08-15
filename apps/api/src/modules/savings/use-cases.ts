import {
  type CreateSavingsProductRequest,
  type OpenSavingsAccountRequest,
  type Page,
  type RecordSavingsEntryRequest,
  type ReverseSavingsEntryRequest,
  type SavingsAccount,
  type SavingsAccountListQuery,
  type SavingsProduct,
  type SavingsTransaction,
} from '@mfi/contracts';
import { type Principal } from '@mfi/identity';

import { notFound, ruleViolation } from '../../http/errors.js';
import { type SavingsRepository } from './savings-repository.js';

/**
 * Savings, as far as the documentation settles it.
 *
 * There is no interest here, and that is the point: §13.4 asks for the rate
 * basis, the accrual frequency, the minimum balance, the withdrawal rules and
 * whether savings can secure a loan, and until those are answered a balance is
 * what was paid in less what was taken out.
 *
 * The rules that *are* enforced come from somewhere other than a product
 * decision: a balance cannot go negative, because a negative one is an
 * overdraft; and an entry cannot be dated in the future, because MSP2-10
 * reports the balance as at a quarter end and a figure dated next month would
 * appear on no return until that month arrives — and then on one that may
 * already have been filed.
 */

export async function listSavingsProducts(
  principal: Principal,
  savings: SavingsRepository,
): Promise<SavingsProduct[]> {
  return savings.listProducts(principal.institutionId, principal.userId);
}

export async function createSavingsProduct(
  principal: Principal,
  request: CreateSavingsProductRequest,
  savings: SavingsRepository,
): Promise<SavingsProduct> {
  return savings.createProduct(principal.institutionId, principal.userId, request);
}

export async function listSavingsAccounts(
  principal: Principal,
  filters: SavingsAccountListQuery,
  savings: SavingsRepository,
): Promise<Page<SavingsAccount>> {
  const page = await savings.listAccounts(principal.institutionId, principal.userId, filters);
  return { items: [...page.items], nextCursor: page.nextCursor };
}

export async function getSavingsAccount(
  principal: Principal,
  id: string,
  savings: SavingsRepository,
): Promise<SavingsAccount> {
  const account = await savings.findAccount(principal.institutionId, principal.userId, id);
  if (account === null) {
    throw notFound('That savings account does not exist.');
  }
  return account;
}

export async function openSavingsAccount(
  principal: Principal,
  request: OpenSavingsAccountRequest,
  savings: SavingsRepository,
  now: () => Date = () => new Date(),
): Promise<SavingsAccount> {
  refuseFutureDate(request.openedOn, now, 'A savings account cannot be opened in the future.');

  return savings.openAccount(principal.institutionId, principal.userId, request);
}

export async function listSavingsTransactions(
  principal: Principal,
  accountId: string,
  savings: SavingsRepository,
): Promise<SavingsTransaction[]> {
  // Through the account, so a statement for an account this caller cannot see
  // is a 404 rather than an empty list that reads as "no activity".
  await getSavingsAccount(principal, accountId, savings);

  return savings.listTransactions(principal.institutionId, principal.userId, accountId);
}

export async function recordSavingsEntry(
  principal: Principal,
  accountId: string,
  request: RecordSavingsEntryRequest,
  savings: SavingsRepository,
  now: () => Date = () => new Date(),
): Promise<SavingsTransaction> {
  refuseFutureDate(request.transactionDate, now, 'A savings entry cannot be dated in the future.');

  const account = await getSavingsAccount(principal, accountId, savings);
  if (request.transactionDate < account.openedOn) {
    throw ruleViolation(
      `This account was opened on ${account.openedOn}, so it cannot have taken an entry on ` +
        `${request.transactionDate}.`,
    );
  }

  return savings.recordEntry(principal.institutionId, principal.userId, accountId, request);
}

export async function reverseSavingsEntry(
  principal: Principal,
  transactionId: string,
  request: ReverseSavingsEntryRequest,
  savings: SavingsRepository,
  now: () => Date = () => new Date(),
): Promise<SavingsTransaction> {
  refuseFutureDate(request.reversedOn, now, 'A reversal cannot be dated in the future.');

  return savings.reverseEntry(
    principal.institutionId,
    principal.userId,
    transactionId,
    request.reversedOn,
    request.narrative,
  );
}

function refuseFutureDate(date: string, now: () => Date, message: string): void {
  const today = now().toISOString().slice(0, 10);
  if (date > today) {
    throw ruleViolation(`${message} Today is ${today}.`);
  }
}
