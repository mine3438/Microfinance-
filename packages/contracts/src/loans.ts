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
  /**
   * Restructured into a successor.
   *
   * Terminal, and distinct from `completed`: nobody repaid a restructured loan,
   * its debt moved to the loan that replaced it. The pair is linked by
   * `loan_restructurings`, and the old loan keeps its schedule and payments.
   */
  'restructured',
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

/**
 * Retiring a product, or bringing one back.
 *
 * `loan_products.status` has carried `'retired'` since migration 0008 and
 * nothing ever set it, so a product entered in error stayed on the officer's
 * list for good. Both directions are offered rather than retirement alone: the
 * column has exactly two legitimate values, neither transition risks anything —
 * a loan copies its terms from the product at creation rather than referencing
 * it (§9), so retiring disturbs no loan already written — and a one-way door
 * would make a mis-click permanent without a database console.
 */
export const updateLoanProductRequestSchema = z
  .object({ status: z.enum(['active', 'retired']) })
  .strict();

export type UpdateLoanProductRequest = z.infer<typeof updateLoanProductRequestSchema>;

/**
 * Writing a loan off.
 *
 * Approved rules, recorded so nothing here is inferred: there is **no**
 * days-past-due threshold and **no** scheduled job. A loan is written off when
 * the Owner/Manager judges the debt no longer realistically recoverable, and
 * that judgement is the only trigger. The system shows classification and
 * arrears to inform the decision; it never takes it.
 */
export const writeOffLoanRequestSchema = z
  .object({
    /**
     * Why the debt is judged unrecoverable.
     *
     * Required. A write-off with no reason is an unexplained disposal of an
     * asset, and it is exactly what an inspection asks about first.
     */
    reason: requiredTextSchema(1000),
  })
  .strict();

export type WriteOffLoanRequest = z.infer<typeof writeOffLoanRequestSchema>;

/** What was written off, captured before the live balance became zero. */
export const loanWriteOffSchema = z
  .object({
    id: uuidSchema,
    loanId: uuidSchema,
    loanCode: z.string().nullable(),
    clientName: z.string(),

    /**
     * The balance at the instant of the decision, decomposed.
     *
     * Kept as parts rather than a single total because BOT's MSP2-02
     * distinguishes bad debts written off from provisions, and because an
     * accounting mapping cannot decompose a figure it was handed already summed.
     */
    principalWrittenOff: z.string(),
    penaltyWrittenOff: z.string(),
    totalWrittenOff: z.string(),

    reason: z.string(),
    approvedBy: uuidSchema,
    approvedByName: z.string().nullable(),
    writtenOffAt: isoTimestampSchema,
  })
  .strict();

export type LoanWriteOff = z.infer<typeof loanWriteOffSchema>;

/**
 * Money received against a loan that has been written off.
 *
 * Not a repayment, and the contract keeps them apart deliberately. A recovery
 * does not reinstate the loan, does not recreate principal, and does not reopen
 * the schedule — the borrower's live balance stays at zero and the loan stays
 * written off. Partial and repeated recoveries are both ordinary.
 */
export const recordRecoveryRequestSchema = z
  .object({
    amount: positiveMoneyAmountSchema,
    /** When the money arrived. Defaults to today; a future date is refused. */
    recoveredOn: isoDateSchema.optional(),
    /** How it arrived — cash, transfer, whatever the institution writes. */
    method: requiredTextSchema(100).optional(),
    /** Receipt or transaction reference, where there is one. */
    reference: requiredTextSchema(100).optional(),
    notes: requiredTextSchema(500).optional(),
  })
  .strict();

export type RecordRecoveryRequest = z.infer<typeof recordRecoveryRequestSchema>;

export const loanRecoverySchema = z
  .object({
    id: uuidSchema,
    loanId: uuidSchema,
    loanCode: z.string().nullable(),
    clientName: z.string(),
    amount: z.string(),
    recoveredOn: isoDateSchema,
    method: z.string().nullable(),
    reference: z.string().nullable(),
    notes: z.string().nullable(),
    recordedBy: uuidSchema,
    recordedByName: z.string().nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export type LoanRecovery = z.infer<typeof loanRecoverySchema>;

/**
 * The application/form fee.
 *
 * The institution's one approved application-stage charge: **TZS 5,000**, paid
 * in cash when the applicant submits the loan forms.
 *
 * It is deliberately not part of the loan. It is not deducted from
 * disbursement, not added to principal, not interest-bearing, not part of the
 * repayment schedule, and not a balance the repayment allocator can reach — the
 * allocator's fee bucket keeps its fixed position and continues to allocate
 * nil, so no repayment splits differently because this fee exists.
 */
export const APPLICATION_FEE_AMOUNT = '5000.00';

/** Where an application fee stands. Derived, never stored. */
export const APPLICATION_FEE_STATES = ['collected', 'retained', 'refund_due', 'refunded'] as const;

export type ApplicationFeeState = (typeof APPLICATION_FEE_STATES)[number];

export const applicationFeeSchema = z
  .object({
    id: uuidSchema,
    loanId: uuidSchema,
    amount: z.string(),

    collectedOn: isoDateSchema,
    method: z.string().nullable(),
    reference: z.string().nullable(),
    collectedBy: uuidSchema,
    collectedByName: z.string().nullable(),

    /**
     * Where it stands, worked out from the application and the refund stamp:
     *
     * - `collected` — taken; the application has not been decided.
     * - `retained` — the application was approved, so the institution keeps it.
     * - `refund_due` — the application was rejected and the money has not yet
     *   been handed back.
     * - `refunded` — handed back, with the collection record intact.
     */
    state: z.enum(APPLICATION_FEE_STATES),

    refundedOn: isoDateSchema.nullable(),
    refundedBy: uuidSchema.nullable(),
    refundedByName: z.string().nullable(),
    refundReason: z.string().nullable(),
  })
  .strict();

export type ApplicationFee = z.infer<typeof applicationFeeSchema>;

/**
 * Recording the collection.
 *
 * No amount field. The charge is fixed policy at {@link APPLICATION_FEE_AMOUNT},
 * so letting a caller state it would let a counter typo become the fee — and
 * the figure is not theirs to choose.
 */
export const collectApplicationFeeRequestSchema = z
  .object({
    /** When the money was taken. Defaults to today; a future date is refused. */
    collectedOn: isoDateSchema.optional(),
    /** Cash, by the approved rule — recorded as written rather than enumerated. */
    method: requiredTextSchema(100).optional(),
    reference: requiredTextSchema(100).optional(),
  })
  .strict();

export type CollectApplicationFeeRequest = z.infer<typeof collectApplicationFeeRequestSchema>;

/** Handing it back after a rejected application. */
export const refundApplicationFeeRequestSchema = z
  .object({
    refundedOn: isoDateSchema.optional(),
    reason: requiredTextSchema(500).optional(),
  })
  .strict();

export type RefundApplicationFeeRequest = z.infer<typeof refundApplicationFeeRequestSchema>;

/**
 * Settling a loan before maturity.
 *
 * The approved rule: outstanding principal + interest due through the
 * settlement month + all accrued and outstanding penalties. No discount,
 * penalties not waived, and the application/form fee is not part of it.
 *
 * Interest is charged at **month granularity**. Settling on the 1st, the 10th
 * or the 31st of a month all charge that whole month and exclude the months
 * after it. Nothing is prorated by day.
 */
export const settlementQuoteSchema = z
  .object({
    loanId: uuidSchema,
    settlementDate: isoDateSchema,
    /** Last day of the settlement month. Interest is charged up to here. */
    chargedThrough: isoDateSchema,

    principal: z.string(),
    interest: z.string(),
    penalty: z.string(),
    /** What the borrower pays. The three parts, exactly. */
    total: z.string(),

    /**
     * Scheduled interest falling after the settlement month.
     *
     * Never charged, so never owed. Reported so a settlement statement can show
     * what settling early saved, without anyone re-deriving it from a schedule.
     */
    interestNotCharged: z.string(),
  })
  .strict();

export type SettlementQuote = z.infer<typeof settlementQuoteSchema>;

export const settlementQuoteQuerySchema = z
  .object({
    /** The day the borrower settles. Only its month is used. Defaults to today. */
    settlementDate: isoDateSchema.optional(),
  })
  .strict();

export type SettlementQuoteQuery = z.infer<typeof settlementQuoteQuerySchema>;

/**
 * Recording the settlement.
 *
 * The amount is required and must equal the quote exactly. It could have been
 * derived server-side and never asked for — but then a teller who counted a
 * different sum would have no way to find out. Requiring it makes the quote and
 * the cash agree before anything closes.
 */
export const settleLoanRequestSchema = z
  .object({
    amountPaid: positiveMoneyAmountSchema,
    settlementDate: isoDateSchema.optional(),
    notes: requiredTextSchema(500).optional(),
  })
  .strict();

export type SettleLoanRequest = z.infer<typeof settleLoanRequestSchema>;

/**
 * Restructuring a loan into a successor.
 *
 * The approved rules: any borrower may request it, but only while the loan is
 * still within its **originally agreed term**; only the Owner/Manager approves;
 * and the new principal is what the old loan still owed —
 *
 *     remaining principal + unpaid accrued interest + unpaid penalties
 *
 * Nothing is forgiven. The old loan is never deleted, keeps its schedule, stops
 * accepting ordinary repayments, and records the link to its successor. The new
 * loan reuses the original terms and starts classified Current.
 */
export const restructureLoanRequestSchema = z
  .object({
    /** Why the loan is being restructured. Required, like a write-off's. */
    reason: requiredTextSchema(1000),
    /** The day the restructuring takes effect. Defaults to today. */
    effectiveOn: isoDateSchema.optional(),
  })
  .strict();

export type RestructureLoanRequest = z.infer<typeof restructureLoanRequestSchema>;

export const loanRestructuringSchema = z
  .object({
    id: uuidSchema,
    oldLoanId: uuidSchema,
    newLoanId: uuidSchema,

    /**
     * What was carried across, decomposed.
     *
     * Kept as three figures rather than one, because the accounting treatment
     * for capitalising interest and penalties is not yet defined and a total
     * cannot be decomposed after the fact.
     */
    principalCarried: z.string(),
    interestCapitalised: z.string(),
    penaltiesCapitalised: z.string(),
    newPrincipal: z.string(),

    reason: z.string(),
    requestedBy: uuidSchema,
    approvedBy: uuidSchema,
    approvedByName: z.string().nullable(),
    approvedAt: isoTimestampSchema,
  })
  .strict();

export type LoanRestructuring = z.infer<typeof loanRestructuringSchema>;
