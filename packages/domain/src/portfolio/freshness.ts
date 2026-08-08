import { DomainValidationError } from '../errors.js';

/**
 * How old a classification run may be before figures derived from it stop being
 * trustworthy.
 *
 * Classifications move with the calendar, not with anything a user does: a loan
 * crosses from ESM into Substandard because a day passed. Twenty-four hours
 * bounds the error at one day's drift, which is the smallest window a daily job
 * can guarantee.
 */
export const MAXIMUM_CLASSIFICATION_AGE_HOURS = 24;

/** Why report generation was refused. */
export type ReadinessProblem =
  /** Classifications have never been computed for this institution. */
  | 'never_classified'
  /** The last classification run is older than the permitted age. */
  | 'classifications_stale'
  /** Some loans have no classification BOT has defined. */
  | 'unclassifiable_loans';

/** Whether figures derived from classification may be reported. */
export type ReportingReadiness =
  | { readonly ready: true }
  | {
      readonly ready: false;
      readonly problems: readonly {
        readonly problem: ReadinessProblem;
        readonly message: string;
      }[];
    };

export interface ReadinessRequest {
  /** When classifications were last recomputed, or null if never. */
  readonly classificationsUpdatedAt: Date | null;
  /** Loans that no provisioning band covers. */
  readonly unclassifiableLoanCount: number;
  readonly now: Date;
  readonly maximumAgeHours?: number;
}

/**
 * Decide whether an institution's portfolio figures may be filed.
 *
 * This is the answer to the worst defect in the system being replaced. Its
 * classification job was scheduled by a `pg_cron` line left commented out, so
 * unless somebody noticed and enabled it, no loan's classification ever changed
 * after creation — a loan forty days overdue kept reporting "Current" to the
 * dashboard *and to the Bank of Tanzania* (analysis R5).
 *
 * That failure was silent, and silence is what made it dangerous: nothing
 * crashed, no screen was empty, the numbers simply were not true. So staleness
 * blocks generation outright rather than showing a warning beside a report
 * somebody will file anyway.
 *
 * A compliance product that quietly files wrong numbers is worse than one that
 * refuses to file.
 */
export function assessReportingReadiness(request: ReadinessRequest): ReportingReadiness {
  const maximumAgeHours = request.maximumAgeHours ?? MAXIMUM_CLASSIFICATION_AGE_HOURS;

  if (maximumAgeHours <= 0) {
    throw new DomainValidationError(
      `Maximum classification age must be positive, received ${String(maximumAgeHours)}.`,
    );
  }
  if (request.unclassifiableLoanCount < 0) {
    throw new DomainValidationError('Unclassifiable loan count cannot be negative.');
  }

  const problems: { problem: ReadinessProblem; message: string }[] = [];

  if (request.classificationsUpdatedAt === null) {
    problems.push({
      problem: 'never_classified',
      message:
        'Overdue classifications have never been computed for this institution, so every ' +
        'loan would report as it stood at creation. Run the classification job before filing.',
    });
  } else {
    const ageHours =
      (request.now.getTime() - request.classificationsUpdatedAt.getTime()) / (60 * 60 * 1000);

    if (ageHours > maximumAgeHours) {
      problems.push({
        problem: 'classifications_stale',
        message:
          `Overdue classifications were last computed ${String(Math.floor(ageHours))} hours ago, ` +
          `beyond the ${String(maximumAgeHours)}-hour limit. Loans may have moved between ` +
          'classifications since, which would understate provisions on MSP2-03.',
      });
    }
  }

  if (request.unclassifiableLoanCount > 0) {
    problems.push({
      problem: 'unclassifiable_loans',
      message:
        `${String(request.unclassifiableLoanCount)} loan(s) fall outside every provisioning band ` +
        'and have no classification. MSP2-03 provides no unclassified column, so they cannot be ' +
        'placed on the return. See 02-BOT-REPORTING-SPEC.md §11.5.',
    });
  }

  return problems.length === 0 ? { ready: true } : { ready: false, problems };
}
