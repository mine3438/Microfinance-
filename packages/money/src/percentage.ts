import { Dec, toDecimal, assertNotFloat } from './decimal.js';

/**
 * A percentage, held the way people write it: `5` means five percent.
 *
 * Kept distinct from {@link Rate}, which holds the same quantity as a fraction
 * (`0.05`). The two are trivially interconvertible and constantly confused, and
 * mistaking one for the other is a hundred-fold error in an interest
 * calculation. Making them separate types means the compiler catches it.
 */
export class Percentage {
  private readonly value: Dec;

  private constructor(value: Dec) {
    this.value = value;
  }

  /** Build from a percentage figure: `Percentage.of('5')` is five percent. */
  public static of(value: string | Dec): Percentage {
    assertNotFloat(value, 'Percentage.of');
    return new Percentage(toDecimal(value, 'Percentage.of'));
  }

  /** Build from a fraction: `Percentage.fromFraction('0.05')` is five percent. */
  public static fromFraction(fraction: string | Dec): Percentage {
    assertNotFloat(fraction, 'Percentage.fromFraction');
    return new Percentage(toDecimal(fraction, 'Percentage.fromFraction').times(100));
  }

  /** Zero percent. */
  public static zero(): Percentage {
    return new Percentage(new Dec(0));
  }

  /** This percentage as a fraction: five percent becomes `0.05`. */
  public toFraction(): Dec {
    return this.value.dividedBy(100);
  }

  /** The underlying figure, e.g. `5` for five percent. */
  public toDecimal(): Dec {
    return this.value;
  }

  public isZero(): boolean {
    return this.value.isZero();
  }

  public isNegative(): boolean {
    return this.value.isNegative() && !this.value.isZero();
  }

  public equals(other: Percentage): boolean {
    return this.value.equals(other.value);
  }

  public lessThan(other: Percentage): boolean {
    return this.value.lessThan(other.value);
  }

  public greaterThan(other: Percentage): boolean {
    return this.value.greaterThan(other.value);
  }

  /**
   * Round to `decimalPlaces` for reporting.
   *
   * BOT's MSP2-04 reports rates to a fixed number of places; this is where that
   * rounding happens, rather than silently during arithmetic.
   */
  public toFixed(decimalPlaces: number): string {
    return this.value.toFixed(decimalPlaces);
  }

  /** Unrounded decimal string, e.g. `"5"` or `"60"`. Never exponential. */
  public toString(): string {
    return this.value.toFixed();
  }

  public toJSON(): string {
    return this.toString();
  }
}
