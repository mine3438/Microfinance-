import { z } from 'zod';

import { moneyAmountSchema } from './scalars.js';

/**
 * The quarterly financial-statement dataset.
 *
 * MSP2-01 and MSP2-05 are the two forms an institution fills in, and only
 * partly: every line this system can answer is derived and locked. "Locked" is
 * not a flag a client honours — the database refuses a figure against a derived
 * line — but the shape below carries the distinction so a screen can show a
 * total without offering to let anyone type over it.
 */

/** Where a figure on a statement came from. */
export const LINE_SOURCES = ['computed', 'derived', 'entered'] as const;

export type LineSource = (typeof LINE_SOURCES)[number];

/** The two forms this dataset covers. */
export const STATEMENT_FORMS = ['MSP2-01', 'MSP2-05'] as const;

export type StatementForm = (typeof STATEMENT_FORMS)[number];

export const statementRowSchema = z
  .object({
    sno: z.number().int().positive(),
    label: z.string(),
    source: z.enum(LINE_SOURCES),
    amount: moneyAmountSchema,
  })
  .strict();

export type StatementRow = z.infer<typeof statementRowSchema>;

/** MSP2-01, compiled. */
export const msp2_01Schema = z
  .object({
    rows: z.array(statementRowSchema),
    /**
     * Entered lines nobody has filled in yet.
     *
     * Reported rather than refused: a balance sheet is assembled over days as
     * figures arrive from elsewhere in the institution. Whether it may be
     * *filed* is rule 1's question — an incomplete sheet does not balance.
     */
    missingEntries: z.array(z.number().int().positive()),
  })
  .strict();

export type Msp2_01 = z.infer<typeof msp2_01Schema>;

/** MSP2-05, compiled. The ratio is a percentage, so it sits beside the rows. */
export const msp2_05Schema = z
  .object({
    rows: z.array(statementRowSchema),
    availableLiquidAssets: moneyAmountSchema,
    totalAssets: moneyAmountSchema,
    requiredMinimum: moneyAmountSchema,
    /** Negative when the institution is short of BOT's 5% floor. */
    excess: moneyAmountSchema,
    /** `null` when there are no assets to measure against. */
    liquidAssetRatio: z.string().nullable(),
    /**
     * False when the institution is below BOT's floor.
     *
     * A prudential matter rather than a filing one: a breach is supervisory,
     * and discovering it at submission is too late to act on
     * (02-BOT-REPORTING-SPEC.md §6).
     */
    meetsRequirement: z.boolean(),
  })
  .strict();

export type Msp2_05 = z.infer<typeof msp2_05Schema>;

export const statementLineInputSchema = z
  .object({
    sno: z.number().int().positive(),
    /**
     * Signed. A balance sheet carries deduction lines BOT subtracts rather
     * than negates, but retained earnings can genuinely be negative and
     * clamping one at zero would file a figure that is not the institution's.
     */
    amount: moneyAmountSchema,
  })
  .strict();

export const saveStatementLinesRequestSchema = z
  .object({
    lines: z.array(statementLineInputSchema).min(1).max(100),
  })
  .strict();

export type SaveStatementLinesRequest = z.infer<typeof saveStatementLinesRequestSchema>;
