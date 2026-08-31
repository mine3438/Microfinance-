import { DomainValidationError } from '../errors.js';

/**
 * Tanzanian country calling code.
 */
const COUNTRY_CODE = '255';

/**
 * Tanzanian mobile prefixes, after the leading zero or country code.
 *
 * Every mobile network operator in Tanzania issues subscriber numbers beginning
 * 6 or 7, followed by eight further digits. The schema reference described the
 * previous system as validating `07xxxxxxxx` only — which rejects every 06
 * number, a large and growing share of the market.
 */
const MOBILE_PREFIX = /^[67]\d{8}$/;

/** E.164 form: `+255` followed by nine digits. */
const E164 = /^\+255[67]\d{8}$/;

/**
 * A Tanzanian mobile number, held in one canonical form.
 *
 * The previous system stored whatever the user typed and checked the format in
 * the browser only. The consequence was not cosmetic: the same person could
 * exist twice, as `0712345678` and as `+255712345678`, with two client codes
 * and two loan histories that no report would ever reconcile.
 *
 * Everything is normalised to E.164 on the way in, and the database enforces
 * the same shape with a CHECK constraint, so a direct write cannot bypass it.
 */
export class PhoneNumber {
  private readonly value: string;

  private constructor(value: string) {
    this.value = value;
  }

  /**
   * Parse any of the forms Tanzanian users actually type.
   *
   * Accepts `0712345678`, `+255712345678`, `255712345678`, and any of those
   * with spaces, hyphens or brackets. Rejects landlines and anything that is
   * not a mobile number, because a borrower who cannot be reached on the number
   * recorded is a collections problem.
   *
   * @throws {DomainValidationError} when the number is not a Tanzanian mobile.
   */
  public static parse(input: string): PhoneNumber {
    const digitsOnly = input.replace(/[\s\-().]/g, '');

    if (digitsOnly === '') {
      throw new DomainValidationError('Phone number is required.');
    }

    let subscriber: string;

    if (digitsOnly.startsWith(`+${COUNTRY_CODE}`)) {
      subscriber = digitsOnly.slice(`+${COUNTRY_CODE}`.length);
    } else if (digitsOnly.startsWith(COUNTRY_CODE) && digitsOnly.length === 12) {
      subscriber = digitsOnly.slice(COUNTRY_CODE.length);
    } else if (digitsOnly.startsWith('0')) {
      subscriber = digitsOnly.slice(1);
    } else {
      throw new DomainValidationError(
        `"${input}" is not a recognised Tanzanian number. ` +
          'Expected 0712345678, +255712345678, or 255712345678.',
      );
    }

    if (!MOBILE_PREFIX.test(subscriber)) {
      throw new DomainValidationError(
        `"${input}" is not a Tanzanian mobile number. ` +
          'Mobile subscriber numbers begin 6 or 7 and are nine digits long.',
      );
    }

    return new PhoneNumber(`+${COUNTRY_CODE}${subscriber}`);
  }

  /** Whether a string parses, without throwing. */
  public static isValid(input: string): boolean {
    try {
      PhoneNumber.parse(input);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a value already stored in canonical form.
   *
   * Distinct from {@link parse}: this asserts the invariant rather than
   * establishing it, so a value that somehow reached storage in the wrong shape
   * surfaces as an error instead of being quietly re-normalised.
   */
  public static fromDatabaseValue(value: string): PhoneNumber {
    if (!E164.test(value)) {
      throw new DomainValidationError(
        `Stored phone number "${value}" is not in E.164 form. ` +
          'Values are normalised on write, so this indicates a write that bypassed the domain.',
      );
    }
    return new PhoneNumber(value);
  }

  /** Canonical E.164, as stored: `+255712345678`. */
  public toDatabaseValue(): string {
    return this.value;
  }

  /** How Tanzanians read a number aloud: `0712 345 678`. */
  public toLocalFormat(): string {
    const subscriber = this.value.slice(`+${COUNTRY_CODE}`.length);
    return `0${subscriber.slice(0, 3)} ${subscriber.slice(3, 6)} ${subscriber.slice(6)}`;
  }

  public equals(other: PhoneNumber): boolean {
    return this.value === other.value;
  }

  public toString(): string {
    return this.value;
  }

  public toJSON(): string {
    return this.value;
  }
}
