import { Money, Percentage } from '@mfi/money';

import { DomainValidationError } from '../errors.js';
import {
  TOTAL_ASSETS_SNO,
  amountAt,
  type LineSource,
  type Msp2_01,
  type StatementLine,
} from './msp2-01.js';

/**
 * MSP2-05 — Computation of Liquid Assets.
 *
 * **A prudential requirement, not a disclosure.** BOT sets a floor of 5% of
 * total assets, and an institution below it is in breach — a supervisory
 * matter, not a filing error. Discovering that at quarter-end submission is too
 * late to act on, which is why this compiler reports the shortfall and whether
 * the floor is met rather than only printing the ratio
 * (02-BOT-REPORTING-SPEC.md §6).
 *
 * Four of its thirteen lines restate MSP2-01 (rule 5) and are derived from the
 * compiled balance sheet rather than typed a second time; four are entered;
 * five are computed.
 */

/** BOT's floor: liquid assets must be at least this share of total assets. */
export const MINIMUM_LIQUID_ASSET_RATIO = Percentage.of('5');

/** Which MSP2-01 line each restated MSP2-05 line reads (rule 5). */
const RESTATED_FROM_MSP2_01: Readonly<Record<number, number>> = Object.freeze({
  2: 2, // Cash in hand
  3: 3, // Balances with banks and financial institutions
  4: 6, // Balances with microfinance service providers
  5: 7, // MNO float
});

/** Sno1 — total available liquid assets, the sum of Sno2 through Sno9. */
const AVAILABLE_SNO = 1;
const TOTAL_ASSETS_LINE = 10;
const REQUIRED_MINIMUM_SNO = 11;
const EXCESS_SNO = 12;
/** Sno13 is the ratio, which is a percentage rather than an amount. */
const RATIO_SNO = 13;

export interface Msp2_05Row {
  readonly sno: number;
  readonly label: string;
  readonly source: LineSource;
  readonly amount: Money;
}

export interface Msp2_05 {
  /** Sno1 to Sno12. The ratio is reported separately, being a percentage. */
  readonly rows: readonly Msp2_05Row[];
  readonly availableLiquidAssets: Money;
  readonly totalAssets: Money;
  readonly requiredMinimum: Money;
  /** Negative when the institution is short of BOT's floor. */
  readonly excess: Money;
  /**
   * Liquid assets as a share of total assets.
   *
   * `null` when total assets are nil: a ratio over nothing is undefined, not
   * zero, and reporting 0% would say an institution holds no liquidity when in
   * fact it holds no assets.
   */
  readonly liquidAssetRatio: Percentage | null;
  /** False when the institution is below BOT's 5% floor. */
  readonly meetsRequirement: boolean;
}

export interface Msp2_05Request {
  /** Every MSP2-05 line BOT publishes, in Sno order. */
  readonly lines: readonly StatementLine[];
  readonly entered: ReadonlyMap<number, Money>;
  /** The compiled balance sheet, which four lines and the total read from. */
  readonly balanceSheet: Msp2_01;
}

/**
 * Compile the form.
 *
 * @throws {DomainValidationError} when the taxonomy is absent or a figure was
 * entered against a line that does not accept one.
 */
export function compileMsp2_05(request: Msp2_05Request): Msp2_05 {
  if (request.lines.length === 0) {
    throw new DomainValidationError(
      'MSP2-05 cannot be compiled without its line taxonomy. Seed BOT reference data first.',
    );
  }

  const byLine = new Map(request.lines.map((line) => [line.sno, line]));

  for (const sno of request.entered.keys()) {
    const line = byLine.get(sno);
    if (line === undefined) {
      throw new DomainValidationError(
        `A figure was entered against MSP2-05 line ${String(sno)}, which BOT does not publish.`,
      );
    }
    if (!line.acceptsEntry) {
      throw new DomainValidationError(
        `“${line.label}” is not entered: it restates MSP2-01 or is computed from the lines above it.`,
      );
    }
  }

  const amounts = new Map<number, Money>();

  for (const line of request.lines) {
    const restated = RESTATED_FROM_MSP2_01[line.sno];
    if (restated !== undefined) {
      amounts.set(line.sno, amountAt(request.balanceSheet, restated));
    } else if (line.acceptsEntry) {
      amounts.set(line.sno, request.entered.get(line.sno) ?? Money.zero());
    }
  }

  // Sno1 = Sno2..Sno9, which is the four restated lines plus the four entered.
  const available = Money.sum(
    [2, 3, 4, 5, 6, 7, 8, 9].map((sno) => amounts.get(sno) ?? Money.zero()),
  );
  const totalAssets = amountAt(request.balanceSheet, TOTAL_ASSETS_SNO);
  const required = totalAssets.applyPercentage(MINIMUM_LIQUID_ASSET_RATIO);
  const excess = available.minus(required);

  amounts.set(AVAILABLE_SNO, available);
  amounts.set(TOTAL_ASSETS_LINE, totalAssets);
  amounts.set(REQUIRED_MINIMUM_SNO, required);
  amounts.set(EXCESS_SNO, excess);

  const ratio = totalAssets.isZero()
    ? null
    : Percentage.of(available.dividedByExact(totalAssets.toDatabaseValue()).times(100));

  return {
    rows: request.lines
      .filter((line) => line.sno !== RATIO_SNO && amounts.has(line.sno))
      .map((line) => ({
        sno: line.sno,
        label: line.label,
        source: sourceOf(line, RESTATED_FROM_MSP2_01[line.sno] !== undefined),
        amount: amounts.get(line.sno) ?? Money.zero(),
      })),
    availableLiquidAssets: available,
    totalAssets,
    requiredMinimum: required,
    excess,
    liquidAssetRatio: ratio,
    // An institution with no assets at all is not in breach of a ratio; it has
    // nothing to be liquid against. Anything else is measured against the floor.
    meetsRequirement: totalAssets.isZero() || !excess.isNegative(),
  };
}

function sourceOf(line: StatementLine, restated: boolean): LineSource {
  if (line.isComputed) {
    return 'computed';
  }
  return restated ? 'derived' : 'entered';
}
