import {
  type BankAccount,
  type BankAccountBalance,
  type CreateBankAccountRequest,
  type CreateFinanceEntryRequest,
  type FinanceEntry,
  type FinanceEntryListQuery,
  type FinancialInstitution,
  type Msp2_02Line,
  type Page,
  type RecordBankBalanceRequest,
  type UpdateFinanceEntryRequest,
} from '@mfi/contracts';
import { type Principal } from '@mfi/identity';
import { Money } from '@mfi/money';

import { ApiError, notFound, ruleViolation } from '../../http/errors.js';
import { type FinanceRepository } from './finance-repository.js';

/**
 * Finance use cases.
 *
 * Two things happen here that the database cannot do for itself.
 *
 * The first is naming the field. The schema refuses an entry against a line
 * BOT computes, but a foreign-key violation says only that a key did not
 * match — so every rule is checked here first, against the same taxonomy, to
 * produce a message that says which line and why. The constraint stays as the
 * floor beneath it: a rule enforced only above the database is a rule a script
 * walks around.
 *
 * The second is the currency conversion. A foreign balance reaches BOT as a TZS
 * equivalent, and that multiplication happens in `@mfi/money` exact decimal
 * arithmetic — never in the browser, never in a `numeric` expression the driver
 * might hand back as a float.
 */

/** A refusal that names the field it is about. */
const invalidField = (field: string, message: string): ApiError =>
  new ApiError('validation_failed', message, [{ path: [field], message }]);

export async function listMsp2_02Lines(
  principal: Principal,
  finance: FinanceRepository,
): Promise<Msp2_02Line[]> {
  return finance.msp2_02Lines(principal.institutionId, principal.userId);
}

export async function listFinancialInstitutions(
  principal: Principal,
  finance: FinanceRepository,
): Promise<FinancialInstitution[]> {
  return finance.financialInstitutions(principal.institutionId, principal.userId);
}

export async function listFinanceEntries(
  principal: Principal,
  query: FinanceEntryListQuery,
  finance: FinanceRepository,
): Promise<Page<FinanceEntry>> {
  if (query.from !== undefined && query.to !== undefined && query.from > query.to) {
    throw invalidField('from', 'The start of the range falls after its end.');
  }

  const page = await finance.listEntries(principal.institutionId, principal.userId, query);
  return { items: [...page.items], nextCursor: page.nextCursor };
}

/**
 * Check a line against BOT's taxonomy before the database has to.
 *
 * @throws {ApiError} naming `sno`, so a form can attach the message to the
 * field the person chose rather than showing a constraint name.
 */
async function assertLineAccepts(
  principal: Principal,
  finance: FinanceRepository,
  direction: 'income' | 'expense',
  sno: number,
): Promise<void> {
  const lines = await finance.msp2_02Lines(principal.institutionId, principal.userId);
  const line = lines.find((candidate) => candidate.sno === sno);

  if (line === undefined) {
    throw invalidField('sno', `BOT does not publish an MSP2-02 line numbered ${String(sno)}.`);
  }
  if (line.entryDirection === null) {
    throw invalidField(
      'sno',
      `“${line.label}” is a total BOT computes from the lines beneath it. Record the figure ` +
        'against one of those instead, or it will be counted twice.',
    );
  }
  if (line.entryDirection !== direction) {
    throw invalidField(
      'sno',
      `“${line.label}” is ${line.entryDirection === 'income' ? 'an income' : 'an expense'} line, ` +
        `so it cannot take ${direction === 'income' ? 'income' : 'an expense'} recorded as ` +
        `${direction}.`,
    );
  }
}

export async function recordFinanceEntry(
  principal: Principal,
  request: CreateFinanceEntryRequest,
  finance: FinanceRepository,
): Promise<FinanceEntry> {
  await assertLineAccepts(principal, finance, request.direction, request.sno);

  return finance.createEntry(principal.institutionId, principal.userId, {
    direction: request.direction,
    sno: request.sno,
    amount: request.amount,
    entryDate: request.entryDate,
    branchId: request.branchId,
    description: request.description,
    reference: request.reference,
  });
}

export async function amendFinanceEntry(
  principal: Principal,
  id: string,
  request: UpdateFinanceEntryRequest,
  finance: FinanceRepository,
): Promise<FinanceEntry> {
  // Direction and line move together through one composite key, so a request
  // that changes either is checked as the pair it will become — not against
  // whichever half happened to be sent.
  if (request.direction !== undefined || request.sno !== undefined) {
    const existing = await finance.findEntry(principal.institutionId, principal.userId, id);
    if (existing === null) {
      throw notFound('That entry does not exist.');
    }

    const direction = request.direction ?? existing.direction;
    const sno = request.sno ?? existing.sno;

    await assertLineAccepts(principal, finance, direction, sno);

    return finance.updateEntry(principal.institutionId, principal.userId, id, {
      ...request,
      direction,
      sno,
    });
  }

  return finance.updateEntry(principal.institutionId, principal.userId, id, request);
}

export async function removeFinanceEntry(
  principal: Principal,
  id: string,
  finance: FinanceRepository,
): Promise<void> {
  await finance.deleteEntry(principal.institutionId, principal.userId, id);
}

export async function listBankAccounts(
  principal: Principal,
  finance: FinanceRepository,
): Promise<BankAccount[]> {
  return finance.listAccounts(principal.institutionId, principal.userId);
}

/** Sections BOT draws from a published list, and those it leaves to be named. */
const LISTED_SECTIONS = new Set(['bank_tanzania', 'mno']);

export async function openBankAccount(
  principal: Principal,
  request: CreateBankAccountRequest,
  finance: FinanceRepository,
): Promise<BankAccount> {
  const listed = LISTED_SECTIONS.has(request.holdingKind);

  if (listed && request.institutionCode === undefined) {
    throw invalidField(
      'institutionCode',
      'BOT publishes the institutions for this section, so one has to be chosen from the list.',
    );
  }
  if (listed && request.counterpartyName !== undefined) {
    throw invalidField(
      'counterpartyName',
      'This section is filed against a published institution, so its name is not typed in.',
    );
  }
  if (!listed && request.counterpartyName === undefined) {
    throw invalidField(
      'counterpartyName',
      'BOT publishes no list for this section, so the counterparty has to be named.',
    );
  }
  if (!listed && request.institutionCode !== undefined) {
    throw invalidField(
      'institutionCode',
      'BOT publishes no list for this section, so there is no code to file it against.',
    );
  }

  if (request.institutionCode !== undefined) {
    const institutions = await finance.financialInstitutions(
      principal.institutionId,
      principal.userId,
    );
    const institution = institutions.find(
      (candidate) => candidate.code === request.institutionCode,
    );

    if (institution === undefined) {
      throw invalidField('institutionCode', 'That is not an institution BOT publishes.');
    }

    const expected = request.holdingKind === 'mno' ? 'mno' : 'bank';
    if (institution.kind !== expected) {
      throw invalidField(
        'institutionCode',
        `${institution.name} is ${institution.kind === 'mno' ? 'a mobile network operator' : 'a bank'}, ` +
          'so it belongs on a different section of MSP2-07.',
      );
    }
  }

  return finance.createAccount(principal.institutionId, principal.userId, {
    holdingKind: request.holdingKind,
    institutionCode: request.institutionCode ?? null,
    counterpartyName: request.counterpartyName ?? null,
    accountNumber: request.accountNumber ?? null,
    currencyCode: request.currencyCode,
  });
}

export async function listBankBalances(
  principal: Principal,
  year: number,
  quarter: number,
  finance: FinanceRepository,
): Promise<BankAccountBalance[]> {
  return finance.listBalances(principal.institutionId, principal.userId, year, quarter);
}

/**
 * Record what an account held at a quarter end.
 *
 * The TZS equivalent is computed here rather than sent, so the figure BOT
 * receives is this system's arithmetic rather than a browser's. A TZS account
 * converts at par and must carry no rate; anything else must carry both a rate
 * and the date it was taken — which rate BOT expects is unconfirmed
 * (02-BOT-REPORTING-SPEC.md §11.6), and recording the one used is what makes a
 * filed figure explainable afterwards.
 */
export async function recordBankBalance(
  principal: Principal,
  accountId: string,
  request: RecordBankBalanceRequest,
  finance: FinanceRepository,
): Promise<BankAccountBalance> {
  const account = await finance.findAccount(principal.institutionId, principal.userId, accountId);
  if (account === null) {
    throw notFound('That account does not exist.');
  }
  if (account.status === 'closed') {
    throw ruleViolation(
      'That account is closed, so no further quarter-end balance can be recorded against it.',
    );
  }

  const inTzs = account.currencyCode === 'TZS';

  if (inTzs && request.exchangeRate !== undefined) {
    throw invalidField(
      'exchangeRate',
      'This account is held in shillings, so there is nothing to convert.',
    );
  }
  if (!inTzs && (request.exchangeRate === undefined || request.rateDate === undefined)) {
    throw invalidField(
      'exchangeRate',
      `This account is held in ${account.currencyCode}, so BOT's shilling column needs the rate ` +
        'used and the day it was taken.',
    );
  }

  const agentBanking = Money.of(request.agentBankingBalance);
  if (!agentBanking.isZero() && !account.supportsAgentBanking) {
    throw ruleViolation(
      `BOT does not list ${account.counterparty} for agent banking, so MSP2-08 has no row for ` +
        'this balance and it cannot be reported.',
    );
  }

  const deposit = Money.of(request.depositBalance);
  const borrowing = Money.of(request.borrowingBalance);

  // Exact decimal, half-up to the cent — the same arithmetic every other
  // monetary figure in this system goes through.
  const toTzs = (amount: Money): Money =>
    request.exchangeRate === undefined ? amount : amount.times(request.exchangeRate);

  return finance.recordBalance(principal.institutionId, principal.userId, {
    bankAccountId: accountId,
    year: request.year,
    quarter: request.quarter,
    currencyCode: account.currencyCode,
    supportsAgentBanking: account.supportsAgentBanking,
    depositBalance: deposit.toDatabaseValue(),
    borrowingBalance: borrowing.toDatabaseValue(),
    depositBalanceTzs: toTzs(deposit).toDatabaseValue(),
    borrowingBalanceTzs: toTzs(borrowing).toDatabaseValue(),
    agentBankingBalance: agentBanking.toDatabaseValue(),
    exchangeRate: request.exchangeRate ?? null,
    rateDate: request.rateDate ?? null,
  });
}
