import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import {
  isoDateSchema,
  isoTimestampSchema,
  nonNegativeMoneyAmountSchema,
  positiveMoneyAmountSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

/**
 * Savings.
 *
 * Less than a savings subsystem, and deliberately: §13.4 asks for the interest
 * rate basis, the accrual frequency, the minimum balance, the withdrawal rules
 * and whether savings can secure a loan, and none of those are answered. There
 * is no interest anywhere in this contract — a balance is what was paid in less
 * what was taken out.
 *
 * What is here is what BOT's return cannot be filed without. **Compulsory
 * savings appears on three forms**: MSP2-01 Sno46, MSP2-03's provision
 * deduction, and MSP2-10's per-district column, with validation rule 16 tying
 * the last to the first. That is why `isCompulsory` is a product flag rather
 * than a naming convention — a misfiled flag moves money between a reported
 * figure and an unreported one.
 */

export const SAVINGS_DIRECTIONS = ['deposit', 'withdrawal'] as const;

export type SavingsDirection = (typeof SAVINGS_DIRECTIONS)[number];

export const SAVINGS_ACCOUNT_STATUSES = ['active', 'dormant', 'closed'] as const;

export type SavingsAccountStatus = (typeof SAVINGS_ACCOUNT_STATUSES)[number];

export const savingsProductSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    /** True where balances are BOT compulsory savings, reported on three forms. */
    isCompulsory: z.boolean(),
    status: z.enum(['active', 'closed']),
  })
  .strict();

export type SavingsProduct = z.infer<typeof savingsProductSchema>;

export const createSavingsProductRequestSchema = z
  .object({
    code: requiredTextSchema(40),
    name: requiredTextSchema(120),
    isCompulsory: z.boolean(),
  })
  .strict();

export type CreateSavingsProductRequest = z.infer<typeof createSavingsProductRequestSchema>;

/**
 * Closing a savings product, or reopening one.
 *
 * A closed product takes no new accounts. Accounts already open against it are
 * untouched — their balances still report on MSP2-01 Sno46 and MSP2-10, and
 * making them vanish because a product was withdrawn would take real money off
 * a return.
 */
export const updateSavingsProductRequestSchema = z
  .object({ status: z.enum(['active', 'closed']) })
  .strict();

export type UpdateSavingsProductRequest = z.infer<typeof updateSavingsProductRequestSchema>;

export const savingsAccountSchema = z
  .object({
    id: uuidSchema,
    accountCode: z.string(),
    clientId: uuidSchema,
    clientName: z.string(),
    branchId: uuidSchema,
    branchName: z.string(),
    productId: uuidSchema,
    productName: z.string(),
    isCompulsory: z.boolean(),
    status: z.enum(SAVINGS_ACCOUNT_STATUSES),
    openedOn: isoDateSchema,
    closedOn: isoDateSchema.nullable(),
    /** The balance now. A past quarter's figure comes from the ledger. */
    balance: nonNegativeMoneyAmountSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type SavingsAccount = z.infer<typeof savingsAccountSchema>;

export const openSavingsAccountRequestSchema = z
  .object({
    clientId: uuidSchema,
    branchId: uuidSchema,
    productId: uuidSchema,
    openedOn: isoDateSchema,
  })
  .strict();

export type OpenSavingsAccountRequest = z.infer<typeof openSavingsAccountRequestSchema>;

export const savingsTransactionSchema = z
  .object({
    id: uuidSchema,
    savingsAccountId: uuidSchema,
    direction: z.enum(SAVINGS_DIRECTIONS),
    amount: positiveMoneyAmountSchema,
    /** The balance this entry left behind, so a statement reads in one pass. */
    balanceAfter: nonNegativeMoneyAmountSchema,
    transactionDate: isoDateSchema,
    narrative: z.string().nullable(),
    reference: z.string().nullable(),
    /** Set on the entry that reverses another; never on the one reversed. */
    reversesId: uuidSchema.nullable(),
    recordedBy: uuidSchema,
    createdAt: isoTimestampSchema,
  })
  .strict();

export type SavingsTransaction = z.infer<typeof savingsTransactionSchema>;

export const recordSavingsEntryRequestSchema = z
  .object({
    direction: z.enum(SAVINGS_DIRECTIONS),
    amount: positiveMoneyAmountSchema,
    transactionDate: isoDateSchema,
    narrative: requiredTextSchema(500).optional(),
    reference: requiredTextSchema(120).optional(),
  })
  .strict();

export type RecordSavingsEntryRequest = z.infer<typeof recordSavingsEntryRequestSchema>;

/**
 * Reversing an entry.
 *
 * The date is the caller's, not the original's: a reversal backdated into a
 * quarter already filed would change a figure BOT has been given.
 */
export const reverseSavingsEntryRequestSchema = z
  .object({
    reversedOn: isoDateSchema,
    narrative: requiredTextSchema(500),
  })
  .strict();

export type ReverseSavingsEntryRequest = z.infer<typeof reverseSavingsEntryRequestSchema>;

export const savingsAccountListQuerySchema = paginationQuerySchema
  .extend({
    clientId: uuidSchema.optional(),
    productId: uuidSchema.optional(),
    status: z.enum(SAVINGS_ACCOUNT_STATUSES).optional(),
  })
  .strict();

export type SavingsAccountListQuery = z.infer<typeof savingsAccountListQuerySchema>;
