import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * Settling a loan before maturity.
 *
 * The approved rule, in full: the borrower pays **outstanding principal +
 * interest due through the settlement month + all accrued and outstanding
 * penalties**. There is no early-settlement discount, penalties are not waived,
 * and the application/form fee is not part of it — that was handled at
 * application and never became a loan balance.
 *
 * The part that needs stating precisely is the interest.
 *
 * Interest is charged at **month granularity, never prorated by day**. If a
 * loan is settled on any day in August, the whole of August's applicable
 * interest is charged and September onwards is not. Settling on the 1st, the
 * 10th and the 31st therefore produce the same figure — which is the point, and
 * which is why this takes a date and immediately reduces it to a month.
 *
 * Interest *after* the settlement month is simply never charged. It is not
 * forgiven, discounted or written off: the instalments that would have carried
 * it are still in the schedule as history, and no payment ever allocates to
 * them. The quote reports that figure as `interestNotCharged` so a settlement
 * statement can show what the borrower saved by settling early, without anyone
 * having to infer it from a schedule.
 *
 * This is deliberately *not* the ordinary allocator. That one splits a payment
 * against everything a loan owes, and what a loan owes includes the whole
 * remaining scheduled interest. Routing a settlement through it would consume
 * future interest the approved rule says is not charged, and leave principal
 * unpaid.
 */

/** One scheduled instalment, as the quote needs to see it. */
export interface ScheduledInterest {
  /** `YYYY-MM-DD`. */
  readonly dueDate: string;
  readonly interestDue: Money;
}

export interface SettlementQuoteRequest {
  /** The day the borrower settles. Only its month is used. `YYYY-MM-DD`. */
  readonly settlementDate: string;
  /** What is still owed as principal. */
  readonly outstandingPrincipal: Money;
  /** Penalty accrued and unpaid. Payable in full. */
  readonly penaltyOutstanding: Money;
  /** Every instalment's interest, whether or not it has fallen due. */
  readonly schedule: readonly ScheduledInterest[];
  /** Interest the borrower has already paid, across every payment so far. */
  readonly interestAlreadyPaid: Money;
}

export interface SettlementQuote {
  readonly settlementDate: string;
  /** Last day of the settlement month, inclusive. Interest is charged up to here. */
  readonly chargedThrough: string;

  readonly principal: Money;
  /** Interest through the settlement month, less what has already been paid. */
  readonly interest: Money;
  readonly penalty: Money;
  /** What the borrower pays. */
  readonly total: Money;

  /**
   * Scheduled interest falling after the settlement month.
   *
   * Never charged, so never owed. Reported for the settlement statement, not
   * used in the arithmetic.
   */
  readonly interestNotCharged: Money;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Last day of the month a date falls in, as `YYYY-MM-DD`.
 *
 * Day 0 of the following month is the last day of this one, which handles
 * February in a leap year without a table of month lengths.
 */
export function endOfMonth(date: string): string {
  if (!DATE.test(date)) {
    throw new DomainValidationError(`A settlement date must be YYYY-MM-DD, received ${date}.`);
  }

  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));

  if (month < 1 || month > 12) {
    throw new DomainValidationError(`${date} does not name a month.`);
  }

  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${date.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

/**
 * What it costs to settle.
 *
 * @throws {DomainValidationError} when an input cannot produce a quote — a
 * malformed date, or a negative balance, which is a defect upstream rather than
 * something to quote against.
 */
export function quoteSettlement(request: SettlementQuoteRequest): SettlementQuote {
  const chargedThrough = endOfMonth(request.settlementDate);

  if (request.outstandingPrincipal.isNegative()) {
    throw new DomainValidationError(
      `Outstanding principal is negative (${request.outstandingPrincipal.toDatabaseValue()}), ` +
        'which is a defect upstream rather than something to settle.',
    );
  }
  if (request.penaltyOutstanding.isNegative()) {
    throw new DomainValidationError(
      `Penalty outstanding is negative (${request.penaltyOutstanding.toDatabaseValue()}).`,
    );
  }

  const currency = request.outstandingPrincipal.currency;

  const charged: Money[] = [];
  const notCharged: Money[] = [];

  for (const instalment of request.schedule) {
    if (!DATE.test(instalment.dueDate)) {
      throw new DomainValidationError(
        `A schedule due date must be YYYY-MM-DD, received ${instalment.dueDate}.`,
      );
    }
    // String comparison, which is why the format is checked. Both are
    // zero-padded ISO dates, so lexical order is chronological order.
    if (instalment.dueDate <= chargedThrough) {
      charged.push(instalment.interestDue);
    } else {
      notCharged.push(instalment.interestDue);
    }
  }

  const interestChargeable = Money.sum(charged, currency);

  // Floored at zero rather than allowed negative. A borrower who has paid more
  // interest than the settlement month's instalments carry is ahead, not owed
  // money back — and a negative interest component would silently reduce the
  // principal they still owe.
  const interest = Money.max(
    interestChargeable.minus(request.interestAlreadyPaid),
    Money.zero(currency),
  );

  const total = Money.sum(
    [request.outstandingPrincipal, interest, request.penaltyOutstanding],
    currency,
  );

  return {
    settlementDate: request.settlementDate,
    chargedThrough,
    principal: request.outstandingPrincipal,
    interest,
    penalty: request.penaltyOutstanding,
    total,
    interestNotCharged: Money.sum(notCharged, currency),
  };
}
