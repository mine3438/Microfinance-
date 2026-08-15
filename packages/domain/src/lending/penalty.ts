import { Dec, Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * Penalty on an overdue instalment.
 *
 * The shape is §13.1's confirmed answer (01-ARCHITECTURE.md §24.2): a daily
 * rate on the **overdue instalment amount**, after a grace period in days,
 * accruing **simple and non-compounding**, with an optional cap as a fraction
 * of principal.
 *
 * Three of those words carry the arithmetic:
 *
 * - **Overdue instalment amount**, not outstanding principal. A borrower who
 *   misses one instalment on a large loan owes penalty on what they missed, not
 *   on the whole book. This is the gentler of the two bases and the one that was
 *   chosen; the other is a one-line change here and a migration, not a setting.
 * - **Simple**, so each day's charge is computed on the same base. Compounding
 *   would make the charge depend on how often it is calculated, which is a
 *   property of a job schedule rather than of a loan agreement.
 * - **Non-compounding** also means accrued penalty is never itself a base. A
 *   penalty balance that grew penalties would make the total depend on when
 *   somebody last ran the accrual.
 *
 * Nothing here has a default. A product with no terms charges nothing, and the
 * figures §13.1 still owes are the institution's to state.
 */

/**
 * What a product charges. Absent where the product charges no penalty.
 *
 * The rates are plain decimal fractions rather than `Rate`, because `Rate` in
 * this codebase means a *monthly* interest rate — it converts to and from
 * monthly percentages and annualises for MSP2-04. A daily penalty rate that
 * borrowed the type would inherit arithmetic that means something else.
 */
export interface PenaltyTerms {
  /** Daily rate on the overdue amount, as a fraction: `'0.0010'` is 0.1% a day. */
  readonly dailyRate: string;
  /** Days after the due date before penalty begins. Zero starts immediately. */
  readonly graceDays: number;
  /** Ceiling as a fraction of principal, or `null` for none. */
  readonly capFraction: string | null;
}

/** One instalment that has fallen due and is not fully paid. */
export interface OverdueInstalment {
  /** The part of the instalment still unpaid. */
  readonly outstanding: Money;
  /** `YYYY-MM-DD`. */
  readonly dueDate: string;
}

export interface PenaltyAccrual {
  /** Penalty owed across every overdue instalment, after any cap. */
  readonly total: Money;
  /** What the cap removed, so a statement can say the ceiling was reached. */
  readonly capped: Money;
  /** Days charged per instalment, in the order given. */
  readonly chargeableDays: readonly number[];
}

const MILLISECONDS_PER_DAY = 86_400_000;

/** Whole days between two `YYYY-MM-DD` dates, never negative. */
function daysBetween(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);

  if (Number.isNaN(start) || Number.isNaN(end)) {
    throw new DomainValidationError(
      `A penalty cannot be computed between "${from}" and "${to}": one is not a date.`,
    );
  }

  const days = Math.floor((end - start) / MILLISECONDS_PER_DAY);
  return days < 0 ? 0 : days;
}

/**
 * Accrue penalty across a loan's overdue instalments, as at a date.
 *
 * As at a date rather than "now", for the same reason every other figure in
 * this system is: a statement dated last quarter has to show what was owed
 * then, and re-running the accrual must not change a figure already reported.
 *
 * @throws {DomainValidationError} when a date is unparseable or the principal
 * is needed for a cap and is not positive.
 */
export function accruePenalty(
  instalments: readonly OverdueInstalment[],
  terms: PenaltyTerms,
  principal: Money,
  asAt: string,
): PenaltyAccrual {
  if (terms.graceDays < 0 || !Number.isInteger(terms.graceDays)) {
    throw new DomainValidationError(
      `A grace period must be a whole number of days; ${String(terms.graceDays)} is not.`,
    );
  }

  const chargeableDays: number[] = [];
  let uncapped = Money.zero();

  for (const instalment of instalments) {
    // Grace runs from the due date, so the first chargeable day is the one
    // after the grace period ends. An instalment inside its grace period
    // accrues nothing rather than a fraction of a day.
    const elapsed = daysBetween(instalment.dueDate, asAt);
    const days = Math.max(elapsed - terms.graceDays, 0);
    chargeableDays.push(days);

    if (days === 0 || !instalment.outstanding.isPositive()) {
      continue;
    }

    // Simple: the base is the outstanding instalment, multiplied by the rate
    // and by the number of days — in one exact multiplication, rounded once.
    // Looping over days would round each day separately and drift from the
    // agreement's own arithmetic by a cent per day.
    uncapped = uncapped.plus(
      Money.round(instalment.outstanding.timesExact(new Dec(terms.dailyRate).times(days))),
    );
  }

  if (terms.capFraction === null) {
    return { total: uncapped, capped: Money.zero(), chargeableDays };
  }

  if (!principal.isPositive()) {
    throw new DomainValidationError(
      'A penalty cap is a fraction of principal, so the principal must be positive.',
    );
  }

  const ceiling = Money.round(principal.timesExact(terms.capFraction));
  if (!uncapped.greaterThan(ceiling)) {
    return { total: uncapped, capped: Money.zero(), chargeableDays };
  }

  return { total: ceiling, capped: uncapped.minus(ceiling), chargeableDays };
}
