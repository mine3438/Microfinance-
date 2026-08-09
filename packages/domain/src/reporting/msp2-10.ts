import { Money } from '@mfi/money';

import { ageBandAt, type AgeBand } from '../client/age-band.js';
import { type Gender } from '../client/gender.js';
import { DomainValidationError } from '../errors.js';

/**
 * MSP2-10 — Geographic Distribution.
 *
 * The largest form on the return: 31 regions and 193 districts in a fixed
 * hierarchy, each district carrying branches, employees, compulsory savings,
 * and then borrowers, loans and outstanding amounts split twelve ways —
 * age band (up to 35 / above 35) × gender (female / male) × three measures.
 *
 * Two things this form forces, and both were already true of the schema:
 * district is a controlled vocabulary rather than free text, and branches are
 * modelled rather than assumed to be one.
 *
 * The age band is computed **as at the reporting date**, not at disbursement.
 * That is a choice, and the documentation does not make it
 * (02-BOT-REPORTING-SPEC.md §11.4) — so the reference date is a required
 * parameter rather than a default, and `ageBandAt` will not compute a band
 * without one. A borrower who turns 36 during the quarter moves between columns
 * depending on the answer, and on a form reporting youth lending that is not a
 * rounding difference.
 */

/** One borrower's exposure, placed geographically. */
export interface GeographicExposure {
  readonly districtCode: string;
  readonly clientId: string;
  readonly dateOfBirth: string;
  readonly gender: Gender;
  readonly loanCount: number;
  readonly outstanding: Money;
}

/** Branch and staff presence in a district, and the savings held there. */
export interface DistrictPresence {
  readonly districtCode: string;
  readonly branchCount: number;
  readonly employeeCount: number;
  /**
   * Cash collateral, loan insurance and compulsory savings held.
   *
   * Zero until savings exist as a module (stage 15). BOT validates this total
   * against MSP2-01, so a wrong figure here is a cross-form failure rather than
   * a quiet understatement — which is why it is an explicit input rather than
   * something this compiler invents.
   */
  readonly compulsorySavings: Money;
}

/** The twelve measure columns, keyed by band and gender. */
export interface DemographicCell {
  readonly borrowerCount: number;
  readonly loanCount: number;
  readonly outstanding: Money;
}

export type DemographicKey = `${AgeBand}_${Gender}`;

export interface Msp2_10Row {
  readonly districtCode: string;
  readonly regionCode: string;
  readonly branchCount: number;
  readonly employeeCount: number;
  readonly compulsorySavings: Money;
  readonly cells: Readonly<Record<DemographicKey, DemographicCell>>;
  readonly totalBorrowers: number;
  readonly totalOutstanding: Money;
}

export interface Msp2_10RegionSubtotal {
  readonly regionCode: string;
  readonly branchCount: number;
  readonly employeeCount: number;
  readonly compulsorySavings: Money;
  readonly totalBorrowers: number;
  readonly totalOutstanding: Money;
}

export interface Msp2_10 {
  readonly districts: readonly Msp2_10Row[];
  /** BOT prints a subtotal per region, and the validator reads them. */
  readonly regions: readonly Msp2_10RegionSubtotal[];
  readonly grandTotal: Msp2_10RegionSubtotal;
}

/** A district and the region it belongs to, from BOT's published hierarchy. */
export interface DistrictInHierarchy {
  readonly code: string;
  readonly regionCode: string;
}

export interface Msp2_10Request {
  readonly districts: readonly DistrictInHierarchy[];
  readonly exposures: readonly GeographicExposure[];
  readonly presence: readonly DistrictPresence[];
  /**
   * The date the age bands are measured at.
   *
   * Required, never defaulted. §11.4 asks whether BOT wants the band as at
   * disbursement or as at the reporting date, and a default would answer that
   * silently in every return the system files.
   */
  readonly asAt: Date;
}

const DEMOGRAPHIC_KEYS: readonly DemographicKey[] = [
  'up_to_35_female',
  'up_to_35_male',
  'above_35_female',
  'above_35_male',
];

function emptyCells(): Record<DemographicKey, DemographicCell> {
  return {
    up_to_35_female: { borrowerCount: 0, loanCount: 0, outstanding: Money.zero() },
    up_to_35_male: { borrowerCount: 0, loanCount: 0, outstanding: Money.zero() },
    above_35_female: { borrowerCount: 0, loanCount: 0, outstanding: Money.zero() },
    above_35_male: { borrowerCount: 0, loanCount: 0, outstanding: Money.zero() },
  };
}

export function compileMsp2_10(request: Msp2_10Request): Msp2_10 {
  if (request.districts.length === 0) {
    throw new DomainValidationError(
      'MSP2-10 cannot be compiled without the district hierarchy. Seed BOT reference data first.',
    );
  }

  const known = new Set(request.districts.map((district) => district.code));
  for (const exposure of request.exposures) {
    if (!known.has(exposure.districtCode)) {
      throw new DomainValidationError(
        `Exposure references district "${exposure.districtCode}", which is not one BOT publishes.`,
      );
    }
  }

  const presenceByDistrict = new Map(request.presence.map((entry) => [entry.districtCode, entry]));

  const districts = request.districts.map((district) => {
    const inDistrict = request.exposures.filter(
      (exposure) => exposure.districtCode === district.code,
    );
    const presence = presenceByDistrict.get(district.code);
    const cells = emptyCells();

    for (const exposure of inDistrict) {
      const band = ageBandAt(new Date(`${exposure.dateOfBirth}T00:00:00Z`), request.asAt);
      const key: DemographicKey = `${band}_${exposure.gender}`;
      const cell = cells[key];

      cells[key] = {
        // One row per borrower per district, so this counts borrowers rather
        // than loans — the two differ whenever anyone holds more than one.
        borrowerCount: cell.borrowerCount + 1,
        loanCount: cell.loanCount + exposure.loanCount,
        outstanding: cell.outstanding.plus(exposure.outstanding),
      };
    }

    return {
      districtCode: district.code,
      regionCode: district.regionCode,
      branchCount: presence?.branchCount ?? 0,
      employeeCount: presence?.employeeCount ?? 0,
      compulsorySavings: presence?.compulsorySavings ?? Money.zero(),
      cells,
      totalBorrowers: DEMOGRAPHIC_KEYS.reduce((total, key) => total + cells[key].borrowerCount, 0),
      totalOutstanding: Money.sum(DEMOGRAPHIC_KEYS.map((key) => cells[key].outstanding)),
    };
  });

  const regionCodes = [...new Set(request.districts.map((district) => district.regionCode))].sort();

  const regions = regionCodes.map((regionCode) =>
    subtotal(
      regionCode,
      districts.filter((district) => district.regionCode === regionCode),
    ),
  );

  return { districts, regions, grandTotal: subtotal('GRAND_TOTAL', districts) };
}

function subtotal(regionCode: string, rows: readonly Msp2_10Row[]): Msp2_10RegionSubtotal {
  return {
    regionCode,
    branchCount: rows.reduce((total, row) => total + row.branchCount, 0),
    employeeCount: rows.reduce((total, row) => total + row.employeeCount, 0),
    compulsorySavings: Money.sum(rows.map((row) => row.compulsorySavings)),
    totalBorrowers: rows.reduce((total, row) => total + row.totalBorrowers, 0),
    totalOutstanding: Money.sum(rows.map((row) => row.totalOutstanding)),
  };
}
