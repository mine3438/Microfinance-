import {
  type SettleLoanRequest,
  type SettlementQuote,
  type SettlementQuoteQuery,
} from '@mfi/contracts';
import { quoteSettlement } from '@mfi/domain';
import { canActOnBranch, type Principal } from '@mfi/identity';
import { Money } from '@mfi/money';

import { conflict, notFound, ruleViolation } from '../../http/errors.js';
import { type SettlementRepository, type SettlementSubject } from './settlement-repository.js';

/**
 * Settling a loan before maturity.
 *
 * An explicit operation rather than an oversized repayment, and not for
 * tidiness. The ordinary allocator splits a payment against everything a loan
 * owes, and what a loan owes includes the **whole remaining scheduled
 * interest** — so routing a settlement through it would consume interest the
 * approved rule says is never charged, and leave principal outstanding. The two
 * paths compute genuinely different figures from the same loan.
 *
 * What is charged: principal, interest through the settlement month, and every
 * accrued penalty. What is not: any month after the settlement month, and the
 * TZS 5,000 application/form fee, which was handled at application and never
 * became a loan balance.
 */

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Load the loan and refuse anything that cannot be settled. */
async function settleableLoan(
  principal: Principal,
  loanId: string,
  repository: SettlementRepository,
): Promise<SettlementSubject> {
  const subject = await repository.subject(principal.institutionId, principal.userId, loanId);

  if (subject === null || !canActOnBranch(principal, subject.branchId)) {
    throw notFound('No such loan.');
  }

  if (subject.status === 'completed') {
    throw conflict('That loan is already settled.');
  }

  if (subject.status !== 'active') {
    throw ruleViolation(`Only a disbursed loan can be settled; this one is ${subject.status}.`);
  }

  return subject;
}

/** Run the approved rule over a loan, at a date. */
function quoteFor(subject: SettlementSubject, settlementDate: string): SettlementQuote {
  const quote = quoteSettlement({
    settlementDate,
    outstandingPrincipal: Money.fromDatabaseValue(subject.outstandingPrincipal),
    penaltyOutstanding: Money.fromDatabaseValue(subject.penaltyOutstanding),
    schedule: subject.schedule.map((instalment) => ({
      dueDate: instalment.dueDate,
      interestDue: Money.fromDatabaseValue(instalment.interestDue),
    })),
    interestAlreadyPaid: Money.fromDatabaseValue(subject.interestAlreadyPaid),
  });

  return {
    loanId: subject.loanId,
    settlementDate: quote.settlementDate,
    chargedThrough: quote.chargedThrough,
    principal: quote.principal.toDatabaseValue(),
    interest: quote.interest.toDatabaseValue(),
    penalty: quote.penalty.toDatabaseValue(),
    total: quote.total.toDatabaseValue(),
    interestNotCharged: quote.interestNotCharged.toDatabaseValue(),
  };
}

export async function getSettlementQuote(
  principal: Principal,
  loanId: string,
  query: SettlementQuoteQuery,
  repository: SettlementRepository,
  now: () => Date,
): Promise<SettlementQuote> {
  const subject = await settleableLoan(principal, loanId, repository);
  const settlementDate = query.settlementDate ?? formatDateOnly(now());

  return quoteFor(subject, settlementDate);
}

/**
 * Take the settlement and close the loan.
 *
 * The quote is recomputed here rather than trusted from whatever the caller was
 * shown. A quote read at the counter an hour ago may have been overtaken by a
 * penalty accrual or an ordinary repayment, and settling against a stale figure
 * would close a loan for the wrong amount.
 *
 * The amount the caller states must match that fresh figure exactly. Refusing a
 * mismatch is what turns a miscount at the counter into a message rather than a
 * closed loan with a shortfall nobody notices.
 */
export async function settleLoan(
  principal: Principal,
  loanId: string,
  request: SettleLoanRequest,
  repository: SettlementRepository,
  now: () => Date,
): Promise<SettlementQuote> {
  const subject = await settleableLoan(principal, loanId, repository);

  const today = formatDateOnly(now());
  const settlementDate = request.settlementDate ?? today;

  if (settlementDate > today) {
    // A future-dated settlement would charge a month that has not happened and
    // land the receipt in a quarter that has not either.
    throw ruleViolation('A settlement cannot be dated in the future.');
  }

  const quote = quoteFor(subject, settlementDate);

  if (!Money.fromDatabaseValue(request.amountPaid).equals(Money.fromDatabaseValue(quote.total))) {
    throw ruleViolation(
      `Settling this loan on ${settlementDate} costs ${quote.total}, not ${request.amountPaid}. ` +
        'Take a fresh quote and settle against that.',
    );
  }

  const recorded = await repository.settle(principal.institutionId, principal.userId, {
    loanId,
    principal: quote.principal,
    interest: quote.interest,
    penalty: quote.penalty,
    total: quote.total,
    balanceBefore: subject.outstandingPrincipal,
    settledOn: settlementDate,
    notes: request.notes ?? null,
  });

  if (recorded === null) {
    // The closing UPDATE is conditional on the loan still being active, so a
    // second request — or one racing another — matches no row.
    throw conflict('That loan was settled while this settlement was being recorded.');
  }

  return quote;
}
