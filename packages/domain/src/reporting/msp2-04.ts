import { Money, Percentage, type AnnualisationConvention, type Rate } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import { type InterestMethod } from '../lending/schedule.js';

/**
 * MSP2-04 — Interest Rate Structure.
 *
 * Per loan type: borrower count, outstanding, and — separately for straight-line
 * and reducing-balance amortisation — the lowest rate, the highest rate, and a
 * weighted average. **All rates are percent per annum**, while the system
 * stores a monthly fraction, so every rate on this form is converted.
 *
 * Two things about that conversion are worth stating plainly, because both are
 * decisions and neither is arithmetic:
 *
 * 1. **Simple or effective.** 5% a month is 60% simple or 79.6% compounded, and
 *    the documentation does not say which BOT wants (§11.2). The convention is
 *    a parameter with a simple default, so the choice is visible at the call
 *    site rather than buried here.
 * 2. **BOT's weighted average is not a weighted average.** See below.
 */

/** Which of BOT's two amortisation columns a loan reports under. */
export type AmortisationMethod = 'straight_line' | 'reducing_balance';

/** How this system's interest methods map onto BOT's columns. */
export function amortisationMethodFor(method: InterestMethod): AmortisationMethod {
  return method === 'flat' ? 'straight_line' : 'reducing_balance';
}

/** One loan, reduced to what this form needs. */
export interface RateExposure {
  readonly botLoanType: string;
  readonly clientId: string;
  readonly outstanding: Money;
  readonly monthlyRate: Rate;
  readonly interestMethod: InterestMethod;
}

/** The rate figures for one amortisation method within one loan type. */
export interface RateBand {
  /** `null` when no loan of this type uses this amortisation method. */
  readonly lowest: Percentage | null;
  readonly highest: Percentage | null;
  readonly weightedAverage: Percentage | null;
}

export interface Msp2_04Row {
  readonly botLoanType: string;
  readonly borrowerCount: number;
  readonly totalOutstanding: Money;
  readonly straightLine: RateBand;
  readonly reducingBalance: RateBand;
}

export interface Msp2_04 {
  readonly rows: readonly Msp2_04Row[];
  readonly total: Omit<Msp2_04Row, 'botLoanType'>;
  /** The convention used, so a reader of the return knows which was applied. */
  readonly annualisation: AnnualisationConvention;
}

export interface Msp2_04Request {
  /** Every loan type BOT publishes, so a type with no lending still reports zero. */
  readonly loanTypeCodes: readonly string[];
  readonly exposures: readonly RateExposure[];
  readonly annualisation?: AnnualisationConvention;
}

/**
 * Compile the form.
 *
 * @throws {DomainValidationError} when an exposure names a loan type BOT does
 * not publish, which would have nowhere to go on a fixed-row form.
 */
export function compileMsp2_04(request: Msp2_04Request): Msp2_04 {
  if (request.loanTypeCodes.length === 0) {
    throw new DomainValidationError(
      'MSP2-04 cannot be compiled without the loan-type taxonomy. Seed BOT reference data first.',
    );
  }

  const annualisation = request.annualisation ?? 'simple';
  const known = new Set(request.loanTypeCodes);

  for (const exposure of request.exposures) {
    if (!known.has(exposure.botLoanType)) {
      throw new DomainValidationError(
        `Exposure references loan type "${exposure.botLoanType}", which is not one BOT publishes.`,
      );
    }
  }

  const rows = request.loanTypeCodes.map((botLoanType) => {
    const inType = request.exposures.filter((exposure) => exposure.botLoanType === botLoanType);
    const borrowers = new Set(inType.map((exposure) => exposure.clientId));

    return {
      botLoanType,
      borrowerCount: borrowers.size,
      totalOutstanding: Money.sum(inType.map((exposure) => exposure.outstanding)),
      straightLine: bandFor(inType, 'straight_line', annualisation),
      reducingBalance: bandFor(inType, 'reducing_balance', annualisation),
    };
  });

  return {
    rows,
    total: {
      borrowerCount: new Set(request.exposures.map((exposure) => exposure.clientId)).size,
      totalOutstanding: Money.sum(request.exposures.map((exposure) => exposure.outstanding)),
      straightLine: bandFor(request.exposures, 'straight_line', annualisation),
      reducingBalance: bandFor(request.exposures, 'reducing_balance', annualisation),
    },
    annualisation,
  };
}

function bandFor(
  exposures: readonly RateExposure[],
  method: AmortisationMethod,
  annualisation: AnnualisationConvention,
): RateBand {
  const matching = exposures.filter(
    (exposure) => amortisationMethodFor(exposure.interestMethod) === method,
  );

  if (matching.length === 0) {
    // Distinguished from zero. A loan type with no straight-line lending has no
    // lowest rate, and reporting 0% would say it lends at nothing.
    return { lowest: null, highest: null, weightedAverage: null };
  }

  const annualRates = matching.map((exposure) =>
    exposure.monthlyRate.toAnnualPercentage(annualisation),
  );

  // Seeded from the first element and narrowed, rather than asserted non-null:
  // the array is non-empty because `matching` was checked above, but a reader
  // should not have to reconstruct that argument from an assertion.
  const [first, ...rest] = annualRates;
  if (first === undefined) {
    return { lowest: null, highest: null, weightedAverage: null };
  }

  let lowest = first;
  let highest = first;
  for (const rate of rest) {
    if (rate.lessThan(lowest)) {
      lowest = rate;
    }
    if (rate.greaterThan(highest)) {
      highest = rate;
    }
  }

  return {
    lowest,
    highest,
    weightedAverage: botWeightedAverage(matching, annualisation),
  };
}

/**
 * BOT's weighted average, replicated exactly — including its error.
 *
 * The template's cells compute:
 *
 * ```
 * E = (outstanding ÷ total) × lowest + (outstanding ÷ total) × highest
 * ```
 *
 * which is `weight × (lowest + highest)` — **twice** the weighted midpoint. A
 * conventional weighted average divides by two.
 *
 * This is not corrected, and that is a decision rather than an oversight
 * (02-BOT-REPORTING-SPEC.md §5.1, §11.3). BOT's EDI validator is the authority
 * on what a valid submission looks like, and a return whose arithmetic differs
 * from the template's own is the more likely one to be rejected. Producing a
 * "correct" figure that fails validation helps nobody.
 *
 * The discrepancy is raised in the spec for the institution to take up with
 * BOT. If BOT confirms the conventional reading, this function changes in one
 * place — which is why the weighting lives here rather than inline.
 */
function botWeightedAverage(
  exposures: readonly RateExposure[],
  annualisation: AnnualisationConvention,
): Percentage | null {
  const total = Money.sum(exposures.map((exposure) => exposure.outstanding));
  if (total.isZero()) {
    // Every loan of this type is repaid but still on the book at zero. A
    // weighted average over zero weight is undefined, not zero.
    return null;
  }

  let accumulated = Percentage.zero();

  for (const exposure of exposures) {
    const weight = exposure.outstanding.dividedByExact(total.toDatabaseValue());
    const annual = exposure.monthlyRate.toAnnualPercentage(annualisation);

    // The template's formula: weight × lowest + weight × highest, where for a
    // single loan the lowest and the highest are the same rate. Summed across
    // loans this reproduces the template's own arithmetic.
    accumulated = accumulated.plus(annual.times(weight)).plus(annual.times(weight));
  }

  return accumulated;
}
