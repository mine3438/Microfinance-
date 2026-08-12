import { z } from 'zod';

import { type Gender } from './clients.js';
import { HOLDING_KINDS } from './finance.js';
import { msp2_01Schema, msp2_05Schema } from './statements.js';
import { isoDateSchema, moneyAmountSchema } from './scalars.js';

/**
 * The BOT MSP2 quarterly return, as it travels.
 *
 * Every figure here is a string. That is not a stylistic choice about JSON: a
 * regulatory return is a document whose arithmetic BOT's own validator checks
 * to the cent, and a portfolio total of 4,231,908,776.35 does not survive a
 * round trip through a binary double. Serialising money as a number would put
 * the error inside the submission, where nothing downstream could detect it.
 *
 * The shapes below mirror the domain compilers in `@mfi/domain/reporting` field
 * for field, with `Money` rendered by `toDatabaseValue()` and `Percentage` by
 * `toFixed(4)`. Nothing on this side of the wire recomputes any of it — the web
 * client's job is to display and to export, and §2 keeps the arithmetic on the
 * server where one implementation produces one answer.
 */

/**
 * A percentage as this return reports it.
 *
 * Deliberately not `percentageSchema` from `scalars.ts`, which caps the whole
 * part at three digits because it describes a rate somebody types into a form.
 * Figures on this return are computed, and two of them can run large: an annual
 * rate is a monthly one multiplied by twelve, and MSP2-04's weighted average is
 * then doubled by BOT's own formula. A response schema that rejects a legitimate
 * figure turns a filing into a 500, so the reported form is given room —
 * six digits before the point, matching `NUMERIC(6,4)` at rest — while still
 * refusing a negative, which no percentage on this return can be.
 */
const reportedPercentageSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,5})(?:\.\d{1,4})?$/,
    'Must be a non-negative decimal with at most 4 decimal places.',
  );

/** BOT's five classification columns, in MSP2-03's own order. */
export const OVERDUE_CLASSIFICATIONS = [
  'current',
  'esm',
  'substandard',
  'doubtful',
  'loss',
] as const;

export type OverdueClassification = (typeof OVERDUE_CLASSIFICATIONS)[number];

/** The two amortisation columns MSP2-04 splits every loan type across. */
export const AMORTISATION_METHODS = ['straight_line', 'reducing_balance'] as const;

export type AmortisationMethod = (typeof AMORTISATION_METHODS)[number];

/**
 * How a monthly rate is stated per annum.
 *
 * `simple` multiplies by twelve; `effective` compounds. 5% a month is 60% one
 * way and 79.586% the other, and the documentation does not say which BOT reads
 * (02-BOT-REPORTING-SPEC.md §11.2). It is therefore a request parameter with a
 * stated default rather than a constant buried in the compiler, and the
 * convention actually applied is echoed back on the compiled form.
 */
export const ANNUALISATION_CONVENTIONS = ['simple', 'effective'] as const;

export type AnnualisationConvention = (typeof ANNUALISATION_CONVENTIONS)[number];

export const QUARTERS = [1, 2, 3, 4] as const;

/** The quarter a return covers, with both boundaries stated. */
export const reportingPeriodSchema = z
  .object({
    year: z.number().int().min(2000).max(9999),
    quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    /** First day of the quarter, inclusive. */
    startDate: isoDateSchema,
    /** Last day of the quarter, inclusive. */
    endDate: isoDateSchema,
  })
  .strict();

export type ReportingPeriod = z.infer<typeof reportingPeriodSchema>;

/** MSP2-03 — Sectoral Classification and Provisioning. */
export const msp2_03RowSchema = z
  .object({
    sectorCode: z.string(),
    borrowerCount: z.number().int().nonnegative(),
    totalOutstanding: moneyAmountSchema,
    outstandingByClass: z
      .object({
        current: moneyAmountSchema,
        esm: moneyAmountSchema,
        substandard: moneyAmountSchema,
        doubtful: moneyAmountSchema,
        loss: moneyAmountSchema,
      })
      .strict(),
    grossProvision: moneyAmountSchema,
    collateral: moneyAmountSchema,
    netProvision: moneyAmountSchema,
    /** Outstanding less the net provision — BOT's "Total (Net Amount)". */
    netAmount: moneyAmountSchema,
    /** A movement during the quarter, not a balance at the end of it. */
    writtenOffDuringPeriod: moneyAmountSchema,
  })
  .strict();

export const msp2_03Schema = z
  .object({
    rows: z.array(msp2_03RowSchema),
    total: msp2_03RowSchema,
    nonPerformingRatio: reportedPercentageSchema,
    /**
     * Loans no provisioning band covered.
     *
     * Above zero means the form is short by their value and says so nowhere
     * else — BOT's template has no unclassified column. The compilation is
     * refused before it reaches a caller, so a client that receives this field
     * populated is looking at a diagnostic, never at a filing.
     */
    unclassifiableLoanCount: z.number().int().nonnegative(),
  })
  .strict();

export type Msp2_03 = z.infer<typeof msp2_03Schema>;

/** The rate figures for one amortisation method within one loan type. */
export const rateBandSchema = z
  .object({
    /** `null` when no loan of this type uses this amortisation method. */
    lowest: reportedPercentageSchema.nullable(),
    highest: reportedPercentageSchema.nullable(),
    /**
     * BOT's weighted average, which is twice the weighted midpoint.
     *
     * Reproduced from the template's own cells rather than corrected, because
     * BOT's EDI validator is the authority on what a valid submission contains
     * (02-BOT-REPORTING-SPEC.md §5.1, §11.3).
     */
    weightedAverage: reportedPercentageSchema.nullable(),
  })
  .strict();

export const msp2_04RowSchema = z
  .object({
    botLoanType: z.string(),
    borrowerCount: z.number().int().nonnegative(),
    totalOutstanding: moneyAmountSchema,
    straightLine: rateBandSchema,
    reducingBalance: rateBandSchema,
  })
  .strict();

/** MSP2-04 — Interest Rate Structure. All rates are percent **per annum**. */
export const msp2_04Schema = z
  .object({
    rows: z.array(msp2_04RowSchema),
    total: msp2_04RowSchema.omit({ botLoanType: true }),
    /** Which conversion produced the annual rates above. */
    annualisation: z.enum(ANNUALISATION_CONVENTIONS),
  })
  .strict();

export type Msp2_04 = z.infer<typeof msp2_04Schema>;

const genderSplitSchema = z
  .object({ count: z.number().int().nonnegative(), amount: moneyAmountSchema })
  .strict();

export const msp2_09RowSchema = z
  .object({
    sectorCode: z.string(),
    female: genderSplitSchema,
    male: genderSplitSchema,
    total: genderSplitSchema,
  })
  .strict();

/**
 * MSP2-09 — Loans Disbursed by Gender and Sector.
 *
 * A flow, not a balance: what was advanced during the quarter, at the principal
 * advanced rather than the amount still owing.
 */
export const msp2_09Schema = z
  .object({ rows: z.array(msp2_09RowSchema), total: msp2_09RowSchema })
  .strict();

export type Msp2_09 = z.infer<typeof msp2_09Schema>;

export const AGE_BANDS = ['up_to_35', 'above_35'] as const;

export type AgeBand = (typeof AGE_BANDS)[number];

/** The four demographic columns MSP2-10 splits each district across. */
export type DemographicKey = `${AgeBand}_${Gender}`;

const demographicCellSchema = z
  .object({
    borrowerCount: z.number().int().nonnegative(),
    loanCount: z.number().int().nonnegative(),
    outstanding: moneyAmountSchema,
  })
  .strict();

export const msp2_10RowSchema = z
  .object({
    districtCode: z.string(),
    regionCode: z.string(),
    branchCount: z.number().int().nonnegative(),
    employeeCount: z.number().int().nonnegative(),
    compulsorySavings: moneyAmountSchema,
    cells: z
      .object({
        up_to_35_female: demographicCellSchema,
        up_to_35_male: demographicCellSchema,
        above_35_female: demographicCellSchema,
        above_35_male: demographicCellSchema,
      })
      .strict(),
    totalBorrowers: z.number().int().nonnegative(),
    totalOutstanding: moneyAmountSchema,
  })
  .strict();

export const msp2_10SubtotalSchema = z
  .object({
    regionCode: z.string(),
    branchCount: z.number().int().nonnegative(),
    employeeCount: z.number().int().nonnegative(),
    compulsorySavings: moneyAmountSchema,
    totalBorrowers: z.number().int().nonnegative(),
    totalOutstanding: moneyAmountSchema,
  })
  .strict();

/** MSP2-10 — Geographic Distribution: 193 districts within 31 regions. */
export const msp2_10Schema = z
  .object({
    districts: z.array(msp2_10RowSchema),
    regions: z.array(msp2_10SubtotalSchema),
    grandTotal: msp2_10SubtotalSchema,
  })
  .strict();

export type Msp2_10 = z.infer<typeof msp2_10Schema>;

/** MSP2-02 — Statement of Income and Expense. */
export const msp2_02RowSchema = z
  .object({
    sno: z.number().int().positive(),
    label: z.string(),
    isComputed: z.boolean(),
    /**
     * The quarter, and the fiscal year so far.
     *
     * Both can be negative: an institution whose interest expense exceeds its
     * interest income files a negative Sno13, and a loss is a negative Sno42.
     */
    quarterAmount: moneyAmountSchema,
    yearToDateAmount: moneyAmountSchema,
  })
  .strict();

export const msp2_02Schema = z
  .object({
    rows: z.array(msp2_02RowSchema),
    /** The window the year-to-date column covers, so a reader can check it. */
    yearToDateFrom: isoDateSchema,
    yearToDateTo: isoDateSchema,
  })
  .strict();

export type Msp2_02 = z.infer<typeof msp2_02Schema>;

const msp2_07AmountsSchema = z
  .object({
    depositTzs: moneyAmountSchema,
    depositForeignTzsEquivalent: moneyAmountSchema,
    depositTotal: moneyAmountSchema,
    borrowingTzs: moneyAmountSchema,
    borrowingForeignTzsEquivalent: moneyAmountSchema,
    borrowingTotal: moneyAmountSchema,
  })
  .strict();

export const msp2_07RowSchema = msp2_07AmountsSchema.extend({ counterparty: z.string() }).strict();

export const msp2_07SectionSchema = z
  .object({
    kind: z.enum(HOLDING_KINDS),
    rows: z.array(msp2_07RowSchema),
    subtotal: msp2_07AmountsSchema,
  })
  .strict();

/** MSP2-07 — Deposits and Borrowings with banks, MSPs and MNOs. */
export const msp2_07Schema = z
  .object({ sections: z.array(msp2_07SectionSchema), total: msp2_07AmountsSchema })
  .strict();

export type Msp2_07 = z.infer<typeof msp2_07Schema>;

/** MSP2-08 — Agent Banking Balances. */
export const msp2_08Schema = z
  .object({
    rows: z.array(z.object({ institutionCode: z.string(), balance: moneyAmountSchema }).strict()),
    total: moneyAmountSchema,
  })
  .strict();

export type Msp2_08 = z.infer<typeof msp2_08Schema>;

/** MSP2-06 — Complaints. A movement statement, not a snapshot. */
export const msp2_06RowSchema = z
  .object({
    sno: z.number().int().positive(),
    label: z.string(),
    /** True where BOT's template computes the line rather than taking it. */
    isComputed: z.boolean(),
    count: z.number().int().nonnegative(),
    /** The value in dispute across the same complaints the count counts. */
    value: moneyAmountSchema,
    /**
     * Count by BOT's nature code, one entry per published category.
     *
     * An object rather than a list because the caller needs to look one up by
     * code; the six keys are always present, including the empty ones, because
     * BOT's sheet has a column per category and a blank is not a zero.
     */
    byNature: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();

export const msp2_06Schema = z.object({ rows: z.array(msp2_06RowSchema) }).strict();

export type Msp2_06 = z.infer<typeof msp2_06Schema>;

export const VALIDATION_SEVERITIES = ['blocking', 'warning'] as const;

export type ValidationSeverity = (typeof VALIDATION_SEVERITIES)[number];

export const validationFindingSchema = z
  .object({
    /** The rule's identifier in BOT's own list, where it has one. */
    ruleId: z.number().int().nullable(),
    formCode: z.string(),
    severity: z.enum(VALIDATION_SEVERITIES),
    message: z.string(),
  })
  .strict();

export type ValidationFinding = z.infer<typeof validationFindingSchema>;

export const validationResultSchema = z
  .object({
    findings: z.array(validationFindingSchema),
    /** True when nothing blocking was found. Warnings do not stop a filing. */
    submittable: z.boolean(),
  })
  .strict();

export type ValidationResult = z.infer<typeof validationResultSchema>;

/**
 * A form BOT requires that this system cannot yet produce.
 *
 * Listed rather than omitted. A return screen showing four forms with nothing
 * said about the other six reads as a complete submission, and the institution
 * would discover otherwise at the filing desk.
 */
export const unavailableFormSchema = z.object({ code: z.string(), reason: z.string() }).strict();

export type UnavailableForm = z.infer<typeof unavailableFormSchema>;

/** The whole compiled return. */
export const compiledReturnSchema = z
  .object({
    period: reportingPeriodSchema,
    msp2_01: msp2_01Schema,
    msp2_02: msp2_02Schema,
    msp2_03: msp2_03Schema,
    msp2_04: msp2_04Schema,
    msp2_05: msp2_05Schema,
    msp2_06: msp2_06Schema,
    msp2_07: msp2_07Schema,
    msp2_08: msp2_08Schema,
    msp2_09: msp2_09Schema,
    msp2_10: msp2_10Schema,
    validation: validationResultSchema,
    unavailableForms: z.array(unavailableFormSchema),
  })
  .strict();

export type CompiledReturn = z.infer<typeof compiledReturnSchema>;

/** Options on the compile request, beyond the period named in the path. */
export const compileReturnQuerySchema = z
  .object({
    annualisation: z.enum(ANNUALISATION_CONVENTIONS).optional(),
    /**
     * Month the institution's fiscal year begins, 1–12.
     *
     * MSP2-02 carries a year-to-date column and §11.8 does not say whether that
     * year is the calendar year or the institution's own. A visible parameter
     * with a stated default (January) rather than a constant, following the
     * same treatment §16.1 gave the rate convention — and the window actually
     * used comes back on the form as `yearToDateFrom`.
     */
    fiscalYearStartMonth: z.coerce.number().int().min(1).max(12).optional(),
  })
  .strict();

export type CompileReturnQuery = z.infer<typeof compileReturnQuerySchema>;
