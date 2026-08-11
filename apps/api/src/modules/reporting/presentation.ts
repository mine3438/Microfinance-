import {
  type CompiledReturn as WireCompiledReturn,
  type Msp2_01 as WireMsp2_01,
  type Msp2_02 as WireMsp2_02,
  type Msp2_03 as WireMsp2_03,
  type Msp2_04 as WireMsp2_04,
  type Msp2_05 as WireMsp2_05,
  type Msp2_07 as WireMsp2_07,
  type Msp2_08 as WireMsp2_08,
  type Msp2_09 as WireMsp2_09,
  type Msp2_10 as WireMsp2_10,
} from '@mfi/contracts';
import {
  type Msp2_01,
  type Msp2_02,
  type Msp2_03,
  type Msp2_03Row,
  type Msp2_04,
  type Msp2_04Row,
  type Msp2_05,
  type Msp2_07,
  type Msp2_07Row,
  type Msp2_07Section,
  type Msp2_08,
  type Msp2_09,
  type Msp2_09Row,
  type Msp2_10,
  type Msp2_10RegionSubtotal,
  type Msp2_10Row,
  type RateBand,
} from '@mfi/domain';
import { type Money, type Percentage } from '@mfi/money';

import { type CompiledReturn } from './use-cases.js';

/**
 * The compiled return, rendered for the wire.
 *
 * The only place `Money` and `Percentage` become text on this route, and it is
 * separate from the compilers on purpose. A domain form holds exact decimal
 * values; a response holds strings. Letting the two be the same object would
 * mean either the domain imports a serialisation concern or the transport
 * carries arithmetic types — and the second one ends with somebody adding two
 * strings in a browser.
 *
 * Rounding happens here and only here. Money is already at two decimal places
 * by construction, so `toDatabaseValue()` loses nothing. Percentages are exact
 * quotients that can run to arbitrary length — a provision-weighted average
 * divides by a portfolio total — and BOT's forms report four places, so four is
 * where they are rounded, once, at the boundary.
 */

const money = (value: Money): string => value.toDatabaseValue();

/** BOT reports rates and ratios to four decimal places. */
const PERCENTAGE_PLACES = 4;

const percentage = (value: Percentage): string => value.toFixed(PERCENTAGE_PLACES);

const optionalPercentage = (value: Percentage | null): string | null =>
  value === null ? null : percentage(value);

function msp2_03Row(row: Msp2_03Row): WireMsp2_03['rows'][number] {
  return {
    sectorCode: row.sectorCode,
    borrowerCount: row.borrowerCount,
    totalOutstanding: money(row.totalOutstanding),
    outstandingByClass: {
      current: money(row.outstandingByClass.current),
      esm: money(row.outstandingByClass.esm),
      substandard: money(row.outstandingByClass.substandard),
      doubtful: money(row.outstandingByClass.doubtful),
      loss: money(row.outstandingByClass.loss),
    },
    grossProvision: money(row.grossProvision),
    collateral: money(row.collateral),
    netProvision: money(row.netProvision),
    netAmount: money(row.netAmount),
    writtenOffDuringPeriod: money(row.writtenOffDuringPeriod),
  };
}

function rateBand(band: RateBand): WireMsp2_04['rows'][number]['straightLine'] {
  return {
    lowest: optionalPercentage(band.lowest),
    highest: optionalPercentage(band.highest),
    weightedAverage: optionalPercentage(band.weightedAverage),
  };
}

function msp2_04Row(row: Msp2_04Row): WireMsp2_04['rows'][number] {
  return {
    botLoanType: row.botLoanType,
    borrowerCount: row.borrowerCount,
    totalOutstanding: money(row.totalOutstanding),
    straightLine: rateBand(row.straightLine),
    reducingBalance: rateBand(row.reducingBalance),
  };
}

function msp2_09Row(row: Msp2_09Row): WireMsp2_09['rows'][number] {
  const split = (value: Msp2_09Row['female']): WireMsp2_09['rows'][number]['female'] => ({
    count: value.count,
    amount: money(value.amount),
  });

  return {
    sectorCode: row.sectorCode,
    female: split(row.female),
    male: split(row.male),
    total: split(row.total),
  };
}

function msp2_10Row(row: Msp2_10Row): WireMsp2_10['districts'][number] {
  const cell = (
    key: keyof Msp2_10Row['cells'],
  ): WireMsp2_10['districts'][number]['cells']['up_to_35_female'] => ({
    borrowerCount: row.cells[key].borrowerCount,
    loanCount: row.cells[key].loanCount,
    outstanding: money(row.cells[key].outstanding),
  });

  return {
    districtCode: row.districtCode,
    regionCode: row.regionCode,
    branchCount: row.branchCount,
    employeeCount: row.employeeCount,
    compulsorySavings: money(row.compulsorySavings),
    cells: {
      up_to_35_female: cell('up_to_35_female'),
      up_to_35_male: cell('up_to_35_male'),
      above_35_female: cell('above_35_female'),
      above_35_male: cell('above_35_male'),
    },
    totalBorrowers: row.totalBorrowers,
    totalOutstanding: money(row.totalOutstanding),
  };
}

function msp2_10Subtotal(subtotal: Msp2_10RegionSubtotal): WireMsp2_10['grandTotal'] {
  return {
    regionCode: subtotal.regionCode,
    branchCount: subtotal.branchCount,
    employeeCount: subtotal.employeeCount,
    compulsorySavings: money(subtotal.compulsorySavings),
    totalBorrowers: subtotal.totalBorrowers,
    totalOutstanding: money(subtotal.totalOutstanding),
  };
}

/** A statement row, which names where its figure came from. */
const statementRow = (row: {
  sno: number;
  label: string;
  source: 'computed' | 'derived' | 'entered';
  amount: Money;
}): WireMsp2_01['rows'][number] => ({
  sno: row.sno,
  label: row.label,
  source: row.source,
  amount: money(row.amount),
});

export function presentMsp2_01(form: Msp2_01): WireMsp2_01 {
  return {
    rows: form.rows.map(statementRow),
    missingEntries: [...form.missingEntries],
  };
}

export function presentMsp2_05(form: Msp2_05): WireMsp2_05 {
  return {
    rows: form.rows.map(statementRow),
    availableLiquidAssets: money(form.availableLiquidAssets),
    totalAssets: money(form.totalAssets),
    requiredMinimum: money(form.requiredMinimum),
    excess: money(form.excess),
    liquidAssetRatio: form.liquidAssetRatio === null ? null : percentage(form.liquidAssetRatio),
    meetsRequirement: form.meetsRequirement,
  };
}

export function presentMsp2_02(form: Msp2_02): WireMsp2_02 {
  return {
    rows: form.rows.map((row) => ({
      sno: row.sno,
      label: row.label,
      isComputed: row.isComputed,
      quarterAmount: money(row.quarterAmount),
      yearToDateAmount: money(row.yearToDateAmount),
    })),
    yearToDateFrom: form.yearToDateFrom,
    yearToDateTo: form.yearToDateTo,
  };
}

function msp2_07Amounts(row: Msp2_07Row | Omit<Msp2_07Row, 'counterparty'>): WireMsp2_07['total'] {
  return {
    depositTzs: money(row.depositTzs),
    depositForeignTzsEquivalent: money(row.depositForeignTzsEquivalent),
    depositTotal: money(row.depositTotal),
    borrowingTzs: money(row.borrowingTzs),
    borrowingForeignTzsEquivalent: money(row.borrowingForeignTzsEquivalent),
    borrowingTotal: money(row.borrowingTotal),
  };
}

function msp2_07Section(section: Msp2_07Section): WireMsp2_07['sections'][number] {
  return {
    kind: section.kind,
    rows: section.rows.map((row) => ({
      counterparty: row.counterparty,
      ...msp2_07Amounts(row),
    })),
    subtotal: msp2_07Amounts(section.subtotal),
  };
}

export function presentMsp2_07(form: Msp2_07): WireMsp2_07 {
  return {
    sections: form.sections.map(msp2_07Section),
    total: msp2_07Amounts(form.total),
  };
}

export function presentMsp2_08(form: Msp2_08): WireMsp2_08 {
  return {
    rows: form.rows.map((row) => ({
      institutionCode: row.institutionCode,
      balance: money(row.balance),
    })),
    total: money(form.total),
  };
}

export function presentMsp2_03(form: Msp2_03): WireMsp2_03 {
  return {
    rows: form.rows.map(msp2_03Row),
    total: msp2_03Row(form.total),
    nonPerformingRatio: percentage(form.nonPerformingRatio),
    unclassifiableLoanCount: form.unclassifiableLoanCount,
  };
}

export function presentMsp2_04(form: Msp2_04): WireMsp2_04 {
  return {
    rows: form.rows.map(msp2_04Row),
    total: {
      borrowerCount: form.total.borrowerCount,
      totalOutstanding: money(form.total.totalOutstanding),
      straightLine: rateBand(form.total.straightLine),
      reducingBalance: rateBand(form.total.reducingBalance),
    },
    annualisation: form.annualisation,
  };
}

export function presentMsp2_09(form: Msp2_09): WireMsp2_09 {
  return { rows: form.rows.map(msp2_09Row), total: msp2_09Row(form.total) };
}

export function presentMsp2_10(form: Msp2_10): WireMsp2_10 {
  return {
    districts: form.districts.map(msp2_10Row),
    regions: form.regions.map(msp2_10Subtotal),
    grandTotal: msp2_10Subtotal(form.grandTotal),
  };
}

export function presentCompiledReturn(compiled: CompiledReturn): WireCompiledReturn {
  return {
    period: {
      year: compiled.period.year,
      quarter: compiled.period.quarter,
      startDate: compiled.period.startDate,
      endDate: compiled.period.endDate,
    },
    msp2_01: presentMsp2_01(compiled.msp2_01),
    msp2_02: presentMsp2_02(compiled.msp2_02),
    msp2_03: presentMsp2_03(compiled.msp2_03),
    msp2_04: presentMsp2_04(compiled.msp2_04),
    msp2_05: presentMsp2_05(compiled.msp2_05),
    msp2_07: presentMsp2_07(compiled.msp2_07),
    msp2_08: presentMsp2_08(compiled.msp2_08),
    msp2_09: presentMsp2_09(compiled.msp2_09),
    msp2_10: presentMsp2_10(compiled.msp2_10),
    validation: {
      findings: compiled.validation.findings.map((finding) => ({
        ruleId: finding.ruleId,
        formCode: finding.formCode,
        severity: finding.severity,
        message: finding.message,
      })),
      submittable: compiled.validation.submittable,
    },
    unavailableForms: compiled.unavailableForms.map((form) => ({
      code: form.code,
      reason: form.reason,
    })),
  };
}
