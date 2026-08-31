import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import {
  isoDateSchema,
  isoTimestampSchema,
  positiveMoneyAmountSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

/**
 * Repayments, and the reversals that correct them.
 *
 * A recorded payment is never edited. The application holds INSERT and SELECT
 * on the table and nothing else, so correcting a mis-keyed amount means
 * recording a linked reversal that negates it exactly — both the mistake and
 * its correction stay visible. The system this replaces made payments immutable
 * and then never built the correction, so fixing one meant editing the database
 * by hand, which destroys the property the immutability was protecting.
 */

/** How a payment was split across what was owed. */
export const paymentAllocationSchema = z
  .object({
    penalty: z.string(),
    fee: z.string(),
    interest: z.string(),
    principal: z.string(),
    /**
     * Paid beyond everything owed.
     *
     * Recorded rather than absorbed. What an institution does with excess funds
     * — refund, credit, early settlement of a future instalment — is an open
     * business rule (01-ARCHITECTURE.md §13.8), and silently keeping it would
     * answer that question on their behalf.
     */
    unallocated: z.string(),
  })
  .strict();

export type PaymentAllocation = z.infer<typeof paymentAllocationSchema>;

export const paymentSchema = z
  .object({
    id: uuidSchema,
    loanId: uuidSchema,
    loanCode: z.string().nullable(),
    clientName: z.string(),

    /** Positive for a receipt, negative for a reversal. */
    amountPaid: z.string(),
    allocation: paymentAllocationSchema,

    /**
     * Snapshots, so a historic balance is readable without replaying every
     * payment against the loan.
     */
    balanceBefore: z.string(),
    balanceAfter: z.string(),

    datePaid: isoDateSchema,
    notes: z.string().nullable(),

    recordedBy: uuidSchema,
    createdAt: isoTimestampSchema,

    /** Set only on a reversal, naming the payment it undoes. */
    reversesPaymentId: uuidSchema.nullable(),
    reversalReason: z.string().nullable(),
    /** Set on a payment that has been reversed. */
    reversedByPaymentId: uuidSchema.nullable(),
  })
  .strict();

export type Payment = z.infer<typeof paymentSchema>;

/**
 * Recording a repayment.
 *
 * The caller sends an amount and nothing else about how it should be split.
 * The allocation is computed by the domain, because a client-supplied split is
 * a second implementation of the arithmetic — and one the borrower's balance
 * would then depend on.
 */
export const recordPaymentRequestSchema = z
  .object({
    amountPaid: positiveMoneyAmountSchema,
    /**
     * When the money was received.
     *
     * Defaults to today. Backdating is ordinary — cash taken on Friday and
     * keyed on Monday — but a future date is not: it would put a receipt on a
     * BOT return for a quarter that has not happened.
     */
    datePaid: isoDateSchema.optional(),
    notes: requiredTextSchema(500).optional(),
  })
  .strict();

export type RecordPaymentRequest = z.infer<typeof recordPaymentRequestSchema>;

/** Previewing how an amount would be applied, without recording it. */
export const previewAllocationRequestSchema = z
  .object({ amountPaid: positiveMoneyAmountSchema })
  .strict();

export type PreviewAllocationRequest = z.infer<typeof previewAllocationRequestSchema>;

/**
 * What an amount would do to a loan, without doing it.
 *
 * Runs the same allocator the write path runs. The previous system computed
 * this split twice — in the function that recorded the payment and again in the
 * browser to preview it — and warned in its own documentation that the preview
 * would lie if the two drifted.
 */
export const allocationPreviewSchema = z
  .object({
    amountPaid: z.string(),
    allocation: paymentAllocationSchema,
    balanceBefore: z.string(),
    balanceAfter: z.string(),
  })
  .strict();

export type AllocationPreview = z.infer<typeof allocationPreviewSchema>;

/** Undoing a payment. */
export const reversePaymentRequestSchema = z
  .object({
    /**
     * Why it is being reversed.
     *
     * Required. A reversal with no reason is an unexplained movement of money
     * in an audited ledger, which is worse than the mistake it corrects.
     */
    reason: requiredTextSchema(500),
  })
  .strict();

export type ReversePaymentRequest = z.infer<typeof reversePaymentRequestSchema>;

export const paymentListQuerySchema = paginationQuerySchema.extend({
  loanId: uuidSchema.optional(),
  clientId: uuidSchema.optional(),
});

export type PaymentListQuery = z.infer<typeof paymentListQuerySchema>;
