/**
 * Currency, carried on every {@link Money} value.
 *
 * Every amount this system stores is Tanzanian shillings — BOT's forms are
 * denominated in TZS throughout, and MSP2-07's foreign-currency column asks for
 * the *TZS equivalent* rather than the original currency. So this is not
 * multi-currency support, which nothing in the documentation calls for.
 *
 * It exists because a currency tag costs almost nothing and removes a whole
 * class of defect: adding two amounts that are not in the same unit becomes a
 * thrown error rather than a plausible-looking wrong number.
 */
export interface Currency {
  /** ISO 4217 alphabetic code. */
  readonly code: string;
  /** Decimal places the currency is stored and reported to. */
  readonly scale: number;
}

/**
 * Tanzanian shilling.
 *
 * Scale 2 because every BOT MSP2 form states "Amount in TZS 0.00", and the
 * schema stores money as `NUMERIC(15,2)`.
 */
export const TZS: Currency = Object.freeze({ code: 'TZS', scale: 2 });

/** The currency used when none is given. */
export const DEFAULT_CURRENCY = TZS;
