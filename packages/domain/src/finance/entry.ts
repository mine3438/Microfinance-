import { type Money } from '@mfi/money';

/**
 * Income and expenditure, as BOT wants it classified.
 *
 * There is no category taxonomy here, and that is the point. BOT's MSP2-02 has
 * forty-two numbered lines, and every figure an institution reports belongs to
 * exactly one of them — so the line *is* the category. The system being
 * replaced kept a free-text category enforced only in the browser, which meant
 * any string could reach a regulatory filing (00-PROJECT-ANALYSIS R12).
 *
 * The taxonomy is supplied by the caller rather than written down in this
 * module, for the same reason sectors and loan types are: it is BOT's data,
 * seeded from their template, and a second copy in TypeScript is a copy that
 * can disagree with the one the database enforces.
 */

/** Which side of the statement an entry falls on. */
export type FinanceDirection = 'income' | 'expense';

/** One MSP2-02 line, as BOT publishes it. */
export interface Msp2_02Line {
  readonly sno: number;
  readonly label: string;
  /** True where BOT's template derives the line rather than accepting entry. */
  readonly isComputed: boolean;
  /** Which side entries land on, or `null` for a computed line. */
  readonly entryDirection: FinanceDirection | null;
}

/** One recorded income or expense. */
export interface FinanceEntry {
  readonly sno: number;
  readonly direction: FinanceDirection;
  readonly amount: Money;
  /** Calendar date, `YYYY-MM-DD`. The quarter is derived, never typed. */
  readonly entryDate: string;
}
