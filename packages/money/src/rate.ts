import { Dec, toDecimal, assertNotFloat } from './decimal.js';
import { RateRangeError } from './errors.js';
import { Percentage } from './percentage.js';

/** Months in a year. Named because it appears in annualisation as a unit, not a magic number. */
const MONTHS_PER_YEAR = 12;

/**
 * Maximum decimal places a rate may carry.
 *
 * The schema stores `monthly_rate NUMERIC(6,4)`. A rate with more precision
 * than that would be silently rounded on write, so it is refused on
 * construction instead.
 */
const MAX_RATE_SCALE = 4;

/** Exclusive upper bound implied by `NUMERIC(6,4)`: six digits, four after the point. */
const MAX_RATE_VALUE = 100;

/**
 * How a monthly rate is expressed as an annual one.
 *
 * `02-BOT-REPORTING-SPEC.md` §11.2 records this as an open question: MSP2-04
 * wants "% p.a." and the system stores a monthly figure, but BOT's template
 * does not state which convention it expects. At microfinance rates the two
 * diverge sharply — 5% monthly is 60% simple or 79.586% effective — so the
 * choice is configuration to be confirmed against an accepted filing, not a
 * constant to bury in code.
 *
 * - `simple` — `monthly × 12`. Matches the column header's wording, "Nominal
 *   Interest Rate (% p.a.)"; *nominal* is the term of art for this convention.
 * - `effective` — `(1 + monthly)^12 − 1`. The true annualised cost, including
 *   the compounding effect of monthly periods.
 */
export type AnnualisationConvention = 'simple' | 'effective';

/**
 * The convention applied when a caller does not name one.
 *
 * Recorded in `01-ARCHITECTURE.md` §16.1 as pending verification against a
 * previously accepted BOT filing. Changing it is a one-line change here, and
 * every rate in every report follows.
 */
export const DEFAULT_ANNUALISATION: AnnualisationConvention = 'simple';

/**
 * A periodic interest rate, held as a fraction: `0.05` is five percent a month.
 *
 * Monthly because that is the period the schema stores and the period MFIs
 * quote to borrowers. Annual figures are derived for reporting only — see
 * {@link toAnnualPercentage}.
 */
export class Rate {
  private readonly fraction: Dec;

  private constructor(fraction: Dec) {
    this.fraction = fraction;
  }

  /**
   * Build from a monthly fraction: `Rate.ofMonthlyFraction('0.05')` is 5% a month.
   *
   * Zero is permitted. Whether a *loan product* may carry a zero rate is a
   * lending rule — the schema's `CHECK (monthly_rate > 0)` says no today, and
   * `01-ARCHITECTURE.md` §13.8 has it as an open question — but that belongs
   * to the loan, not to the concept of a rate.
   */
  public static ofMonthlyFraction(value: string | Dec): Rate {
    assertNotFloat(value, 'Rate.ofMonthlyFraction');
    const fraction = toDecimal(value, 'Rate.ofMonthlyFraction');

    if (fraction.isNegative()) {
      throw new RateRangeError(`Rate cannot be negative: received ${fraction.toFixed()}.`);
    }
    if (fraction.decimalPlaces() > MAX_RATE_SCALE) {
      throw new RateRangeError(
        `Rate ${fraction.toFixed()} has ${String(fraction.decimalPlaces())} decimal places; ` +
          `the schema stores NUMERIC(6,4), which holds ${String(MAX_RATE_SCALE)}. ` +
          'Round the rate before constructing it, so the loss is deliberate.',
      );
    }
    if (fraction.greaterThanOrEqualTo(MAX_RATE_VALUE)) {
      throw new RateRangeError(
        `Rate ${fraction.toFixed()} is too large to store as NUMERIC(6,4) ` +
          `(maximum ${String(MAX_RATE_VALUE)}, exclusive).`,
      );
    }

    return new Rate(fraction);
  }

  /** Build from a monthly percentage: `Rate.ofMonthlyPercentage(Percentage.of('5'))`. */
  public static ofMonthlyPercentage(percentage: Percentage): Rate {
    return Rate.ofMonthlyFraction(percentage.toFraction());
  }

  /** A zero rate. */
  public static zero(): Rate {
    return new Rate(new Dec(0));
  }

  /** The monthly rate as a fraction, e.g. `0.05`. This is what multiplies a balance. */
  public monthlyFraction(): Dec {
    return this.fraction;
  }

  /** The monthly rate as a percentage, e.g. `5`. */
  public toMonthlyPercentage(): Percentage {
    return Percentage.fromFraction(this.fraction);
  }

  /**
   * The annual rate as a percentage, for MSP2-04.
   *
   * @param convention Which annualisation to apply. Defaults to
   * {@link DEFAULT_ANNUALISATION}; see {@link AnnualisationConvention} for why
   * this is configurable rather than fixed.
   */
  public toAnnualPercentage(
    convention: AnnualisationConvention = DEFAULT_ANNUALISATION,
  ): Percentage {
    switch (convention) {
      case 'simple':
        return Percentage.fromFraction(this.fraction.times(MONTHS_PER_YEAR));
      case 'effective': {
        const compounded = this.fraction.plus(1).toPower(MONTHS_PER_YEAR).minus(1);
        return Percentage.fromFraction(compounded);
      }
    }
  }

  public isZero(): boolean {
    return this.fraction.isZero();
  }

  public equals(other: Rate): boolean {
    return this.fraction.equals(other.fraction);
  }

  public lessThan(other: Rate): boolean {
    return this.fraction.lessThan(other.fraction);
  }

  public greaterThan(other: Rate): boolean {
    return this.fraction.greaterThan(other.fraction);
  }

  /** Exactly as stored: four decimal places, matching `NUMERIC(6,4)`. */
  public toDatabaseValue(): string {
    return this.fraction.toFixed(MAX_RATE_SCALE);
  }

  /** Unrounded decimal string, e.g. `"0.05"`. Never exponential. */
  public toString(): string {
    return this.fraction.toFixed();
  }

  public toJSON(): string {
    return this.toString();
  }
}
