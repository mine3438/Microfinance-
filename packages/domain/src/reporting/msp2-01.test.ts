import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import { amountAt, compileMsp2_01, type Msp2_01Derived, type StatementLine } from './msp2-01.js';
import { compileMsp2_05 } from './msp2-05.js';

/**
 * The balance sheet, and the liquid-asset computation that reads it.
 *
 * The taxonomies below mirror what migration 0015 seeds. They are written out
 * rather than abbreviated because the compilers' contract is that they refuse a
 * taxonomy which is not BOT's — a fixture that quietly omitted a line would be
 * testing the refusal instead of the form.
 */

const MSP2_01_COMPUTED = new Set([1, 3, 8, 14, 17, 23, 26, 33, 35, 36, 42, 50, 51, 61]);
const MSP2_01_DERIVED = new Set([4, 5, 6, 7, 18, 22, 37, 38, 43, 46, 59]);
/** Sno34 is a heading BOT's own Total Liabilities formula does not read. */
const MSP2_01_HEADING = 34;

const MSP2_01_LINES: readonly StatementLine[] = Array.from({ length: 61 }, (_, index) => {
  const sno = index + 1;
  const isComputed = MSP2_01_COMPUTED.has(sno);
  return {
    sno,
    label: `MSP2-01 line ${String(sno)}`,
    isComputed,
    acceptsEntry: !isComputed && !MSP2_01_DERIVED.has(sno) && sno !== MSP2_01_HEADING,
  };
});

const MSP2_05_COMPUTED = new Set([1, 10, 11, 12, 13]);
const MSP2_05_RESTATED = new Set([2, 3, 4, 5]);

const MSP2_05_LINES: readonly StatementLine[] = Array.from({ length: 13 }, (_, index) => {
  const sno = index + 1;
  const isComputed = MSP2_05_COMPUTED.has(sno);
  return {
    sno,
    label: `MSP2-05 line ${String(sno)}`,
    isComputed,
    acceptsEntry: !isComputed && !MSP2_05_RESTATED.has(sno),
  };
});

const NIL_DERIVED: Msp2_01Derived = {
  nonAgentBankingBalances: Money.zero(),
  agentBankingBalances: Money.zero(),
  balancesWithMsps: Money.zero(),
  mnoFloatBalances: Money.zero(),
  loansToClients: Money.zero(),
  allowanceForProbableLosses: Money.zero(),
  borrowingsFromBanksInTanzania: Money.zero(),
  borrowingsFromMsps: Money.zero(),
  borrowingsFromAbroad: Money.zero(),
  compulsorySavings: Money.zero(),
  profitOrLoss: Money.zero(),
};

const entries = (values: Record<number, string>): Map<number, Money> =>
  new Map(Object.entries(values).map(([sno, amount]) => [Number(sno), Money.of(amount)]));

const at = (form: Parameters<typeof amountAt>[0], sno: number): string =>
  amountAt(form, sno).toDatabaseValue();

describe('compileMsp2_01', () => {
  it('places a derived figure without anyone entering it', () => {
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: new Map(),
      derived: { ...NIL_DERIVED, loansToClients: Money.of('4500000.00') },
    });

    expect(at(form, 18)).toBe('4500000.00');
    expect(form.rows.find((row) => row.sno === 18)?.source).toBe('derived');
  });

  it('subtracts the allowance from loans, as BOT’s formula does', () => {
    // Sno17 = 18 + 19 + 20 + 21 − 22. The allowance is entered positive on the
    // form and taken away by the formula, which is why it is not negated.
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries({ 21: '250000.00' }),
      derived: {
        ...NIL_DERIVED,
        loansToClients: Money.of('4500000.00'),
        allowanceForProbableLosses: Money.of('300000.00'),
      },
    });

    expect(at(form, 17)).toBe('4450000.00');
  });

  it('rolls every subtotal up to total assets', () => {
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      // Cash in hand, treasury bills, and property.
      entered: entries({ 2: '1000000.00', 9: '2000000.00', 24: '5000000.00' }),
      derived: {
        ...NIL_DERIVED,
        agentBankingBalances: Money.of('250000.00'),
        nonAgentBankingBalances: Money.of('750000.00'),
        loansToClients: Money.of('4500000.00'),
      },
    });

    expect(at(form, 3)).toBe('1000000.00'); // agent + non-agent
    expect(at(form, 1)).toBe('2000000.00'); // cash + banks
    expect(at(form, 8)).toBe('2000000.00'); // treasury bills
    expect(at(form, 17)).toBe('4500000.00');
    expect(at(form, 23)).toBe('5000000.00');
    // 2,000,000 + 2,000,000 + 0 + 4,500,000 + 5,000,000 + 0
    expect(at(form, 33)).toBe('13500000.00');
  });

  it('balances when liabilities and capital match assets', () => {
    // Rule 1 is the one check on this form that can genuinely fail, because
    // both sides are assembled from different figures.
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries({ 2: '13500000.00', 49: '3500000.00', 52: '10000000.00' }),
      derived: NIL_DERIVED,
    });

    expect(at(form, 33)).toBe('13500000.00');
    expect(at(form, 61)).toBe('13500000.00');
  });

  it('reports retained earnings as a negative figure rather than clamping it', () => {
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries({ 52: '10000000.00', 58: '-2500000.00' }),
      derived: NIL_DERIVED,
    });

    expect(at(form, 51)).toBe('7500000.00');
  });

  it('lists the lines nobody has filled in yet', () => {
    // Reported rather than refused: a balance sheet is assembled over days, and
    // a compiler that refused until all thirty-five were present would be
    // unusable during exactly the period it is needed.
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries({ 2: '1000.00' }),
      derived: NIL_DERIVED,
    });

    expect(form.missingEntries).toHaveLength(34);
    expect(form.missingEntries).not.toContain(2);
  });

  it('carries no row for the heading BOT’s own total does not read', () => {
    // Sno34 has a cell on the template, but Sno50 sums 35, 46, 47, 48 and 49.
    // A figure entered there would be reported nowhere.
    const form = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: new Map(),
      derived: NIL_DERIVED,
    });

    expect(form.rows.some((row) => row.sno === MSP2_01_HEADING)).toBe(false);
  });

  it('refuses a figure entered against a derived line', () => {
    expect(() =>
      compileMsp2_01({
        lines: MSP2_01_LINES,
        entered: entries({ 18: '9999.00' }),
        derived: NIL_DERIVED,
      }),
    ).toThrow(/derived from figures this system already holds/);
  });

  it('refuses a figure entered against a line BOT computes', () => {
    expect(() =>
      compileMsp2_01({
        lines: MSP2_01_LINES,
        entered: entries({ 33: '9999.00' }),
        derived: NIL_DERIVED,
      }),
    ).toThrow(/computed by BOT/);
  });

  it('refuses a taxonomy whose structure is not the one BOT published', () => {
    const revised = MSP2_01_LINES.map((line) =>
      line.sno === 33 ? { ...line, isComputed: false, acceptsEntry: true } : line,
    );

    expect(() =>
      compileMsp2_01({ lines: revised, entered: new Map(), derived: NIL_DERIVED }),
    ).toThrow(/may have been revised/);
  });
});

describe('compileMsp2_05', () => {
  const balanceSheetWith = (assets: Record<number, string>) =>
    compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries(assets),
      derived: NIL_DERIVED,
    });

  it('restates MSP2-01 rather than asking for the figures twice', () => {
    const balanceSheet = compileMsp2_01({
      lines: MSP2_01_LINES,
      entered: entries({ 2: '1000000.00' }),
      derived: { ...NIL_DERIVED, mnoFloatBalances: Money.of('300000.00') },
    });

    const form = compileMsp2_05({ lines: MSP2_05_LINES, entered: new Map(), balanceSheet });

    // Rule 5: MSP2-05 Sno2 = MSP2-01 Sno2, Sno5 = MSP2-01 Sno7.
    expect(form.rows.find((row) => row.sno === 2)?.amount.toDatabaseValue()).toBe('1000000.00');
    expect(form.rows.find((row) => row.sno === 5)?.amount.toDatabaseValue()).toBe('300000.00');
    expect(form.rows.find((row) => row.sno === 2)?.source).toBe('derived');
  });

  it('computes the 5% floor, the excess and the ratio', () => {
    const balanceSheet = balanceSheetWith({ 2: '10000000.00' });

    const form = compileMsp2_05({ lines: MSP2_05_LINES, entered: new Map(), balanceSheet });

    expect(form.totalAssets.toDatabaseValue()).toBe('10000000.00');
    expect(form.availableLiquidAssets.toDatabaseValue()).toBe('10000000.00');
    expect(form.requiredMinimum.toDatabaseValue()).toBe('500000.00');
    expect(form.excess.toDatabaseValue()).toBe('9500000.00');
    expect(form.liquidAssetRatio?.toFixed(4)).toBe('100.0000');
    expect(form.meetsRequirement).toBe(true);
  });

  it('reports a breach of the floor rather than only printing the ratio', () => {
    // Cash of 100,000 against total assets of 10,000,000 is 1%, below BOT's
    // 5%. A breach is a supervisory matter, and finding it at submission is too
    // late to act on.
    const balanceSheet = balanceSheetWith({ 2: '100000.00', 24: '9900000.00' });

    const form = compileMsp2_05({ lines: MSP2_05_LINES, entered: new Map(), balanceSheet });

    expect(form.meetsRequirement).toBe(false);
    expect(form.excess.toDatabaseValue()).toBe('-400000.00');
    expect(form.liquidAssetRatio?.toFixed(4)).toBe('1.0000');
  });

  it('adds the entered securities into available liquid assets', () => {
    const balanceSheet = balanceSheetWith({ 2: '1000000.00' });

    const form = compileMsp2_05({
      lines: MSP2_05_LINES,
      entered: entries({ 6: '2000000.00', 9: '500000.00' }),
      balanceSheet,
    });

    expect(form.availableLiquidAssets.toDatabaseValue()).toBe('3500000.00');
  });

  it('reports no ratio at all when there are no assets to measure against', () => {
    const balanceSheet = balanceSheetWith({});

    const form = compileMsp2_05({ lines: MSP2_05_LINES, entered: new Map(), balanceSheet });

    // Undefined, not zero: 0% would say an institution holds no liquidity when
    // in fact it holds nothing at all.
    expect(form.liquidAssetRatio).toBeNull();
    expect(form.meetsRequirement).toBe(true);
  });

  it('refuses a figure entered against a line that restates MSP2-01', () => {
    const balanceSheet = balanceSheetWith({ 2: '1000000.00' });

    expect(() =>
      compileMsp2_05({
        lines: MSP2_05_LINES,
        entered: entries({ 2: '9999.00' }),
        balanceSheet,
      }),
    ).toThrow(DomainValidationError);
  });
});
