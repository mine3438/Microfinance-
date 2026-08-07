import type { Currency } from './currency.js';

/** Base class so callers can catch every monetary failure with one clause. */
export class MoneyError extends Error {
  public override readonly name: string = 'MoneyError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * An operation combined amounts in different currencies.
 *
 * Never a recoverable condition: the two values do not denote comparable
 * quantities, so there is no sensible result to return.
 */
export class CurrencyMismatchError extends MoneyError {
  public override readonly name = 'CurrencyMismatchError';

  public constructor(
    public readonly left: Currency,
    public readonly right: Currency,
  ) {
    super(
      `Cannot combine ${left.code} with ${right.code}. ` +
        'Amounts in different currencies are not comparable.',
    );
  }
}

/**
 * A value carried more decimal places than its currency stores.
 *
 * Raised by the exact constructor rather than rounding silently. Rounding is a
 * decision with a monetary consequence, so it is spelled out at the call site
 * via `Money.round` instead of happening implicitly.
 */
export class PrecisionError extends MoneyError {
  public override readonly name = 'PrecisionError';

  public constructor(
    public readonly value: string,
    public readonly currency: Currency,
  ) {
    super(
      `Value ${value} has more precision than ${currency.code} stores ` +
        `(${String(currency.scale)} decimal places). ` +
        'Use Money.round() to round explicitly, or supply an exact value.',
    );
  }
}

/** An allocation was requested against weights that cannot produce a result. */
export class AllocationError extends MoneyError {
  public override readonly name = 'AllocationError';

  public constructor(message: string) {
    super(message);
  }
}

/** A rate or percentage fell outside the range the schema can store. */
export class RateRangeError extends MoneyError {
  public override readonly name = 'RateRangeError';

  public constructor(message: string) {
    super(message);
  }
}
