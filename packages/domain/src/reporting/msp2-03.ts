import { Money, Percentage } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import {
  NON_PERFORMING_CLASSIFICATIONS,
  OVERDUE_CLASSIFICATIONS,
  type OverdueClassification,
} from '../portfolio/classification.js';

/**
 * MSP2-03 — Sectoral Classification and Provisioning.
 *
 * Twenty-two sectors, each carrying a borrower count, an outstanding total
 * split across BOT's five classification buckets, the provision held against
 * each, and the amount written off during the quarter.
 *
 * This is a compiler, not a calculator: it arranges figures the portfolio has
 * already produced. The classification of a loan and the provision rate that
 * applies to it were decided by `classification.ts` against BOT's seeded bands,
 * and are not re-derived here — a second derivation would be a second answer.
 *
 * Balances are **as at the quarter end**; write-offs are a movement **during**
 * the quarter. Both appear on the same row, which is exactly the confusion the
 * separate input fields below exist to prevent.
 */

/** One loan, reduced to what this form needs from it. */
export interface ClassifiedExposure {
  readonly sectorCode: string;
  readonly clientId: string;
  readonly outstanding: Money;
  /**
   * `null` when no band covers the loan.
   *
   * BOT's housing schedule begins at 91 days and defines nothing below it, so a
   * housing loan less overdue than that has no classification BOT has given
   * (§11.5). Such a loan cannot be placed on this form — there is no
   * unclassified column — so it is counted and reported as a refusal rather
   * than folded into `current`.
   */
  readonly classification: OverdueClassification | null;
  readonly provisionRate: Percentage | null;
}

/** What was written off during the quarter, by sector. */
export interface SectorWriteOff {
  readonly sectorCode: string;
  readonly amount: Money;
}

/** Security held against lending, deducted from the gross provision. */
export interface SectorCollateral {
  readonly sectorCode: string;
  /** Cash collateral, insurance guarantees and compulsory savings, combined. */
  readonly amount: Money;
}

/** One row of the form. */
export interface Msp2_03Row {
  readonly sectorCode: string;
  readonly borrowerCount: number;
  readonly totalOutstanding: Money;
  readonly outstandingByClass: Readonly<Record<OverdueClassification, Money>>;
  readonly grossProvision: Money;
  readonly collateral: Money;
  readonly netProvision: Money;
  /** Outstanding less the net provision — BOT's "Total (Net Amount)". */
  readonly netAmount: Money;
  readonly writtenOffDuringPeriod: Money;
}

export interface Msp2_03 {
  readonly rows: readonly Msp2_03Row[];
  readonly total: Msp2_03Row;
  /** `(Substandard + Doubtful + Loss) ÷ Total Outstanding × 100`. */
  readonly nonPerformingRatio: Percentage;
  /**
   * Loans no band covered.
   *
   * Non-empty means the form is incomplete: these exposures are in the loan
   * book and on no row of the return. Reporting the count rather than dropping
   * them silently is the difference between a compiler that refuses and one
   * that quietly under-reports a portfolio to its regulator.
   */
  readonly unclassifiableLoanCount: number;
}

export interface Msp2_03Request {
  /** Every sector code BOT publishes, so a sector with no lending still reports zero. */
  readonly sectorCodes: readonly string[];
  readonly exposures: readonly ClassifiedExposure[];
  readonly writeOffs: readonly SectorWriteOff[];
  readonly collateral: readonly SectorCollateral[];
}

function zeroByClass(): Record<OverdueClassification, Money> {
  return {
    current: Money.zero(),
    esm: Money.zero(),
    substandard: Money.zero(),
    doubtful: Money.zero(),
    loss: Money.zero(),
  };
}

/**
 * Compile the form.
 *
 * Every published sector produces a row, including sectors with no lending.
 * BOT's template has a fixed twenty-two rows and an omitted one is not an empty
 * row — it shifts every row beneath it, and the validator reads by position.
 */
export function compileMsp2_03(request: Msp2_03Request): Msp2_03 {
  if (request.sectorCodes.length === 0) {
    throw new DomainValidationError(
      'MSP2-03 cannot be compiled without the sector taxonomy. Seed BOT reference data first.',
    );
  }

  const known = new Set(request.sectorCodes);
  for (const exposure of request.exposures) {
    if (!known.has(exposure.sectorCode)) {
      // A sector outside the published list has nowhere to go on the form, and
      // silently dropping the exposure would under-report the book.
      throw new DomainValidationError(
        `Exposure references sector "${exposure.sectorCode}", which is not one BOT publishes. ` +
          'The loan book and the taxonomy have diverged.',
      );
    }
  }

  const writeOffBySector = new Map(
    request.writeOffs.map((entry) => [entry.sectorCode, entry.amount]),
  );
  const collateralBySector = new Map(
    request.collateral.map((entry) => [entry.sectorCode, entry.amount]),
  );

  let unclassifiableLoanCount = 0;
  const rows: Msp2_03Row[] = [];

  for (const sectorCode of request.sectorCodes) {
    const inSector = request.exposures.filter((exposure) => exposure.sectorCode === sectorCode);

    const outstandingByClass = zeroByClass();
    const borrowers = new Set<string>();
    let grossProvision = Money.zero();

    for (const exposure of inSector) {
      if (exposure.classification === null || exposure.provisionRate === null) {
        unclassifiableLoanCount += 1;
        // Deliberately not added to any bucket. It is counted above and
        // reported; placing it in `current` would understate the provision and
        // file a wrong return.
        continue;
      }

      // One borrower with three loans is one borrower. BOT's validation ties
      // this count to MSP2-04's, and counting loans instead would break it.
      borrowers.add(exposure.clientId);

      outstandingByClass[exposure.classification] = outstandingByClass[
        exposure.classification
      ].plus(exposure.outstanding);

      grossProvision = grossProvision.plus(
        exposure.outstanding.applyPercentage(exposure.provisionRate),
      );
    }

    const totalOutstanding = Money.sum(Object.values(outstandingByClass));
    const collateral = collateralBySector.get(sectorCode) ?? Money.zero();

    // Floored at zero. Collateral exceeding the provision reduces it to
    // nothing; it does not become a negative provision, which would *add* to
    // the loan book on MSP2-01.
    const netProvision = grossProvision.minus(collateral);
    const flooredNetProvision = netProvision.isNegative() ? Money.zero() : netProvision;

    rows.push({
      sectorCode,
      borrowerCount: borrowers.size,
      totalOutstanding,
      outstandingByClass,
      grossProvision,
      collateral,
      netProvision: flooredNetProvision,
      netAmount: totalOutstanding.minus(flooredNetProvision),
      writtenOffDuringPeriod: writeOffBySector.get(sectorCode) ?? Money.zero(),
    });
  }

  return {
    rows,
    total: totalRow(rows),
    nonPerformingRatio: nonPerformingRatioOf(rows),
    unclassifiableLoanCount,
  };
}

/** BOT's Sno67 — the total line, summed from the rows above it. */
function totalRow(rows: readonly Msp2_03Row[]): Msp2_03Row {
  const outstandingByClass = zeroByClass();
  for (const classification of OVERDUE_CLASSIFICATIONS) {
    outstandingByClass[classification] = Money.sum(
      rows.map((row) => row.outstandingByClass[classification]),
    );
  }

  const totalOutstanding = Money.sum(rows.map((row) => row.totalOutstanding));
  const netProvision = Money.sum(rows.map((row) => row.netProvision));

  return {
    sectorCode: 'TOTAL',
    // Summed across sectors. A borrower lending in two sectors is counted in
    // each, which is what BOT's per-sector form reports; the tie to MSP2-04 is
    // asserted by a validation rule rather than assumed here.
    borrowerCount: rows.reduce((count, row) => count + row.borrowerCount, 0),
    totalOutstanding,
    outstandingByClass,
    grossProvision: Money.sum(rows.map((row) => row.grossProvision)),
    collateral: Money.sum(rows.map((row) => row.collateral)),
    netProvision,
    netAmount: totalOutstanding.minus(netProvision),
    writtenOffDuringPeriod: Money.sum(rows.map((row) => row.writtenOffDuringPeriod)),
  };
}

/**
 * BOT's Sno73.
 *
 * An empty book returns zero rather than dividing by it: a lender with no loans
 * has no bad ones, and a division error on a signed return is worse than a nought.
 */
function nonPerformingRatioOf(rows: readonly Msp2_03Row[]): Percentage {
  const total = Money.sum(rows.map((row) => row.totalOutstanding));
  if (total.isZero()) {
    return Percentage.zero();
  }

  const nonPerforming = Money.sum(
    rows.flatMap((row) =>
      NON_PERFORMING_CLASSIFICATIONS.map(
        (classification) => row.outstandingByClass[classification],
      ),
    ),
  );

  return Percentage.fromFraction(nonPerforming.dividedByExact(total.toDatabaseValue()));
}
