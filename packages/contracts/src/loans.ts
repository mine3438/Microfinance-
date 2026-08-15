import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import {
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
  })
  .strict();

export type LoanProduct = z.infer<typeof loanProductSchema>;
