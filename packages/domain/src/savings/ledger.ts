import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * The savings ledger's arithmetic.
 *
 * Deliberately small, because §13.4 has not been answered: there is no interest
 * rate basis, no accrual frequency, no minimum balance and no withdrawal limit
 * here, and inventing any of them would put a fabricated figure on a client's
 * statement. A balance is what was paid in less what was taken out, and nothing
 * else happens to it.
 *
 * One rule is enforced anyway, and it is not a product decision. **A balance
 * cannot go negative.** A negative savings balance is an overdraft — a lending
 * product this institution does not offer — and a withdrawal that created one
 * would turn money owed *to* a client into money owed *by* them, which is the
 * wrong side of MSP2-01. Whether a client may draw their compulsory savings
 * down to nothing while a loan is outstanding is a different question, and that
 * one is §13.4's.
 */

export const SAVINGS_DIRECTIONS = ['deposit', 'withdrawal'] as const;

export type SavingsDirection = (typeof SAVINGS_DIRECTIONS)[number];

/** One movement on one account. */
export interface SavingsEntry {
  readonly direction: SavingsDirection;
  readonly amount: Money;
  /** `YYYY-MM-DD`. What makes an as-at-quarter-end balance answerable. */
  readonly transactionDate: string;
}

/** The signed effect of an entry: deposits add, withdrawals subtract. */
export function signedAmount(entry: SavingsEntry): Money {
  return entry.direction === 'deposit' ? entry.amount : entry.amount.negated();
}

/**
 * Apply an entry to a balance.
 *
 * @throws {DomainValidationError} when a withdrawal exceeds the balance.
 */
export function applyEntry(balance: Money, entry: SavingsEntry): Money {
  if (!entry.amount.isPositive()) {
    throw new DomainValidationError(
      'A savings entry must move a positive amount. A deposit of nothing is not a deposit, and ' +
        'a correction is a reversing entry rather than a negative one.',
    );
  }

  const next = balance.plus(signedAmount(entry));

  if (next.isNegative()) {
    throw new DomainValidationError(
      `This withdrawal is ${entry.amount.toDatabaseValue()} against a balance of ` +
        `${balance.toDatabaseValue()}. A savings account cannot go overdrawn.`,
    );
  }

  return next;
}

/**
 * The balance a sequence of entries produces, in date order.
 *
 * Used to restate a past quarter: the same entries, read to a different date,
 * give the balance that date had. Nothing is carried forward from a stored
 * figure, which is the same discipline MSP2-06's roll-forward follows.
 */
export function balanceAsAt(entries: readonly SavingsEntry[], asAt: string): Money {
  const upTo = entries.filter((entry) => entry.transactionDate <= asAt);
  return Money.sum(upTo.map(signedAmount));
}

/**
 * The entry that undoes another.
 *
 * Same amount, opposite direction, and dated when the correction is made rather
 * than when the mistake was — a reversal backdated onto a filed quarter would
 * change a figure BOT has already been given.
 */
export function reversalOf(entry: SavingsEntry, reversedOn: string): SavingsEntry {
  return {
    direction: entry.direction === 'deposit' ? 'withdrawal' : 'deposit',
    amount: entry.amount,
    transactionDate: reversedOn,
  };
}
