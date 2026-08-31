import { Money } from '@mfi/money';

import { type Gender } from '../client/gender.js';
import { DomainValidationError } from '../errors.js';

/**
 * MSP2-09 — Loans Disbursed by Gender and Sector.
 *
 * The same twenty-two sectors as MSP2-03, each split into loans disbursed to
 * women and to men, by count and by amount.
 *
 * **This is a flow, not a balance.** Every other portfolio form on the return
 * reports what is outstanding as at the quarter end; this one reports what was
 * advanced *during* the quarter. The two are never equal and are easy to
 * confuse, because both are money against a sector — so this compiler takes
 * disbursements rather than exposures, and a caller cannot pass the wrong set
 * without the types disagreeing.
 *
 * The amount is what was disbursed, not what remains owing. A loan advanced in
 * January and half repaid by March still reports its full principal here.
 */

/** One loan advanced during the period. */
export interface Disbursement {
  readonly sectorCode: string;
  readonly gender: Gender;
  /** The principal advanced, not the balance outstanding. */
  readonly principal: Money;
}

export interface GenderSplit {
  readonly count: number;
  readonly amount: Money;
}

export interface Msp2_09Row {
  readonly sectorCode: string;
  readonly female: GenderSplit;
  readonly male: GenderSplit;
  readonly total: GenderSplit;
}

export interface Msp2_09 {
  readonly rows: readonly Msp2_09Row[];
  readonly total: Msp2_09Row;
}

export interface Msp2_09Request {
  readonly sectorCodes: readonly string[];
  /** Only loans whose disbursement date falls inside the reporting period. */
  readonly disbursements: readonly Disbursement[];
}

export function compileMsp2_09(request: Msp2_09Request): Msp2_09 {
  if (request.sectorCodes.length === 0) {
    throw new DomainValidationError(
      'MSP2-09 cannot be compiled without the sector taxonomy. Seed BOT reference data first.',
    );
  }

  const known = new Set(request.sectorCodes);
  for (const disbursement of request.disbursements) {
    if (!known.has(disbursement.sectorCode)) {
      throw new DomainValidationError(
        `Disbursement references sector "${disbursement.sectorCode}", which is not one BOT publishes.`,
      );
    }
  }

  const rows = request.sectorCodes.map((sectorCode) => {
    const inSector = request.disbursements.filter(
      (disbursement) => disbursement.sectorCode === sectorCode,
    );
    return rowFrom(sectorCode, inSector);
  });

  return { rows, total: rowFrom('TOTAL', request.disbursements) };
}

function rowFrom(sectorCode: string, disbursements: readonly Disbursement[]): Msp2_09Row {
  const splitFor = (gender: Gender): GenderSplit => {
    const matching = disbursements.filter((disbursement) => disbursement.gender === gender);
    return {
      count: matching.length,
      amount: Money.sum(matching.map((disbursement) => disbursement.principal)),
    };
  };

  const female = splitFor('female');
  const male = splitFor('male');

  return {
    sectorCode,
    female,
    male,
    // Summed from the two columns rather than counted again over the whole set.
    // BOT validates that the total equals the parts, and deriving it any other
    // way creates a figure that can disagree with them.
    total: {
      count: female.count + male.count,
      amount: female.amount.plus(male.amount),
    },
  };
}
