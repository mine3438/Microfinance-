import { z } from 'zod';

/**
 * Shared primitives every context's schemas are built from.
 *
 * This module holds no `@mfi/money` import, and that is a decision rather than
 * an omission. Contracts are consumed by the browser bundle, and the frontend
 * must never compute money (§2 — it calls preview endpoints that run the same
 * code the write path runs). Validating the *wire format* of an amount needs no
 * arithmetic library; constructing a `Money` does. Keeping the arithmetic out
 * of this package means it cannot be reached for on the client by accident.
 */

/**
 * Reject a JavaScript number where a decimal string is required.
 *
 * The default message ("expected string, received number") states what happened
 * without saying why it matters. `0.1 + 0.2` is not `0.3` in a double, and a
 * number that reaches JSON has already lost whatever precision it lost — by the
 * time the server sees `1234567890123.45` as a `number`, the damage is done and
 * is not detectable. So the refusal explains itself.
 */
const decimalStringType = (subject: string): z.ZodString =>
  z.string({
    error: (issue) =>
      issue.input === undefined
        ? `${subject} is required.`
        : `${subject} must be sent as a string, not a number. JSON numbers are binary ` +
          'doubles and cannot hold decimal fractions exactly, so the value would already ' +
          'be wrong by the time it arrived.',
  });

/**
 * A monetary amount as it travels.
 *
 * `NUMERIC(15,2)` at rest, so at most thirteen digits before the point and
 * exactly zero, one or two after it. Canonical form only: no leading zeros, no
 * thousands separators, no currency symbol, no exponent, no `-0`. A single
 * accepted spelling per value means two requests for the same amount produce
 * the same bytes, which is what makes idempotency keys and audit comparisons
 * meaningful.
 *
 * The currency is not carried per-amount. Every figure in this system is TZS
 * (`currency.ts` in `@mfi/money` explains why), so a currency field on the wire
 * would be a value the server ignores or a value it must reject — both worse
 * than its absence.
 */
export const MONEY_PATTERN = /^-?(?:0|[1-9]\d{0,12})(?:\.\d{1,2})?$/;

export const moneyAmountSchema = decimalStringType('A monetary amount')
  .regex(
    MONEY_PATTERN,
    'Must be a decimal amount with at most 13 digits before the point and 2 after it, ' +
      'written plainly — "1500000" or "1500000.50", not "1,500,000" or "1.5e6".',
  )
  .refine((value) => !/^-0(?:\.00?)?$/.test(value), {
    error: 'Negative zero is not a distinct amount. Write "0".',
  });

/** A monetary amount that must be strictly greater than zero. */
export const positiveMoneyAmountSchema = moneyAmountSchema.refine(
  (value) => !value.startsWith('-') && /[1-9]/.test(value),
  { error: 'Must be greater than zero.' },
);

/** A monetary amount that must not be negative. Zero is permitted. */
export const nonNegativeMoneyAmountSchema = moneyAmountSchema.refine(
  (value) => !value.startsWith('-'),
  { error: 'Must not be negative.' },
);

/**
 * A periodic interest rate as a fraction: `0.05` is five percent per period.
 *
 * `NUMERIC(6,4)` at rest — four decimal places, matching `Rate` in
 * `@mfi/money`. Rates are never negative: a lender charging negative interest
 * is paying the borrower to borrow, which no documented product does, and
 * accepting it here would let a typo become one.
 */
export const RATE_PATTERN = /^(?:0|[1-9]\d?)(?:\.\d{1,4})?$/;

export const rateFractionSchema = decimalStringType('A rate').regex(
  RATE_PATTERN,
  'Must be a non-negative decimal fraction with at most 4 decimal places — ' +
    '"0.05" for five percent per period.',
);

/**
 * A percentage as people write it: `5` is five percent.
 *
 * Deliberately a different schema from {@link rateFractionSchema} even though
 * both are decimal strings. Confusing the two is a hundred-fold error in an
 * interest calculation, and `@mfi/money` keeps `Rate` and `Percentage` as
 * separate types for exactly that reason. Sharing one schema here would undo
 * that at the boundary where the value is least checked.
 */
export const percentageSchema = decimalStringType('A percentage').regex(
  /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/,
  'Must be a non-negative decimal with at most 4 decimal places — "5" for five percent.',
);

/**
 * A UUID identifier.
 *
 * Not narrowed to version 7. The schema generates v7 for new rows because of
 * its index locality, but that is a storage decision; a client that received an
 * identifier should be able to send it back whatever its version, and a future
 * migration that changes generators must not invalidate identifiers already
 * issued.
 */
export const uuidSchema = z.uuid({ error: 'Must be a UUID.' });

/**
 * An email address.
 *
 * Deliberately permissive, and lowercased on the way in. Over-strict email
 * validation rejects addresses that genuinely deliver, and this system's users
 * are staff at institutions whose mail is configured by someone else. The
 * authoritative test of an address is whether the verification mail arrives.
 *
 * Lowercasing matches `users_email_unique`, which indexes `lower(email)` — so
 * `A@x.com` and `a@x.com` are one account here and one row there.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Must be an email address.' }).max(254));

/**
 * A calendar date with no time and no zone: `2026-03-31`.
 *
 * Reporting periods, dates of birth and instalment due dates are all calendar
 * facts. Sending them as timestamps invites a zone conversion to move a due
 * date across midnight into a different quarter, which on a BOT return is a
 * misfiling rather than an off-by-one.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a calendar date in YYYY-MM-DD form.')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  }, 'Must be a date that exists.');

/** An instant, always UTC, always with the offset written out. */
export const isoTimestampSchema = z.iso.datetime({
  offset: false,
  error: 'Must be an ISO-8601 timestamp in UTC, ending in Z.',
});

/** Free text that must contain something other than whitespace. */
export const requiredTextSchema = (maximumLength: number): z.ZodString =>
  z.string().trim().min(1, 'Must not be blank.').max(maximumLength);

/**
 * Order two decimal strings exactly.
 *
 * A range check — "the maximum principal cannot be below the minimum" — needs
 * to compare two amounts, and the obvious spelling is
 * `Number(a) >= Number(b)`.
 *
 * That spelling happens to be correct today, and the honesty is the point:
 * {@link MONEY_PATTERN} admits at most thirteen digits before the point and two
 * after, so every amount this system accepts is under 10^13 while doubles are
 * exact to 2^53 ≈ 9 × 10^15 — no two distinct amounts collapse onto one double,
 * and no two rates do either. It is not a latent bug being fixed here.
 *
 * It is correct *by accident of the current column width*, which is the problem.
 * Nothing records the dependency, and the day `NUMERIC(15,2)` widens — or this
 * comparison is copied somewhere a value is not so bounded — it becomes wrong
 * silently, admitting a product whose maximum principal is below its minimum
 * because two different figures compared equal. The standing rule is that money
 * does not pass through a binary double, and a rule with a case-by-case
 * exemption for "this width is safe" is not a rule anyone can apply.
 *
 * So the comparison is done on the digits. This is not arithmetic and does not
 * reach for `@mfi/money` — the module comment above explains why that import
 * must not appear here — it is two strings that {@link MONEY_PATTERN} or
 * {@link RATE_PATTERN} has already shown to be canonical decimals, compared
 * place by place.
 *
 * @returns a negative number if `left` sorts before `right`, zero if they are
 *   the same value, a positive number otherwise.
 */
export function compareDecimalStrings(left: string, right: string): number {
  const leftNegative = left.startsWith('-');
  const rightNegative = right.startsWith('-');

  if (leftNegative !== rightNegative) {
    return leftNegative ? -1 : 1;
  }

  const magnitude = compareMagnitudes(
    leftNegative ? left.slice(1) : left,
    rightNegative ? right.slice(1) : right,
  );

  // Both negative reverses the order: -2 sorts before -1 while 2 sorts after 1.
  return leftNegative ? -magnitude : magnitude;
}

/** Compare two unsigned canonical decimals, integer part first. */
function compareMagnitudes(left: string, right: string): number {
  const [leftWhole = '', leftFraction = ''] = left.split('.');
  const [rightWhole = '', rightFraction = ''] = right.split('.');

  // Canonical form carries no leading zeros, so a longer integer part is a
  // larger number and only equal lengths need comparing digit by digit.
  if (leftWhole.length !== rightWhole.length) {
    return leftWhole.length - rightWhole.length;
  }
  if (leftWhole !== rightWhole) {
    return leftWhole < rightWhole ? -1 : 1;
  }

  // Trailing zeros are significant to string comparison but not to value, so
  // both fractions are padded to the same width before being compared.
  const width = Math.max(leftFraction.length, rightFraction.length);
  const paddedLeft = leftFraction.padEnd(width, '0');
  const paddedRight = rightFraction.padEnd(width, '0');

  if (paddedLeft === paddedRight) {
    return 0;
  }
  return paddedLeft < paddedRight ? -1 : 1;
}
