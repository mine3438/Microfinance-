import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import {
  compareDecimalStrings,
  isoDateSchema,
  isoTimestampSchema,
  nonNegativeMoneyAmountSchema,
  positiveMoneyAmountSchema,
  rateFractionSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

/**
 * Loan applications, their schedules, and the workflow that moves them.
 *
 * Every monetary field is a string. That is not a stylistic choice about JSON:
 * a loan's principal, each instalment's interest and the outstanding balance
 * are the numbers a borrower is held to, and a JSON number is a binary double
 * that cannot hold most decimal fractions. See `scalars.ts`.
 */

export const INTEREST_METHODS = ['flat', 'reducing_balance'] as const;
export type InterestMethod = (typeof INTEREST_METHODS)[number];

export const LOAN_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'active',
  'completed',
  'written_off',
] as const;
export type LoanStatus = (typeof LOAN_STATUSES)[number];

/** Longest term the schedule generator will produce. */
export const MAXIMUM_TERM_MONTHS = 360;

export const termMonthsSchema = z.coerce
  .number()
  .int('A term is a whole number of months.')
  .min(1, 'A term must be at least one month.')
  .max(MAXIMUM_TERM_MONTHS, `A term may not exceed ${String(MAXIMUM_TERM_MONTHS)} months.`);

/** One row of a repayment schedule. */
export const scheduleInstalmentSchema = z
  .object({
    monthNumber: z.number().int().positive(),
    dueDate: isoDateSchema,
    openingBalance: z.string(),
    principalDue: z.string(),
    interestDue: z.string(),
    totalDue: z.string(),
    closingBalance: z.string(),
    isPaid: z.boolean(),
  })
  .strict();

export type ScheduleInstalment = z.infer<typeof scheduleInstalmentSchema>;

/**
 * A schedule with its totals.
 *
 * The totals are computed alongside the rows by the same function that produced
 * them, never summed again by a client. A total re-derived on the other side of
 * the wire is a second implementation of the arithmetic, and the two can
 * disagree by a shilling — which is exactly the drift the previous system's own
 * technical document warned about.
 */
export const repaymentScheduleSchema = z
  .object({
    instalments: z.array(scheduleInstalmentSchema),
    totalPrincipal: z.string(),
    totalInterest: z.string(),
    totalRepayable: z.string(),
  })
  .strict();

export type RepaymentSchedule = z.infer<typeof repaymentScheduleSchema>;

export const loanSchema = z
  .object({
    id: uuidSchema,
    /** Allocated at submission, not at creation. Null while a draft. */
    loanCode: z.string().nullable(),
    branchId: uuidSchema,
    branchName: z.string(),
    clientId: uuidSchema,
    clientName: z.string(),
    clientCode: z.string(),
    productId: uuidSchema,
    productName: z.string(),

    /**
     * Terms, copied from the product at submission rather than referenced.
     *
     * A product's rate may be revised; a loan's may not. Reading the rate
     * through the product would silently restate every historic schedule — and
     * every MSP2-04 return — the next time someone changed a price.
     */
    principal: z.string(),
    monthlyRate: z.string(),
    interestMethod: z.enum(INTEREST_METHODS),
    termMonths: z.number().int().positive(),

    status: z.enum(LOAN_STATUSES),

    submittedBy: uuidSchema.nullable(),
    submittedAt: isoTimestampSchema.nullable(),
    decidedBy: uuidSchema.nullable(),
    decidedAt: isoTimestampSchema.nullable(),
    rejectionReason: z.string().nullable(),

    disbursedBy: uuidSchema.nullable(),
    disbursementDate: isoDateSchema.nullable(),

    /** Null until disbursement. Moved only by recording a payment. */
    outstandingBalance: z.string().nullable(),
    /**
     * Compulsory savings held as security against this loan.
     *
     * Per loan rather than per client, which is §11.7's answer (§24.1): a loan
     * is in one sector, so MSP2-03's per-sector provision deduction is a sum
     * rather than a split this system would have had to invent.
     */
    compulsorySavingsSecured: nonNegativeMoneyAmountSchema,

    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type Loan = z.infer<typeof loanSchema>;

/** A loan together with the schedule generated for it. */
export const loanWithScheduleSchema = loanSchema
  .extend({
    /** Null until the loan is disbursed, which is when the schedule is written. */
    schedule: repaymentScheduleSchema.nullable(),
  })
  .strict();

export type LoanWithSchedule = z.infer<typeof loanWithScheduleSchema>;

/**
 * What a preview needs, and what an application needs, are the same fields.
 *
 * Deliberately one schema. The preview endpoint and the write path run the same
 * generator over the same inputs, so a shape that could differ between them
 * would reintroduce the drift both exist to prevent.
 */
export const loanTermsSchema = z.object({
  clientId: uuidSchema,
  productId: uuidSchema,
  principal: positiveMoneyAmountSchema,
  /** Monthly, as a fraction: `0.05` is five percent a month. */
  monthlyRate: rateFractionSchema,
  termMonths: termMonthsSchema,
});

/** Setting the compulsory savings that secures a loan. */
export const secureLoanRequestSchema = z
  .object({ compulsorySavingsSecured: nonNegativeMoneyAmountSchema })
  .strict();

export type SecureLoanRequest = z.infer<typeof secureLoanRequestSchema>;

export const createLoanRequestSchema = loanTermsSchema.strict();
export type CreateLoanRequest = z.infer<typeof createLoanRequestSchema>;

/**
 * A schedule preview.
 *
 * Takes a disbursement date because due dates depend on it, and the client
 * needs to show a borrower the dates they will actually owe on. Defaults to
 * today when omitted.
 */
export const previewScheduleRequestSchema = loanTermsSchema
  .extend({
    disbursementDate: isoDateSchema.optional(),
  })
  .strict();

export type PreviewScheduleRequest = z.infer<typeof previewScheduleRequestSchema>;

/** Submitting a draft for approval. */
export const submitLoanRequestSchema = z.object({}).strict();

/**
 * An approval decision.
 *
 * A rejection must say why. "Declined" with no reason is not a record the
 * borrower, the officer or an auditor can act on, and the database enforces the
 * same rule.
 */
export const decideLoanRequestSchema = z
  .discriminatedUnion('decision', [
    z.object({ decision: z.literal('approve') }).strict(),
    z
      .object({
        decision: z.literal('reject'),
        reason: requiredTextSchema(500),
      })
      .strict(),
  ])
  .describe('approve, or reject with a reason');

export type DecideLoanRequest = z.infer<typeof decideLoanRequestSchema>;

/** Releasing the money. */
export const disburseLoanRequestSchema = z
  .object({
    /**
     * When the money left the institution.
     *
     * Defaults to today. It may be backdated — a transfer recorded the
     * following morning is ordinary — but not postdated, because the schedule
     * generated from it would start in the future and the loan would report as
     * active before any money moved.
     */
    disbursementDate: isoDateSchema.optional(),
  })
  .strict();

export type DisburseLoanRequest = z.infer<typeof disburseLoanRequestSchema>;

export const loanListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(LOAN_STATUSES).optional(),
  clientId: uuidSchema.optional(),
  branchId: uuidSchema.optional(),
});

export type LoanListQuery = z.infer<typeof loanListQuerySchema>;

/**
 * BOT's loan type taxonomy, as a client needs it to define a product.
 *
 * Served rather than embedded. A second copy of BOT's list is a list that can
 * disagree with BOT's, and every product's `botLoanType` decides which MSP2-04
 * row its loans report on.
 *
 * `parentCode` is set on the two Salaried sub-types. BOT's template gives the
 * parent an input row of its own at row 23 as well as its children at 24 and
 * 25, so all three are choosable; the field is here so a screen can show the
 * relationship rather than presenting fourteen flat options.
 */
export const botLoanTypeSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    /** BOT's own line number, which is the order their form lists them in. */
    sno: z.number().int().positive(),
    parentCode: z.string().nullable(),
    /**
     * Which provisioning schedule loans of this type classify on. Housing
     * microfinance provisions on BOT's longer bands — see 02-BOT-REPORTING-SPEC
     * §4.1 — so this is a consequence of the choice, not decoration.
     */
    provisioningSchedule: z.enum(['standard', 'housing']),
  })
  .strict();

export type BotLoanType = z.infer<typeof botLoanTypeSchema>;

/** Loan products, as a client needs them to fill in an application. */
export const loanProductSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    botLoanType: z.string(),
    interestMethod: z.enum(INTEREST_METHODS),
    minMonthlyRate: z.string(),
    maxMonthlyRate: z.string(),
    minTermMonths: z.number().int().positive(),
    maxTermMonths: z.number().int().positive(),
    minPrincipal: z.string(),
    maxPrincipal: z.string(),
    status: z.enum(['active', 'retired']),
    /**
     * Penalty terms, or `null` where this product charges none.
     *
     * §13.1 settled the shape — daily rate on the overdue instalment, a grace
     * period, simple non-compounding accrual, an optional cap — and left the
     * figures to the institution. They belong here, per product, rather than in
     * a migration this system ships.
     */
    penaltyDailyRate: rateFractionSchema.nullable(),
    penaltyGraceDays: z.number().int().nonnegative().nullable(),
    penaltyCapFraction: rateFractionSchema.nullable(),
  })
  .strict();

export type LoanProduct = z.infer<typeof loanProductSchema>;

/**
 * Defining a product.
 *
 * Every rule below is also a constraint in migration 0008 or 0021, and neither
 * copy is redundant. The database's is what holds — it cannot be bypassed by a
 * future write path — while this one is what the person filling in the form
 * reads: `loan_products_penalty_terms_are_whole` names a constraint, and
 * "penalty terms need both a daily rate and a grace period" names the field
 * they left empty.
 *
 * Penalty terms are whole or absent: a rate with no grace period leaves the
 * accrual guessing when to start, and a grace period with no rate charges
 * nothing while reading on screen as deliberate policy.
 */
export const createLoanProductRequestSchema = z
  .object({
    code: requiredTextSchema(40),
    name: requiredTextSchema(120),
    /** A `reference.loan_types` code. Unknown values are refused by its foreign key. */
    botLoanType: requiredTextSchema(80),
    interestMethod: z.enum(INTEREST_METHODS),
    minMonthlyRate: rateFractionSchema,
    maxMonthlyRate: rateFractionSchema,
    minTermMonths: termMonthsSchema,
    maxTermMonths: termMonthsSchema,
    minPrincipal: positiveMoneyAmountSchema,
    maxPrincipal: positiveMoneyAmountSchema,
    /**
     * Omitted together, or given together. §13.1 settled the shape and left the
     * figures to the institution, so a product created without them charges no
     * penalty — a complete product, not an unfinished one.
     */
    penaltyDailyRate: rateFractionSchema.optional(),
    penaltyGraceDays: z.number().int().nonnegative().optional(),
    penaltyCapFraction: rateFractionSchema.optional(),
  })
  .strict()
  .refine(
    (product) =>
      (product.penaltyDailyRate === undefined) === (product.penaltyGraceDays === undefined),
    { error: 'Penalty terms need both a daily rate and a grace period, or neither.' },
  )
  .refine(
    (product) => product.penaltyCapFraction === undefined || product.penaltyDailyRate !== undefined,
    { error: 'A penalty cap needs penalty terms to cap.' },
  )
  .refine(
    (product) =>
      product.penaltyCapFraction === undefined ||
      compareDecimalStrings(product.penaltyCapFraction, '0') > 0,
    // A cap of nothing is not "no ceiling", it is a ceiling of zero, which
    // silently makes the terms beside it charge nothing at all.
    { error: 'A penalty cap of zero would charge no penalty. Omit the cap to leave it uncapped.' },
  )
  .refine((product) => compareDecimalStrings(product.maxMonthlyRate, product.minMonthlyRate) >= 0, {
    error: 'The maximum interest rate cannot be below the minimum.',
  })
  .refine((product) => compareDecimalStrings(product.maxPrincipal, product.minPrincipal) >= 0, {
    error: 'The maximum principal cannot be below the minimum.',
  })
  .refine((product) => product.maxTermMonths >= product.minTermMonths, {
    error: 'The maximum term cannot be below the minimum.',
  });

export type CreateLoanProductRequest = z.infer<typeof createLoanProductRequestSchema>;
