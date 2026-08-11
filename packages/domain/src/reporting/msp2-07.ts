import { Money } from '@mfi/money';

import { DomainValidationError } from '../errors.js';

/**
 * MSP2-07 — Deposits and Borrowings with Banks, MSPs and MNOs.
 *
 * Four sections in BOT's fixed order, each row carrying the balance held in
 * TZS, the TZS equivalent of anything held in another currency, and the two
 * added together — separately for deposits and for borrowings.
 *
 * The foreign-currency column is the only place in this system where a figure
 * arrives already converted. Which rate BOT expects — their published rate,
 * the institution's bank rate, quarter-end spot — is unsettled
 * (02-BOT-REPORTING-SPEC.md §11.6), so the conversion happens where the
 * balance is recorded, with the rate and its date stored beside the result.
 * This compiler reports what was recorded; it does not convert anything, and
 * it could not, because it is not told what the rate was.
 */

/** BOT's four sections, in the order the form prints them. */
export const HOLDING_KINDS = [
  'bank_tanzania',
  'microfinance_service_provider',
  'mno',
  'bank_abroad',
] as const;

export type HoldingKind = (typeof HOLDING_KINDS)[number];

/** One counterparty's quarter-end position. */
export interface CounterpartyHolding {
  readonly kind: HoldingKind;
  /** How the row is labelled on the form. */
  readonly counterparty: string;
  /** Held in TZS. Zero for an account denominated in another currency. */
  readonly depositTzs: Money;
  readonly borrowingTzs: Money;
  /** TZS equivalent of a balance held in another currency. */
  readonly depositForeignTzsEquivalent: Money;
  readonly borrowingForeignTzsEquivalent: Money;
}

export interface Msp2_07Row {
  readonly counterparty: string;
  readonly depositTzs: Money;
  readonly depositForeignTzsEquivalent: Money;
  readonly depositTotal: Money;
  readonly borrowingTzs: Money;
  readonly borrowingForeignTzsEquivalent: Money;
  readonly borrowingTotal: Money;
}

export interface Msp2_07Section {
  readonly kind: HoldingKind;
  readonly rows: readonly Msp2_07Row[];
  readonly subtotal: Omit<Msp2_07Row, 'counterparty'>;
}

export interface Msp2_07 {
  readonly sections: readonly Msp2_07Section[];
  readonly total: Omit<Msp2_07Row, 'counterparty'>;
}

export interface Msp2_07Request {
  readonly holdings: readonly CounterpartyHolding[];
}

/**
 * Compile the form.
 *
 * Every section is present even when empty, because BOT's template prints all
 * four and an absent section reads as a missing figure rather than a nil one.
 *
 * @throws {DomainValidationError} when one counterparty appears twice in a
 * section, which would report a balance BOT expects once as two rows.
 */
export function compileMsp2_07(request: Msp2_07Request): Msp2_07 {
  const sections = HOLDING_KINDS.map((kind) => {
    const inSection = request.holdings.filter((holding) => holding.kind === kind);

    const seen = new Set<string>();
    for (const holding of inSection) {
      const key = holding.counterparty.trim().toLowerCase();
      if (seen.has(key)) {
        throw new DomainValidationError(
          `"${holding.counterparty}" appears twice under ${kind}. BOT reports one row per ` +
            'counterparty, so two would split a balance that must be filed whole.',
        );
      }
      seen.add(key);
    }

    const rows = inSection.map(rowFrom);

    return { kind, rows, subtotal: subtotalOf(rows) };
  });

  return { sections, total: subtotalOf(sections.flatMap((section) => section.rows)) };
}

function rowFrom(holding: CounterpartyHolding): Msp2_07Row {
  return {
    counterparty: holding.counterparty,
    depositTzs: holding.depositTzs,
    depositForeignTzsEquivalent: holding.depositForeignTzsEquivalent,
    depositTotal: holding.depositTzs.plus(holding.depositForeignTzsEquivalent),
    borrowingTzs: holding.borrowingTzs,
    borrowingForeignTzsEquivalent: holding.borrowingForeignTzsEquivalent,
    borrowingTotal: holding.borrowingTzs.plus(holding.borrowingForeignTzsEquivalent),
  };
}

function subtotalOf(rows: readonly Msp2_07Row[]): Omit<Msp2_07Row, 'counterparty'> {
  const sum = (pick: (row: Msp2_07Row) => Money): Money => Money.sum(rows.map(pick));

  return {
    depositTzs: sum((row) => row.depositTzs),
    depositForeignTzsEquivalent: sum((row) => row.depositForeignTzsEquivalent),
    // Summed from the row totals rather than from the two columns again, so a
    // subtotal cannot disagree with the rows it sits under.
    depositTotal: sum((row) => row.depositTotal),
    borrowingTzs: sum((row) => row.borrowingTzs),
    borrowingForeignTzsEquivalent: sum((row) => row.borrowingForeignTzsEquivalent),
    borrowingTotal: sum((row) => row.borrowingTotal),
  };
}
