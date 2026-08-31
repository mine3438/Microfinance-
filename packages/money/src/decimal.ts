// Named import rather than default: decimal.js ships CommonJS type definitions,
// and under NodeNext resolution a default import of them resolves to the module
// namespace instead of the class.
import { Decimal } from 'decimal.js';

/**
 * A private decimal.js constructor, configured once for this package.
 *
 * `decimal.js` configuration is global to a constructor. Using the default
 * `Decimal` would mean any other dependency calling `Decimal.set()` could
 * silently change the rounding mode or precision that loan schedules and
 * payment allocations are computed with. Cloning gives this package a
 * constructor nobody else holds a reference to.
 *
 * - **precision 40** — far beyond the 15 significant digits `NUMERIC(15,2)`
 *   needs, so intermediate results in amortisation and provisioning never
 *   lose information before the single, explicit rounding at the end.
 * - **ROUND_HALF_UP** — the convention stated in `01-ARCHITECTURE.md` §7.3 and
 *   the one BOT's own template arithmetic assumes.
 * - **toExpNeg / toExpPos pushed out** — so `toString()` never emits
 *   exponential notation. A `NUMERIC` column will not accept `1e+21`, and an
 *   amount rendered to a loan officer as `1.2e+3` is a defect.
 */
export const Dec = Decimal.clone({
  precision: 40,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -40,
  toExpPos: 40,
  modulo: Decimal.ROUND_DOWN,
});

/** Instance type produced by {@link Dec}. */
export type Dec = Decimal;

/** Rounding modes accepted wherever this package rounds. */
export type RoundingMode = Decimal.Rounding;

/** Half-up: the project default, per `01-ARCHITECTURE.md` §7.3. */
export const ROUND_HALF_UP: RoundingMode = Decimal.ROUND_HALF_UP;

/** Truncation toward zero. Used where a floor is wanted, as in allocation. */
export const ROUND_DOWN: RoundingMode = Decimal.ROUND_DOWN;

/**
 * Reject the inputs that quietly destroy precision.
 *
 * A JavaScript `number` cannot represent most decimal fractions exactly:
 * `0.1 + 0.2` is `0.30000000000000004`, and by the time such a value reaches a
 * constructor the damage is already done — there is no way to tell `0.1` from
 * the nearest double to `0.1`. So numbers are refused at the boundary rather
 * than converted.
 *
 * Strings and existing decimals pass through.
 */
export function toDecimal(value: string | Dec, context: string): Dec {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      throw new TypeError(`${context}: expected a numeric string, received an empty string.`);
    }
    let parsed: Dec;
    try {
      parsed = new Dec(trimmed);
    } catch {
      throw new TypeError(`${context}: "${value}" is not a valid decimal number.`);
    }
    if (!parsed.isFinite()) {
      throw new TypeError(`${context}: "${value}" is not finite.`);
    }
    return parsed;
  }

  if (!value.isFinite()) {
    throw new TypeError(`${context}: value is not finite.`);
  }
  return value;
}

/**
 * Guard for values arriving from outside this package with an unknown type.
 *
 * The specific failure this exists to catch: a Postgres driver configured to
 * parse `NUMERIC` with `parseFloat` hands back a `number`, and every balance in
 * the system silently becomes a float. Refusing the type makes that a loud
 * failure at the first read instead of a slow divergence nobody can reconstruct.
 */
export function assertNotFloat(value: unknown, context: string): void {
  if (typeof value === 'number') {
    throw new TypeError(
      `${context}: received a JavaScript number (${String(value)}). ` +
        'Money must never travel as a float — it cannot represent most decimal ' +
        'fractions exactly. Pass a string instead, and check that the database ' +
        'driver returns NUMERIC columns as strings.',
    );
  }
}
