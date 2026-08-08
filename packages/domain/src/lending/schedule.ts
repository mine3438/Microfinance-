import { Dec, Money, type Rate } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import { monthlyDueDates } from './due-dates.js';

/**
 * The two interest methods the documentation specifies.
 *
 * A third would register here as another strategy rather than as another branch
 * in the generator — the reason {@link periodPlanners} is a lookup rather than a
 * switch.
 */
export const INTEREST_METHODS = ['flat', 'reducing_balance'] as const;

export type InterestMethod = (typeof INTEREST_METHODS)[number];

/** Narrow an arbitrary string to a supported method. */
export function isInterestMethod(value: string): value is InterestMethod {
  return (INTEREST_METHODS as readonly string[]).includes(value);
}

/** Longest term the system will schedule, as a guard against a typed figure. */
export const MAXIMUM_TERM_MONTHS = 360;

export interface ScheduleRequest {
  readonly principal: Money;
  /** Rate per monthly period, as a fraction. */
  readonly monthlyRate: Rate;
  readonly termMonths: number;
  readonly method: InterestMethod;
  readonly disbursementDate: Date;
}

/** One row of a repayment schedule. */
export interface ScheduleInstalment {
  readonly monthNumber: number;
  readonly dueDate: Date;
  readonly openingBalance: Money;
  readonly principalDue: Money;
  readonly interestDue: Money;
  readonly totalDue: Money;
  readonly closingBalance: Money;
}

/** A complete repayment schedule with its totals. */
export interface RepaymentSchedule {
  readonly instalments: readonly ScheduleInstalment[];
  readonly totalPrincipal: Money;
  readonly totalInterest: Money;
  readonly totalRepayable: Money;
}

/** What one period owes, before the terminal adjustment. */
interface PeriodAmounts {
  readonly principalDue: Money;
  readonly interestDue: Money;
}

/** Computes one period's split for a given method. */
type PeriodPlanner = (context: {
  readonly request: ScheduleRequest;
  readonly monthNumber: number;
  readonly openingBalance: Money;
  readonly levelPayment: Money;
}) => PeriodAmounts;

/**
 * Flat rate: interest is charged on the original principal every period, so it
 * never falls as the balance does.
 *
 * The borrower-facing consequence is that a flat rate costs close to twice its
 * headline figure compared with the same rate on a reducing balance. That is
 * why MSP2-04 asks for the two methods in separate columns rather than
 * averaging them together.
 */
const flatPeriod: PeriodPlanner = ({ request }) => ({
  principalDue: request.principal.dividedBy(String(request.termMonths)),
  interestDue: request.principal.applyRate(request.monthlyRate),
});

/**
 * Reducing balance: interest is charged on what is still owed, so it falls each
 * period while the instalment stays level.
 */
const reducingBalancePeriod: PeriodPlanner = ({ request, openingBalance, levelPayment }) => {
  const interestDue = openingBalance.applyRate(request.monthlyRate);
  const principalFromPayment = levelPayment.minus(interestDue);

  // A payment smaller than the interest accrued would amortise negatively — the
  // balance would grow. Clamping at zero keeps the schedule monotonic; the
  // terminal period then closes whatever remains.
  const principalDue = principalFromPayment.isNegative()
    ? Money.zero(request.principal.currency)
    : Money.min(principalFromPayment, openingBalance);

  return { principalDue, interestDue };
};

const periodPlanners: Readonly<Record<InterestMethod, PeriodPlanner>> = Object.freeze({
  flat: flatPeriod,
  reducing_balance: reducingBalancePeriod,
});

/**
 * The level instalment that amortises `principal` over `termMonths` at `rate`.
 *
 * Standard annuity formula: `P × r ÷ (1 − (1 + r)^−n)`.
 *
 * A zero rate is handled separately rather than by the formula, which divides
 * by zero when `r` is nought. `Rate` permits zero deliberately — whether a loan
 * *product* may carry one is a lending rule, still open in
 * `01-ARCHITECTURE.md` §13.8 — so the engine must not fall over on it.
 */
function levelPaymentFor(request: ScheduleRequest): Money {
  const term = String(request.termMonths);

  if (request.monthlyRate.isZero()) {
    return request.principal.dividedBy(term);
  }

  const rate = request.monthlyRate.monthlyFraction();
  const discountFactor = new Dec(1).minus(rate.plus(1).toPower(-request.termMonths));

  return Money.round(
    request.principal.applyRateExact(request.monthlyRate).dividedBy(discountFactor),
  );
}

function validate(request: ScheduleRequest): void {
  if (!request.principal.isPositive()) {
    throw new DomainValidationError(
      `Principal must be positive, received ${request.principal.toDatabaseValue()}.`,
    );
  }
  if (!Number.isInteger(request.termMonths) || request.termMonths < 1) {
    throw new DomainValidationError(
      `Term must be a whole number of months of at least one, received ${String(request.termMonths)}.`,
    );
  }
  if (request.termMonths > MAXIMUM_TERM_MONTHS) {
    throw new DomainValidationError(
      `Term of ${String(request.termMonths)} months exceeds the maximum of ` +
        `${String(MAXIMUM_TERM_MONTHS)}. A figure this large is nearly always a typed error.`,
    );
  }
  if (!isInterestMethod(request.method)) {
    throw new DomainValidationError(`Unknown interest method "${String(request.method)}".`);
  }
  if (Number.isNaN(request.disbursementDate.getTime())) {
    throw new DomainValidationError('Disbursement date is not a valid date.');
  }
}

/**
 * Build a repayment schedule.
 *
 * **The single implementation.** The previous system computed a payment
 * breakdown twice — once in an Edge Function that wrote the schedule, once in
 * the browser to preview it — and its own technical document warned that if the
 * two drifted, "the user-facing preview will lie about what the backend
 * actually records" (TRD §4). Here the preview endpoint calls this function and
 * the write path calls this function. There is no second implementation to
 * drift from.
 *
 * **Rounding.** Each period is rounded half-up to the currency's scale, and the
 * final period absorbs whatever residual remains, so the schedule sums to
 * exactly the principal advanced. That the last instalment differs by a few
 * cents is deliberate and conventional: a borrower is quoted one instalment
 * figure, and spreading the remainder across earlier periods to tidy the last
 * one would vary the amount they were told to pay.
 *
 * @throws {DomainValidationError} when the request cannot produce a schedule.
 */
export function generateSchedule(request: ScheduleRequest): RepaymentSchedule {
  validate(request);

  const currency = request.principal.currency;
  const planner = periodPlanners[request.method];
  const levelPayment = levelPaymentFor(request);
  const dueDates = monthlyDueDates(request.disbursementDate, request.termMonths);

  // Flat interest is charged on the original principal, so the total is known
  // up front and the terminal period can close any rounding residual against it.
  const expectedTotalInterest =
    request.method === 'flat'
      ? Money.round(request.principal.applyRateExact(request.monthlyRate).times(request.termMonths))
      : null;

  const instalments: ScheduleInstalment[] = [];
  let openingBalance = request.principal;
  let interestSoFar = Money.zero(currency);

  for (let monthNumber = 1; monthNumber <= request.termMonths; monthNumber += 1) {
    const isFinalPeriod = monthNumber === request.termMonths;
    const planned = planner({ request, monthNumber, openingBalance, levelPayment });

    // The terminal period closes the loan exactly: principal takes whatever is
    // left outstanding, and for flat interest the residual of the known total.
    const principalDue = isFinalPeriod ? openingBalance : planned.principalDue;
    const interestDue =
      isFinalPeriod && expectedTotalInterest !== null
        ? expectedTotalInterest.minus(interestSoFar)
        : planned.interestDue;

    const closingBalance = openingBalance.minus(principalDue);

    const dueDate = dueDates[monthNumber - 1];
    /* c8 ignore next 3 -- dueDates is generated with exactly termMonths entries */
    if (dueDate === undefined) {
      throw new DomainValidationError(`No due date generated for month ${String(monthNumber)}.`);
    }

    instalments.push({
      monthNumber,
      dueDate,
      openingBalance,
      principalDue,
      interestDue,
      totalDue: principalDue.plus(interestDue),
      closingBalance,
    });

    openingBalance = closingBalance;
    interestSoFar = interestSoFar.plus(interestDue);
  }

  const totalPrincipal = Money.sum(
    instalments.map((instalment) => instalment.principalDue),
    currency,
  );
  const totalInterest = Money.sum(
    instalments.map((instalment) => instalment.interestDue),
    currency,
  );

  // The invariant the whole engine exists to hold. If it ever fails, the loan
  // would close owing or overpaid, and no report would reconcile.
  if (!totalPrincipal.equals(request.principal)) {
    throw new DomainValidationError(
      `Schedule principal ${totalPrincipal.toDatabaseValue()} does not equal the advance ` +
        `${request.principal.toDatabaseValue()}. This is a defect in the schedule generator.`,
    );
  }

  return {
    instalments,
    totalPrincipal,
    totalInterest,
    totalRepayable: totalPrincipal.plus(totalInterest),
  };
}
