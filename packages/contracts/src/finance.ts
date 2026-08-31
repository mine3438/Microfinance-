import { paginationQuerySchema } from './pagination.js';
import { z } from 'zod';

import {
  isoDateSchema,
  isoTimestampSchema,
  moneyAmountSchema,
  nonNegativeMoneyAmountSchema,
  positiveMoneyAmountSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

/**
 * Income, expenditure, and balances held elsewhere.
 *
 * The category of an entry is a **BOT line number**, not a string. MSP2-02 has
 * forty-two numbered lines and every figure an institution reports belongs to
 * exactly one of them, so `sno` carries the classification and there is no
 * free-text category anywhere in this contract. The system being replaced
 * enforced its categories in the browser alone, which meant a direct API call
 * could put any string onto a regulatory filing (00-PROJECT-ANALYSIS R12).
 *
 * A client that needs to show those lines by name fetches the taxonomy from
 * `/reference/msp2-02-lines` rather than embedding a copy — a second list is a
 * list that can disagree with BOT's.
 */

export const FINANCE_DIRECTIONS = ['income', 'expense'] as const;

export type FinanceDirection = (typeof FINANCE_DIRECTIONS)[number];

/** One MSP2-02 line, as BOT publishes it. */
export const msp2_02LineSchema = z
  .object({
    sno: z.number().int().positive(),
    label: z.string(),
    /** True where BOT's template derives the line rather than accepting entry. */
    isComputed: z.boolean(),
    /** Which side entries land on, or `null` where the line is computed. */
    entryDirection: z.enum(FINANCE_DIRECTIONS).nullable(),
  })
  .strict();

export type Msp2_02Line = z.infer<typeof msp2_02LineSchema>;

/** A recorded income or expense. */
export const financeEntrySchema = z
  .object({
    id: uuidSchema,
    direction: z.enum(FINANCE_DIRECTIONS),
    sno: z.number().int().positive(),
    /** The BOT line's own label, so a list is readable without a second call. */
    lineLabel: z.string(),
    amount: positiveMoneyAmountSchema,
    entryDate: isoDateSchema,
    branchId: uuidSchema.nullable(),
    branchName: z.string().nullable(),
    description: z.string().nullable(),
    reference: z.string().nullable(),
    recordedBy: uuidSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type FinanceEntry = z.infer<typeof financeEntrySchema>;

export const createFinanceEntryRequestSchema = z
  .object({
    direction: z.enum(FINANCE_DIRECTIONS),
    /**
     * The BOT line this figure reports on.
     *
     * Validated against the taxonomy on the way in and by a foreign key at the
     * database, which between them refuse a line BOT computes, a line on the
     * wrong side of the statement, and a number BOT does not publish.
     */
    sno: z.number().int().positive(),
    amount: positiveMoneyAmountSchema,
    entryDate: isoDateSchema,
    branchId: uuidSchema.optional(),
    description: requiredTextSchema(500).optional(),
    reference: requiredTextSchema(100).optional(),
  })
  .strict();

export type CreateFinanceEntryRequest = z.infer<typeof createFinanceEntryRequestSchema>;

/**
 * A correction to an entry.
 *
 * Entries are editable where payments are not: a payment is evidence a
 * borrower handed money over, while an entry is a bookkeeping classification
 * of the institution's own spending, and moving one between two BOT lines is
 * ordinary work. Every change is audited.
 */
export const updateFinanceEntryRequestSchema = createFinanceEntryRequestSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Send at least one field to change.',
  });

export type UpdateFinanceEntryRequest = z.infer<typeof updateFinanceEntryRequestSchema>;

export const financeEntryListQuerySchema = paginationQuerySchema.extend({
  direction: z.enum(FINANCE_DIRECTIONS).optional(),
  sno: z.coerce.number().int().positive().optional(),
  /** Inclusive date bounds, so a quarter can be listed as it will be filed. */
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export type FinanceEntryListQuery = z.infer<typeof financeEntryListQuerySchema>;

/**
 * BOT's four sections of MSP2-07.
 *
 * A fixed list backs two of them and not the other two: BOT publishes 56
 * banking institutions and six MNOs, and leaves balances with other
 * microfinance providers and with banks abroad to be named.
 */
export const HOLDING_KINDS = [
  'bank_tanzania',
  'microfinance_service_provider',
  'mno',
  'bank_abroad',
] as const;

export type HoldingKind = (typeof HOLDING_KINDS)[number];

/** One of the institutions BOT publishes. */
export const financialInstitutionSchema = z
  .object({
    code: z.string(),
    name: z.string(),
    kind: z.enum(['bank', 'mno']),
    inDepositsList: z.boolean(),
    inAgentBankingList: z.boolean(),
  })
  .strict();

export type FinancialInstitution = z.infer<typeof financialInstitutionSchema>;

const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Must be a three-letter ISO 4217 currency code, such as TZS or USD.');

export const bankAccountSchema = z
  .object({
    id: uuidSchema,
    holdingKind: z.enum(HOLDING_KINDS),
    /** BOT's code, where the section is drawn from a published list. */
    institutionCode: z.string().nullable(),
    /** The name as typed, where BOT publishes no list for the section. */
    counterpartyName: z.string().nullable(),
    /** How the row is labelled on MSP2-07, whichever of the two it came from. */
    counterparty: z.string(),
    /** Whether BOT lists this institution for agent banking. Not a setting. */
    supportsAgentBanking: z.boolean(),
    accountNumber: z.string().nullable(),
    currencyCode: currencyCodeSchema,
    status: z.enum(['active', 'closed']),
    createdAt: isoTimestampSchema,
  })
  .strict();

export type BankAccount = z.infer<typeof bankAccountSchema>;

export const createBankAccountRequestSchema = z
  .object({
    holdingKind: z.enum(HOLDING_KINDS),
    /** Required for a bank in Tanzania or an MNO; refused for the other two. */
    institutionCode: z.string().min(1).optional(),
    /** Required for a microfinance provider or a bank abroad; refused otherwise. */
    counterpartyName: requiredTextSchema(200).optional(),
    accountNumber: requiredTextSchema(50).optional(),
    currencyCode: currencyCodeSchema.default('TZS'),
  })
  .strict();

export type CreateBankAccountRequest = z.infer<typeof createBankAccountRequestSchema>;

/** What an account held at a quarter end. */
export const bankAccountBalanceSchema = z
  .object({
    id: uuidSchema,
    bankAccountId: uuidSchema,
    counterparty: z.string(),
    holdingKind: z.enum(HOLDING_KINDS),
    year: z.number().int(),
    quarter: z.number().int(),
    currencyCode: currencyCodeSchema,
    /** Held in the account's own currency. */
    depositBalance: nonNegativeMoneyAmountSchema,
    borrowingBalance: nonNegativeMoneyAmountSchema,
    /** The same two figures in TZS, which is the only currency BOT's forms carry. */
    depositBalanceTzs: nonNegativeMoneyAmountSchema,
    borrowingBalanceTzs: nonNegativeMoneyAmountSchema,
    agentBankingBalance: nonNegativeMoneyAmountSchema,
    /**
     * The rate that stated a foreign balance in TZS, and the day it was taken.
     *
     * Null for a TZS account, which converts at par. Which rate BOT expects is
     * unconfirmed (02-BOT-REPORTING-SPEC.md §11.6) — recording the one used is
     * what makes a filed figure explainable afterwards.
     */
    exchangeRate: z.string().nullable(),
    rateDate: isoDateSchema.nullable(),
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type BankAccountBalance = z.infer<typeof bankAccountBalanceSchema>;

/** A rate as it travels: a decimal string, never a JSON number. */
const exchangeRateSchema = z
  .string()
  .regex(
    /^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/,
    'Must be a positive decimal with at most 6 decimal places.',
  )
  .refine((value) => /[1-9]/.test(value), { error: 'Must be greater than zero.' });

export const recordBankBalanceRequestSchema = z
  .object({
    year: z.number().int().min(2000).max(9999),
    quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
    depositBalance: nonNegativeMoneyAmountSchema.default('0'),
    borrowingBalance: nonNegativeMoneyAmountSchema.default('0'),
    agentBankingBalance: nonNegativeMoneyAmountSchema.default('0'),
    /**
     * Required for an account in any currency but TZS, refused for a TZS one.
     *
     * The TZS equivalent is not sent: the server multiplies the balance by this
     * rate in exact decimal arithmetic, so the figure BOT receives is the one
     * this system computed rather than one a browser rounded.
     */
    exchangeRate: exchangeRateSchema.optional(),
    rateDate: isoDateSchema.optional(),
  })
  .strict();

export type RecordBankBalanceRequest = z.infer<typeof recordBankBalanceRequestSchema>;

export const bankBalanceListQuerySchema = z
  .object({
    year: z.coerce.number().int().min(2000).max(9999),
    quarter: z.coerce.number().int().min(1).max(4),
  })
  .strict();

export type BankBalanceListQuery = z.infer<typeof bankBalanceListQuerySchema>;

/** An amount summed on the client's behalf, for a list header. */
export const financeTotalsSchema = z
  .object({
    income: moneyAmountSchema,
    expense: moneyAmountSchema,
    /** Income less expense over the same set. Can be negative. */
    net: moneyAmountSchema,
  })
  .strict();

export type FinanceTotals = z.infer<typeof financeTotalsSchema>;
