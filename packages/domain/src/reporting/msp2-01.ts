import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * MSP2-01 — Balance Sheet.
 *
 * Sixty-one lines, of which this system can answer eleven. The rest are
 * accounting balances no operational lending system holds, which is why §9 of
 * the reporting specification chose Option 1: the institution enters them
 * quarterly and everything derivable is filled in and locked.
 *
 * Three kinds of line, and the distinction is the whole design:
 *
 * - **computed** — BOT's own formula, from the lines above it;
 * - **derived** — this system knows the answer (the loan book, the
 *   provisioning engine, MSP2-07, MSP2-08, MSP2-02), so nothing is typed;
 * - **entered** — the institution's own figure.
 *
 * A derived line is locked by having nowhere to write rather than by a flag
 * somebody could clear: `financial_statement_lines` has no row for one, and the
 * schema refuses to accept it. Every derived line is named either by §9's list
 * or by a BOT cross-validation rule, so none of them is this system's opinion
 * about what an institution's balance sheet should say.
 */

/** Where a figure on the form came from. */
export type LineSource = 'computed' | 'derived' | 'entered';

/** One line of BOT's balance sheet, as published. */
export interface StatementLine {
  readonly sno: number;
  readonly label: string;
  readonly isComputed: boolean;
  /** True where the institution types the figure in. */
  readonly acceptsEntry: boolean;
}

/**
 * What this system answers on the balance sheet.
 *
 * Every field maps to exactly one Sno, listed beside it. Supplied as a whole
 * rather than line by line so a caller cannot leave one out and have it
 * silently report zero.
 */
export interface Msp2_01Derived {
  /** Sno4 — non-agent banking balances, from MSP2-07 less agent banking. */
  readonly nonAgentBankingBalances: Money;
  /** Sno5 — agent-banking balances, from MSP2-08 (rule 15). */
  readonly agentBankingBalances: Money;
  /** Sno6 — balances with microfinance service providers (rule 10). */
  readonly balancesWithMsps: Money;
  /** Sno7 — MNO float balances (rule 11). */
  readonly mnoFloatBalances: Money;
  /** Sno18 — loans to clients, from the loan book. */
  readonly loansToClients: Money;
  /** Sno22 — allowance for probable losses, from the provisioning engine. */
  readonly allowanceForProbableLosses: Money;
  /** Sno37 — borrowings from banks and financial institutions (rule 9). */
  readonly borrowingsFromBanksInTanzania: Money;
  /** Sno38 — borrowings from other microfinance providers (rule 10). */
  readonly borrowingsFromMsps: Money;
  /** Sno43 — borrowings from banks abroad (rule 13). */
  readonly borrowingsFromAbroad: Money;
  /** Sno46 — cash collateral, loan insurance and compulsory savings (rule 16). */
  readonly compulsorySavings: Money;
  /** Sno59 — profit or loss, from MSP2-02's year-to-date Sno42 (rule 2). */
  readonly profitOrLoss: Money;
}

const DERIVED_BY_SNO: Readonly<Record<number, keyof Msp2_01Derived>> = Object.freeze({
  4: 'nonAgentBankingBalances',
  5: 'agentBankingBalances',
  6: 'balancesWithMsps',
  7: 'mnoFloatBalances',
  18: 'loansToClients',
  22: 'allowanceForProbableLosses',
  37: 'borrowingsFromBanksInTanzania',
  38: 'borrowingsFromMsps',
  43: 'borrowingsFromAbroad',
  46: 'compulsorySavings',
  59: 'profitOrLoss',
});

interface Composition {
  readonly sno: number;
  readonly plus: readonly number[];
  readonly minus: readonly number[];
}

/**
 * BOT's own arithmetic, by Sno, in an order that resolves dependencies.
 *
 * Sno3 before Sno1 because Sno1 contains it; Sno36 and Sno42 before Sno35;
 * Sno35 before Sno50. A subtotal computed before its parts would report the
 * zero it started as.
 */
const COMPOSITION: readonly Composition[] = Object.freeze([
  { sno: 3, plus: [4, 5], minus: [] },
  { sno: 1, plus: [2, 3, 6, 7], minus: [] },
  { sno: 8, plus: [9, 10, 11, 12], minus: [13] },
  { sno: 14, plus: [15], minus: [16] },
  { sno: 17, plus: [18, 19, 20, 21], minus: [22] },
  { sno: 23, plus: [24], minus: [25] },
  { sno: 26, plus: [27, 28, 29, 30, 31], minus: [32] },
  { sno: 33, plus: [1, 8, 14, 17, 23, 26], minus: [] },
  { sno: 36, plus: [37, 38, 39, 40, 41], minus: [] },
  { sno: 42, plus: [43, 44, 45], minus: [] },
  { sno: 35, plus: [36, 42], minus: [] },
  { sno: 50, plus: [35, 46, 47, 48, 49], minus: [] },
  { sno: 51, plus: [52, 53, 54, 55, 56, 57, 58, 59, 60], minus: [] },
  { sno: 61, plus: [50, 51], minus: [] },
]);

/** Sno33, Total Assets — the figure MSP2-05 and rule 1 both read. */
export const TOTAL_ASSETS_SNO = 33;
/** Sno61, Total Liabilities and Capital. */
export const TOTAL_LIABILITIES_AND_CAPITAL_SNO = 61;

export interface Msp2_01Row {
  readonly sno: number;
  readonly label: string;
  readonly source: LineSource;
  readonly amount: Money;
}

export interface Msp2_01 {
  readonly rows: readonly Msp2_01Row[];
  /** Lines the institution has not filled in yet, by Sno. */
  readonly missingEntries: readonly number[];
}

export interface Msp2_01Request {
  /** Every MSP2-01 line BOT publishes, in Sno order. */
  readonly lines: readonly StatementLine[];
  /** Figures the institution entered, by Sno. */
  readonly entered: ReadonlyMap<number, Money>;
  readonly derived: Msp2_01Derived;
}

/**
 * Compile the balance sheet.
 *
 * An entered line with no figure reports zero and is listed in
 * `missingEntries`. Reported rather than refused: a balance sheet is assembled
 * over days as figures arrive from elsewhere in the institution, and a compiler
 * that refused until every one of thirty-five lines was filled would be
 * unusable during exactly the period it is needed. Whether the result may be
 * *filed* is a separate question, and rule 1 answers it — an incomplete sheet
 * does not balance.
 *
 * @throws {DomainValidationError} when the supplied lines are not BOT's, or
 * when a figure was entered against a line that does not accept one.
 */
export function compileMsp2_01(request: Msp2_01Request): Msp2_01 {
  if (request.lines.length === 0) {
    throw new DomainValidationError(
      'MSP2-01 cannot be compiled without its line taxonomy. Seed BOT reference data first.',
    );
  }

  const byLine = new Map(request.lines.map((line) => [line.sno, line]));

  for (const rule of COMPOSITION) {
    const line = byLine.get(rule.sno);
    if (line?.isComputed !== true) {
      throw new DomainValidationError(
        `MSP2-01 line ${String(rule.sno)} is expected to be computed from other lines, but the ` +
          'supplied taxonomy does not describe it that way. BOT’s template may have been revised.',
      );
    }
  }

  for (const sno of request.entered.keys()) {
    const line = byLine.get(sno);
    if (line === undefined) {
      throw new DomainValidationError(
        `A figure was entered against MSP2-01 line ${String(sno)}, which BOT does not publish.`,
      );
    }
    if (!line.acceptsEntry) {
      throw new DomainValidationError(
        `“${line.label}” is not entered: it is ${line.isComputed ? 'computed by BOT’s template' : 'derived from figures this system already holds'}.`,
      );
    }
  }

  const amounts = new Map<number, Money>();

  for (const line of request.lines) {
    if (line.isComputed) {
      continue;
    }

    const derivedField = DERIVED_BY_SNO[line.sno];
    if (derivedField !== undefined) {
      amounts.set(line.sno, request.derived[derivedField]);
    } else if (line.acceptsEntry) {
      amounts.set(line.sno, request.entered.get(line.sno) ?? Money.zero());
    }
    // Anything left is a section heading, which carries no figure. Sno34
    // ("8. LIABILITIES") is the only one: BOT's template gives it a cell, but
    // Sno50 does not read it, so a figure there would be reported nowhere.
  }

  for (const rule of COMPOSITION) {
    const added = Money.sum(rule.plus.map((sno) => amounts.get(sno) ?? Money.zero()));
    const subtracted = Money.sum(rule.minus.map((sno) => amounts.get(sno) ?? Money.zero()));
    amounts.set(rule.sno, added.minus(subtracted));
  }

  const rows = request.lines
    .filter((line) => amounts.has(line.sno))
    .map((line) => ({
      sno: line.sno,
      label: line.label,
      source: sourceOf(line),
      amount: amounts.get(line.sno) ?? Money.zero(),
    }));

  return {
    rows,
    missingEntries: request.lines
      .filter((line) => line.acceptsEntry && !request.entered.has(line.sno))
      .map((line) => line.sno),
  };
}

function sourceOf(line: StatementLine): LineSource {
  if (line.isComputed) {
    return 'computed';
  }
  return line.acceptsEntry ? 'entered' : 'derived';
}

/** One line's amount from a compiled form, or zero where it has none. */
export function amountAt(form: { rows: readonly Msp2_01Row[] }, sno: number): Money {
  return form.rows.find((row) => row.sno === sno)?.amount ?? Money.zero();
}
