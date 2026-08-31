import { z } from 'zod';

import { ROLES } from './authorization.js';
import { positiveMoneyAmountSchema, isoTimestampSchema } from './scalars.js';

/**
 * Institution settings.
 *
 * The figures here are an institution's policy, not this system's. §13.3 asked
 * for approval thresholds as though they were a decision somebody could give
 * once; they are not — a provider in Arusha and one in Mwanza will set them
 * differently, and both will change them next year. So they are configured,
 * with an endpoint and a screen, rather than seeded in a migration.
 */

/** The most one role may sanction. */
export const approvalThresholdSchema = z
  .object({
    roleCode: z.enum(ROLES),
    roleName: z.string(),
    /** `null` where no limit is set, which means no authority at all. */
    maxPrincipal: positiveMoneyAmountSchema.nullable(),
    updatedAt: isoTimestampSchema.nullable(),
  })
  .strict();

export type ApprovalThreshold = z.infer<typeof approvalThresholdSchema>;

/**
 * Setting a limit.
 *
 * `null` removes it, and removing it removes the authority — the absence of a
 * row means a role may sanction nothing, never that it may sanction anything.
 */
export const setApprovalThresholdRequestSchema = z
  .object({ maxPrincipal: positiveMoneyAmountSchema.nullable() })
  .strict();

export type SetApprovalThresholdRequest = z.infer<typeof setApprovalThresholdRequestSchema>;
