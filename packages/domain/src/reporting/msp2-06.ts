import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import { type ReportingPeriod } from './period.js';

/**
 * MSP2-06 — Complaints.
 *
 * A quarterly movement statement rather than a snapshot, and the only form on
 * the return that is one:
 *
 *   opening + new − resolved by the institution − resolved by other parties
 *                                              = unresolved at the quarter end
 *
 * plus four lines counting where the unresolved ones have been referred. Every
 * line is reported as a count, a TZS value, and a split across BOT's six nature
 * categories (02-BOT-REPORTING-SPEC.md §8).
 *
 * **Every line is derived from the same records by date**, including the
 * opening balance and the closing one. Nothing is carried forward from a
 * previous return, which matters more than it sounds: an opening figure typed
 * from last quarter's closing figure is a number nobody can check, and a single
 * typo would propagate through every return that followed it. Here, restating
 * an old quarter is a matter of asking the same question with different dates.
 *
 * BOT's rule 8 — that the closing line equals the roll-forward — is not checked
 * arithmetic here but an **identity** over these sets. A complaint resolved
 * inside the quarter was either open at the start or received during it, and it
 * cannot be resolved before it was received (the database refuses that), so the
 * closing set is exactly the opening and new sets less the resolved ones. The
 * validator checks it anyway, because the guarantee lives in a constraint that
 * a future migration could weaken.
 */

/** Where an unresolved complaint has been taken. BOT names four. */
export const REFERRAL_DESTINATIONS = [
  'bank_of_tanzania',
  'fair_competition_commission',
  'courts',
  'other_parties',
] as const;

export type ReferralDestination = (typeof REFERRAL_DESTINATIONS)[number];

/** The two routes by which a complaint leaves the unresolved population. */
export const RESOLUTION_ROUTES = ['institution', 'other_party'] as const;

export type ResolutionRoute = (typeof RESOLUTION_ROUTES)[number];

/** BOT's nine numbered lines, by the Sno the form gives them. */
export const COMPLAINT_LINE = {
  opening: 1,
  received: 2,
  resolvedByInstitution: 3,
  resolvedByOtherParties: 4,
  unresolvedAtEnd: 5,
  referredToBot: 6,
  referredToFcc: 7,
  referredToCourts: 8,
  referredToOtherParties: 9,
} as const;

/** Which Sno each referral destination is counted on. */
const REFERRAL_LINE: Record<ReferralDestination, number> = {
  bank_of_tanzania: COMPLAINT_LINE.referredToBot,
  fair_competition_commission: COMPLAINT_LINE.referredToFcc,
  courts: COMPLAINT_LINE.referredToCourts,
  other_parties: COMPLAINT_LINE.referredToOtherParties,
};

/** One complaint, reduced to what the form asks about it. */
export interface ComplaintRecord {
  readonly natureCode: string;
  /** The amount in dispute. Zero is a real answer, not a missing one. */
  readonly amount: Money;
  /** `YYYY-MM-DD`. */
  readonly receivedOn: string;
  readonly resolvedOn: string | null;
  readonly resolvedBy: ResolutionRoute | null;
  readonly referredTo: ReferralDestination | null;
  readonly referredOn: string | null;
}

/** One line of the form: a count, a value, and the count split by nature. */
export interface Msp2_06Row {
  readonly sno: number;
  readonly label: string;
  /** True where BOT's template computes the line rather than taking it. */
  readonly isComputed: boolean;
  readonly count: number;
  readonly value: Money;
  /** Nature code to count. Sums to `count`, which is BOT's rule 7. */
  readonly byNature: ReadonlyMap<string, number>;
}

export interface Msp2_06 {
  readonly rows: readonly Msp2_06Row[];
}

export interface Msp2_06Request {
  readonly period: ReportingPeriod;
  /** BOT's six nature codes, in the order their columns appear. */
  readonly natureCodes: readonly string[];
  /**
   * Every complaint that could touch this quarter.
   *
   * "Could touch" is wider than "was received in": a complaint from two years
   * ago that is still open counts on the opening line, and one resolved this
   * quarter counts on line 3 or 4 whenever it arrived.
   */
  readonly complaints: readonly ComplaintRecord[];
}

/** The label BOT prints against each line, from `reference.form_lines`. */
export interface ComplaintLineLabel {
  readonly sno: number;
  readonly label: string;
  readonly isComputed: boolean;
}

/**
 * Compile the form.
 *
 * @throws {DomainValidationError} when the nature taxonomy is missing, when a
 * complaint names a nature BOT does not publish — it would have no column to
 * sit in — or when the line labels do not cover BOT's nine lines.
 */
export function compileMsp2_06(
  request: Msp2_06Request,
  labels: readonly ComplaintLineLabel[],
): Msp2_06 {
  if (request.natureCodes.length === 0) {
    throw new DomainValidationError(
      'MSP2-06 cannot be compiled without the complaint-nature taxonomy. Seed BOT reference ' +
        'data first.',
    );
  }

  const published = new Set(request.natureCodes);
  for (const complaint of request.complaints) {
    if (!published.has(complaint.natureCode)) {
      throw new DomainValidationError(
        `A complaint is recorded under nature "${complaint.natureCode}", which is not one of ` +
          'BOT’s six. It would have no column on MSP2-06.',
      );
    }
  }

  const { startDate, endDate } = request.period;

  /** Open at the first moment of the quarter: raised before it, still live. */
  const opening = request.complaints.filter(
    (complaint) =>
      complaint.receivedOn < startDate &&
      (complaint.resolvedOn === null || complaint.resolvedOn >= startDate),
  );

  const received = request.complaints.filter(
    (complaint) => complaint.receivedOn >= startDate && complaint.receivedOn <= endDate,
  );

  const resolvedInPeriod = (route: ResolutionRoute): readonly ComplaintRecord[] =>
    request.complaints.filter(
      (complaint) =>
        complaint.resolvedBy === route &&
        complaint.resolvedOn !== null &&
        complaint.resolvedOn >= startDate &&
        complaint.resolvedOn <= endDate,
    );

  /** Still live at the last moment of the quarter. */
  const unresolved = request.complaints.filter(
    (complaint) =>
      complaint.receivedOn <= endDate &&
      (complaint.resolvedOn === null || complaint.resolvedOn > endDate),
  );

  /**
   * Referred as at the quarter end.
   *
   * A referral made in January does not belong on the return for the quarter
   * that ended in December, which is why the date is read rather than only the
   * destination.
   */
  const referred = (destination: ReferralDestination): readonly ComplaintRecord[] =>
    unresolved.filter(
      (complaint) =>
        complaint.referredTo === destination &&
        complaint.referredOn !== null &&
        complaint.referredOn <= endDate,
    );

  const population = new Map<number, readonly ComplaintRecord[]>([
    [COMPLAINT_LINE.opening, opening],
    [COMPLAINT_LINE.received, received],
    [COMPLAINT_LINE.resolvedByInstitution, resolvedInPeriod('institution')],
    [COMPLAINT_LINE.resolvedByOtherParties, resolvedInPeriod('other_party')],
    [COMPLAINT_LINE.unresolvedAtEnd, unresolved],
  ]);
  for (const destination of REFERRAL_DESTINATIONS) {
    population.set(REFERRAL_LINE[destination], referred(destination));
  }

  const rows = labels
    .slice()
    .sort((left, right) => left.sno - right.sno)
    .map((line) => {
      const complaints = population.get(line.sno);
      if (complaints === undefined) {
        throw new DomainValidationError(
          `MSP2-06 Sno${String(line.sno)} is not a line this compiler knows how to derive.`,
        );
      }
      return summarise(line, complaints, request.natureCodes);
    });

  if (rows.length !== population.size) {
    throw new DomainValidationError(
      `MSP2-06 has ${String(population.size)} lines and ${String(rows.length)} were labelled. ` +
        'The form and the reference data disagree about its shape.',
    );
  }

  return { rows };
}

function summarise(
  line: ComplaintLineLabel,
  complaints: readonly ComplaintRecord[],
  natureCodes: readonly string[],
): Msp2_06Row {
  // Every published nature gets an entry, including the ones with nothing in
  // them: BOT's sheet has a column per category and a blank is not a zero.
  const byNature = new Map<string, number>(natureCodes.map((code) => [code, 0]));
  for (const complaint of complaints) {
    byNature.set(complaint.natureCode, (byNature.get(complaint.natureCode) ?? 0) + 1);
  }

  return {
    sno: line.sno,
    label: line.label,
    isComputed: line.isComputed,
    count: complaints.length,
    value: Money.sum(complaints.map((complaint) => complaint.amount)),
    byNature,
  };
}
