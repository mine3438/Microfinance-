/**
 * Exact-decimal money, rates, and percentages.
 *
 * The one place in the codebase where arithmetic on monetary values is
 * permitted. Every other layer composes these types rather than reaching for
 * `number`, because a JavaScript number is a binary double and cannot hold most
 * decimal fractions exactly — an error that compounds silently across a loan
 * schedule until balances no longer reconcile.
 *
 * Three separate types for three separate quantities:
 *
 * - {@link Money} — an amount, currency-tagged, always at its currency's scale.
 * - {@link Rate} — a periodic interest rate as a fraction (`0.05` = 5% a month).
 * - {@link Percentage} — the same quantity written as people write it (`5`).
 *
 * `Rate` and `Percentage` are deliberately not interchangeable. Mixing them is
 * a hundred-fold error in an interest calculation, and it is a common one, so
 * the compiler is made to catch it.
 *
 * @example
 * ```ts
 * const principal = Money.of('1000000');            // TZS 1,000,000.00
 * const rate = Rate.ofMonthlyFraction('0.05');      // 5% a month
 * const interest = principal.applyRate(rate);       // TZS 50,000.00
 * const schedule = principal.distribute(12);        // sums to exactly the principal
 * ```
 */

export { DEFAULT_CURRENCY, TZS, type Currency } from './currency.js';

export {
  Dec,
  ROUND_DOWN,
  ROUND_HALF_UP,
  assertNotFloat,
  toDecimal,
  type RoundingMode,
} from './decimal.js';

export {
  AllocationError,
  CurrencyMismatchError,
  MoneyError,
  PrecisionError,
  RateRangeError,
} from './errors.js';

export { Money } from './money.js';

export { Percentage } from './percentage.js';

export { DEFAULT_ANNUALISATION, Rate, type AnnualisationConvention } from './rate.js';
