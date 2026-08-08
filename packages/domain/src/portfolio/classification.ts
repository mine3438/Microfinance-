import { Money, Percentage } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * BOT's five classification columns, in MSP2-03's own order.
 *
 * Every loan on the return falls into exactly one. There is no unclassified
 * column, which is why an unclassifiable loan has to be reported as a problem
 * rather than quietly placed somewhere.
 */
export const OVERDUE_CLASSIFICATIONS = [
  'current',
  'esm',
  'substandard',
  'doubtful',
  'loss',
] as const;

export type OverdueClassification = (typeof OVERDUE_CLASSIFICATIONS)[number];

/** The three classes BOT counts as non-performing for the MSP2-03 ratio. */
export const NON_PERFORMING_CLASSIFICATIONS: readonly OverdueClassification[] = Object.freeze([
  'substandard',
  'doubtful',
  'loss',
]);

/** One band of a provisioning schedule, as seeded from BOT's template. */
export interface ProvisioningBand {
  readonly classification: OverdueClassification;
  readonly minDaysOverdue: number;
  /** `null` for the open-ended final band. */
  readonly maxDaysOverdue: number | null;
  readonly provisionRate: Percentage;
}

/** Outcome of classifying a loan. */
export type ClassificationResult =
  | {
      readonly classified: true;
      readonly classification: OverdueClassification;
      readonly provisionRate: Percentage;
    }
  | {
      readonly classified: false;
      readonly reason: 'no_band_covers_days';
      readonly daysOverdue: number;
      readonly message: string;
    };

/**
 * Place a loan in a band by how many days it is past due.
 *
 * Returns a result rather than throwing, because a gap in the schedule is a
 * real and expected outcome for one case: BOT's housing microfinance schedule
 * begins at 91 days and says nothing about a housing loan less overdue than
 * that. `02-BOT-REPORTING-SPEC.md` §11.5 records the question; until it is
 * answered, a housing loan 40 days past due genuinely has no classification
 * BOT has defined.
 *
 * Making that an outcome rather than an exception is deliberate. The gap has to
 * reach an operator — "these loans could not be classified" — instead of being
 * absorbed into `current`, which would understate provisions and file a wrong
 * MSP2-03.
 */
export function classifyByDaysOverdue(
  daysOverdue: number,
  bands: readonly ProvisioningBand[],
): ClassificationResult {
  if (!Number.isInteger(daysOverdue) || daysOverdue < 0) {
    throw new DomainValidationError(
      `Days overdue must be a whole number of days at or above zero, received ${String(daysOverdue)}.`,
    );
  }
  if (bands.length === 0) {
    throw new DomainValidationError('Cannot classify against an empty provisioning schedule.');
  }

  const band = bands.find(
    (candidate) =>
      daysOverdue >= candidate.minDaysOverdue &&
      (candidate.maxDaysOverdue === null || daysOverdue <= candidate.maxDaysOverdue),
  );

  if (band === undefined) {
    return {
      classified: false,
      reason: 'no_band_covers_days',
      daysOverdue,
      message:
        `No provisioning band covers ${String(daysOverdue)} days overdue. ` +
        'BOT’s housing microfinance schedule begins at 91 days and defines nothing below it ' +
        '(02-BOT-REPORTING-SPEC.md §11.5). This loan cannot be classified until that is resolved.',
    };
  }

  return {
    classified: true,
    classification: band.classification,
    provisionRate: band.provisionRate,
  };
}

/**
 * The provision to hold against an outstanding amount.
 *
 * Gross of collateral. MSP2-03 line 70 then deducts cash collateral, insurance
 * guarantees and compulsory savings to reach the net figure — see
 * {@link netProvision}.
 */
export function grossProvision(outstanding: Money, provisionRate: Percentage): Money {
  if (outstanding.isNegative()) {
    throw new DomainValidationError(
      `Outstanding amount cannot be negative, received ${outstanding.toDatabaseValue()}.`,
    );
  }
  return outstanding.applyPercentage(provisionRate);
}

/**
 * Provision net of what secures the lending.
 *
 * Floored at zero: collateral exceeding the provision reduces it to nothing, it
 * does not become a negative provision. A negative provision would add to the
 * loan book on MSP2-01, which is the opposite of what holding security means.
 */
export function netProvision(gross: Money, collateral: Money): Money {
  if (collateral.isNegative()) {
    throw new DomainValidationError(
      `Collateral cannot be negative, received ${collateral.toDatabaseValue()}.`,
    );
  }
  const net = gross.minus(collateral);
  return net.isNegative() ? Money.zero(gross.currency) : net;
}

/** Outstanding amounts by classification, as MSP2-03 tabulates them. */
export type PortfolioByClassification = Readonly<Record<OverdueClassification, Money>>;

/**
 * Non-performing loans as a percentage of the gross book.
 *
 * MSP2-03 line 73: `(Substandard + Doubtful + Loss) ÷ Total Outstanding × 100`.
 *
 * An empty book returns zero rather than dividing by it. A lender with no loans
 * has no bad ones, and reporting a division error on the return would be worse
 * than reporting nought.
 */
export function nonPerformingRatio(portfolio: PortfolioByClassification): Percentage {
  const currency = portfolio.current.currency;
  const total = Money.sum(Object.values(portfolio), currency);

  if (total.isZero()) {
    return Percentage.zero();
  }

  const nonPerforming = Money.sum(
    NON_PERFORMING_CLASSIFICATIONS.map((classification) => portfolio[classification]),
    currency,
  );

  return Percentage.fromFraction(nonPerforming.dividedByExact(total.toDatabaseValue()));
}

/** Narrow an arbitrary string to a BOT classification. */
export function isOverdueClassification(value: string): value is OverdueClassification {
  return (OVERDUE_CLASSIFICATIONS as readonly string[]).includes(value);
}
