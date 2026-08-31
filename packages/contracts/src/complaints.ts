import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import {
  isoDateSchema,
  isoTimestampSchema,
  nonNegativeMoneyAmountSchema,
  requiredTextSchema,
  uuidSchema,
} from './scalars.js';

/**
 * Customer complaints.
 *
 * Kept as records rather than as a quarterly tally, because MSP2-06 is a
 * movement statement: opening, received, resolved by two different routes,
 * closing, and four referral lines. Every one of those is a question about
 * dates, and a stored quarterly figure can answer none of them
 * (02-BOT-REPORTING-SPEC.md §8).
 *
 * Two vocabularies here are BOT's and not this system's. The **nature** is one
 * of their six categories — their form has a column per category and no room
 * for a seventh — and the **resolution route** is one of the two lines by which
 * a complaint leaves the unresolved population. Neither is free text.
 */

/** Where an unresolved complaint has been taken. BOT names four. */
export const REFERRAL_DESTINATIONS = [
  'bank_of_tanzania',
  'fair_competition_commission',
  'courts',
  'other_parties',
] as const;

export type ReferralDestination = (typeof REFERRAL_DESTINATIONS)[number];

/** The two routes MSP2-06 accounts for a resolution by. */
export const RESOLUTION_ROUTES = ['institution', 'other_party'] as const;

export type ResolutionRoute = (typeof RESOLUTION_ROUTES)[number];

/** One of BOT's six nature categories, as published. */
export const complaintNatureSchema = z
  .object({ code: z.string(), sno: z.number().int().positive(), name: z.string() })
  .strict();

export type ComplaintNature = z.infer<typeof complaintNatureSchema>;

export const complaintSchema = z
  .object({
    id: uuidSchema,
    complaintCode: z.string(),
    complainantName: z.string(),
    /** `null` where the complainant is not a client on the books. */
    clientId: uuidSchema.nullable(),
    clientName: z.string().nullable(),
    branchId: uuidSchema,
    branchName: z.string(),
    natureCode: z.string(),
    /** BOT's own label for the nature, so a list reads without a second call. */
    natureName: z.string(),
    summary: z.string(),
    /** The amount in dispute. Zero is a real answer, not a missing one. */
    amount: nonNegativeMoneyAmountSchema,
    receivedOn: isoDateSchema,
    resolvedOn: isoDateSchema.nullable(),
    resolvedBy: z.enum(RESOLUTION_ROUTES).nullable(),
    resolutionNote: z.string().nullable(),
    referredTo: z.enum(REFERRAL_DESTINATIONS).nullable(),
    referredOn: isoDateSchema.nullable(),
    recordedBy: uuidSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type Complaint = z.infer<typeof complaintSchema>;

export const logComplaintRequestSchema = z
  .object({
    complainantName: requiredTextSchema(200),
    clientId: uuidSchema.optional(),
    branchId: uuidSchema,
    natureCode: requiredTextSchema(60),
    summary: requiredTextSchema(2000),
    amount: nonNegativeMoneyAmountSchema.optional(),
    receivedOn: isoDateSchema,
  })
  .strict();

export type LogComplaintRequest = z.infer<typeof logComplaintRequestSchema>;

/**
 * Resolving a complaint.
 *
 * The route is required, and deliberately: BOT's lines 3 and 4 are the only
 * ways a complaint leaves the unresolved population, so a resolution that named
 * neither would disappear from the roll-forward.
 */
export const resolveComplaintRequestSchema = z
  .object({
    resolvedOn: isoDateSchema,
    resolvedBy: z.enum(RESOLUTION_ROUTES),
    resolutionNote: requiredTextSchema(2000),
  })
  .strict();

export type ResolveComplaintRequest = z.infer<typeof resolveComplaintRequestSchema>;

/** Referring a complaint onward. Dated, because MSP2-06 counts as at a date. */
export const referComplaintRequestSchema = z
  .object({
    referredTo: z.enum(REFERRAL_DESTINATIONS),
    referredOn: isoDateSchema,
  })
  .strict();

export type ReferComplaintRequest = z.infer<typeof referComplaintRequestSchema>;

export const COMPLAINT_STATES = ['open', 'resolved'] as const;

export type ComplaintState = (typeof COMPLAINT_STATES)[number];

export const complaintListQuerySchema = paginationQuerySchema
  .extend({
    state: z.enum(COMPLAINT_STATES).optional(),
    natureCode: z.string().optional(),
    branchId: uuidSchema.optional(),
  })
  .strict();

export type ComplaintListQuery = z.infer<typeof complaintListQuerySchema>;
