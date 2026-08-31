import { DEFAULT_CURRENCY, type Currency } from './currency.js';
import { Dec, ROUND_HALF_UP, assertNotFloat, toDecimal, type RoundingMode } from './decimal.js';
import { AllocationError, CurrencyMismatchError, PrecisionError } from './errors.js';
import type { Percentage } from './percentage.js';
import type { Rate } from './rate.js';

/**
 * An exact monetary amount.
 *
 * Immutable, currency-tagged, and always held at exactly its currency's scale —
 * two decimal places for TZS. Every operation returns a new instance; nothing
 * mutates.
 *
 * **Why a class rather than a number.** A JavaScript `number` is a binary
 * double and cannot represent most decimal fractions: `0.1 + 0.2` is
 * `0.30000000000000004`. Over a loan schedule those errors accumulate into
 * balances that do not reconcile, and in a regulated lender an unreconcilable
 * balance is a finding. This type makes the exact representation the only one
 * available.
 *
 * **Rounding is always explicit.** The exact constructor refuses a value with
 * more precision than the currency stores; {@link Money.round} is the way to
 * round, and it has to be written out. Multiplication rounds to scale — use
 * {@link timesExact} to keep full precision through intermediate steps of an
 * amortisation and round once at the end.
 */
export class Money {
  private readonly amount: Dec;
  public readonly currency: Currency;

  private constructor(amount: Dec, currency: Currency) {
    this.amount = amount;
    this.currency = currency;
  }

  // ── Construction ──────────────────────────────────────────────────────────

  /**
   * An exact amount. Throws if it carries more precision than the currency holds.
   *
   * @throws {PrecisionError} when `value` has more decimal places than the scale.
   */
  public static of(value: string | Dec, currency: Currency = DEFAULT_CURRENCY): Money {
    assertNotFloat(value, 'Money.of');
    const amount = toDecimal(value, 'Money.of');
    if (amount.decimalPlaces() > currency.scale) {
      throw new PrecisionError(amount.toFixed(), currency);
    }
    return new Money(amount, currency);
  }

  /**
   * Round to the currency's scale.
   *
   * Half-up by default, the convention in `01-ARCHITECTURE.md` §7.3.
   */
  public static round(
    value: string | Dec,
    currency: Currency = DEFAULT_CURRENCY,
    rounding: RoundingMode = ROUND_HALF_UP,
  ): Money {
    assertNotFloat(value, 'Money.round');
    const amount = toDecimal(value, 'Money.round');
    return new Money(amount.toDecimalPlaces(currency.scale, rounding), currency);
  }

  /** Zero. */
  public static zero(currency: Currency = DEFAULT_CURRENCY): Money {
    return new Money(new Dec(0), currency);
  }

  /**
   * Read a value that came out of the database.
   *
   * Postgres returns `NUMERIC` as a string by default, and this system depends
   * on that: a driver reconfigured to parse it with `parseFloat` would turn
   * every balance into a double. Passing a `number` here therefore throws
   * rather than converts, so the misconfiguration surfaces at the first read
   * instead of as a slow divergence nobody can reconstruct.
   *
   * `null` and `undefined` are rejected too — a nullable money column needs the
   * caller to decide what absence means, which is not always zero.
   */
  public static fromDatabaseValue(value: unknown, currency: Currency = DEFAULT_CURRENCY): Money {
    assertNotFloat(value, 'Money.fromDatabaseValue');
    if (value === null || value === undefined) {
      throw new TypeError(
        'Money.fromDatabaseValue: received null or undefined. Handle absence explicitly ' +
          'at the call site — an absent amount is not automatically zero.',
      );
    }
    if (typeof value !== 'string') {
      throw new TypeError(
        `Money.fromDatabaseValue: expected a string from the driver, received ${typeof value}.`,
      );
    }
    // Postgres emits NUMERIC(15,2) as e.g. "1234.56"; already at scale.
    return Money.round(value, currency);
  }

  // ── Arithmetic ────────────────────────────────────────────────────────────

  public plus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.plus(other.amount), this.currency);
  }

  public minus(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.amount.minus(other.amount), this.currency);
  }

  public negated(): Money {
    return new Money(this.amount.negated(), this.currency);
  }

  public abs(): Money {
    return new Money(this.amount.abs(), this.currency);
  }

  /**
   * Multiply, rounding the result to the currency's scale.
   *
   * Each call rounds, so chaining compounds the rounding. Where several
   * multiplications feed one result — an amortisation schedule, a provisioning
   * calculation — use {@link timesExact} throughout and round once at the end.
   */
  public times(factor: string | Dec, rounding: RoundingMode = ROUND_HALF_UP): Money {
    assertNotFloat(factor, 'Money.times');
    const product = this.amount.times(toDecimal(factor, 'Money.times'));
    return new Money(product.toDecimalPlaces(this.currency.scale, rounding), this.currency);
  }

  /** Multiply without rounding, for intermediate steps. */
  public timesExact(factor: string | Dec): Dec {
    assertNotFloat(factor, 'Money.timesExact');
    return this.amount.times(toDecimal(factor, 'Money.timesExact'));
  }

  /** Divide, rounding the result to the currency's scale. */
  public dividedBy(divisor: string | Dec, rounding: RoundingMode = ROUND_HALF_UP): Money {
    assertNotFloat(divisor, 'Money.dividedBy');
    const decimalDivisor = toDecimal(divisor, 'Money.dividedBy');
    if (decimalDivisor.isZero()) {
      throw new RangeError('Money.dividedBy: division by zero.');
    }
    const quotient = this.amount.dividedBy(decimalDivisor);
    return new Money(quotient.toDecimalPlaces(this.currency.scale, rounding), this.currency);
  }

  /** Divide without rounding, for intermediate steps. */
  public dividedByExact(divisor: string | Dec): Dec {
    assertNotFloat(divisor, 'Money.dividedByExact');
    const decimalDivisor = toDecimal(divisor, 'Money.dividedByExact');
    if (decimalDivisor.isZero()) {
      throw new RangeError('Money.dividedByExact: division by zero.');
    }
    return this.amount.dividedBy(decimalDivisor);
  }

  /** One period's interest at `rate`, rounded to scale. */
  public applyRate(rate: Rate, rounding: RoundingMode = ROUND_HALF_UP): Money {
    return this.times(rate.monthlyFraction(), rounding);
  }

  /** One period's interest at `rate`, unrounded. */
  public applyRateExact(rate: Rate): Dec {
    return this.amount.times(rate.monthlyFraction());
  }

  /** This amount scaled by a percentage, rounded to scale. */
  public applyPercentage(percentage: Percentage, rounding: RoundingMode = ROUND_HALF_UP): Money {
    return this.times(percentage.toFraction(), rounding);
  }

  // ── Splitting ─────────────────────────────────────────────────────────────

  /**
   * Split across `weights` so the parts sum to exactly this amount.
   *
   * Uses largest-remainder: each part gets its floor share, then the leftover
   * minor units go one at a time to the parts with the largest discarded
   * fraction. Naively rounding each share independently would lose or invent
   * cents — over a repayment schedule that is the difference between a loan
   * closing at zero and closing owing 3 shillings forever.
   *
   * Ties go to the earlier weight, so the result is deterministic and a
   * schedule regenerated from the same inputs is byte-identical.
   */
  public allocate(weights: readonly (string | Dec)[]): Money[] {
    if (weights.length === 0) {
      throw new AllocationError('Money.allocate: at least one weight is required.');
    }

    const decimalWeights = weights.map((weight, index) => {
      assertNotFloat(weight, `Money.allocate: weight at index ${String(index)}`);
      const value = toDecimal(weight, `Money.allocate: weight at index ${String(index)}`);
      if (value.isNegative()) {
        throw new AllocationError(
          `Money.allocate: weight at index ${String(index)} is negative (${value.toFixed()}).`,
        );
      }
      return value;
    });

    const totalWeight = decimalWeights.reduce((sum, weight) => sum.plus(weight), new Dec(0));
    if (totalWeight.isZero()) {
      throw new AllocationError('Money.allocate: weights sum to zero, so no split is defined.');
    }

    // Work in whole minor units, in absolute value, so flooring behaves the
    // same for negative amounts as positive ones.
    const isNegative = this.amount.isNegative();
    const scaleFactor = new Dec(10).toPower(this.currency.scale);
    const totalUnits = this.amount.abs().times(scaleFactor);

    const exactShares = decimalWeights.map((weight) =>
      totalUnits.times(weight).dividedBy(totalWeight),
    );
    const flooredShares = exactShares.map((share) => share.floor());
    const distributed = flooredShares.reduce((sum, share) => sum.plus(share), new Dec(0));

    let remainder = totalUnits.minus(distributed);

    // Order by discarded fraction, largest first; earlier index wins a tie.
    const order = exactShares
      .map((share, index) => ({ index, fraction: share.minus(share.floor()) }))
      .sort((a, b) => {
        const byFraction = b.fraction.comparedTo(a.fraction);
        return byFraction === 0 ? a.index - b.index : byFraction;
      });

    const finalUnits = [...flooredShares];
    for (const { index } of order) {
      if (remainder.lessThanOrEqualTo(0)) {
        break;
      }
      const current = finalUnits[index];
      /* c8 ignore next 3 -- index comes from a map over the same array */
      if (current === undefined) {
        throw new AllocationError(`Money.allocate: internal index ${String(index)} out of range.`);
      }
      finalUnits[index] = current.plus(1);
      remainder = remainder.minus(1);
    }

    return finalUnits.map((units) => {
      const value = units.dividedBy(scaleFactor);
      return new Money(isNegative ? value.negated() : value, this.currency);
    });
  }

  /**
   * Split into `parts` as evenly as possible, summing to exactly this amount.
   *
   * `100.00` into three gives `33.34`, `33.33`, `33.33` — never `33.33` three
   * times with a cent unaccounted for.
   */
  public distribute(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts < 1) {
      throw new AllocationError(
        `Money.distribute: parts must be a positive integer, received ${String(parts)}.`,
      );
    }
    return this.allocate(Array.from({ length: parts }, () => '1'));
  }

  // ── Comparison ────────────────────────────────────────────────────────────

  /** Negative, zero, or positive, in the manner of a sort comparator. */
  public compare(other: Money): number {
    this.assertSameCurrency(other);
    return this.amount.comparedTo(other.amount);
  }

  public equals(other: Money): boolean {
    return this.currency.code === other.currency.code && this.amount.equals(other.amount);
  }

  public lessThan(other: Money): boolean {
    return this.compare(other) < 0;
  }

  public lessThanOrEqual(other: Money): boolean {
    return this.compare(other) <= 0;
  }

  public greaterThan(other: Money): boolean {
    return this.compare(other) > 0;
  }

  public greaterThanOrEqual(other: Money): boolean {
    return this.compare(other) >= 0;
  }

  public isZero(): boolean {
    return this.amount.isZero();
  }

  public isPositive(): boolean {
    return this.amount.greaterThan(0);
  }

  public isNegative(): boolean {
    return this.amount.lessThan(0);
  }

  // ── Aggregation ───────────────────────────────────────────────────────────

  /** Total a list. An empty list totals zero in `currency`. */
  public static sum(values: readonly Money[], currency: Currency = DEFAULT_CURRENCY): Money {
    return values.reduce<Money>((total, value) => total.plus(value), Money.zero(currency));
  }

  public static min(left: Money, right: Money): Money {
    return left.lessThan(right) ? left : right;
  }

  public static max(left: Money, right: Money): Money {
    return left.greaterThan(right) ? left : right;
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  /**
   * The value as `NUMERIC(15,2)` expects it: fixed scale, never exponential.
   */
  public toDatabaseValue(): string {
    return this.amount.toFixed(this.currency.scale);
  }

  /** Same fixed-scale form as {@link toDatabaseValue}. */
  public toString(): string {
    return this.toDatabaseValue();
  }

  /**
   * Serialised as a **string**, deliberately.
   *
   * A JSON number is parsed into a double by every JSON parser, so emitting one
   * would undo the exactness this type exists to provide at the first API
   * boundary it crosses.
   */
  public toJSON(): string {
    return this.toDatabaseValue();
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency.code !== other.currency.code) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
