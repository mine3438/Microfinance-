import { z } from 'zod';

import { isoDateSchema, isoTimestampSchema, requiredTextSchema, uuidSchema } from './scalars.js';

/**
 * Lending groups, and who belongs to them.
 *
 * The approved model (GROUP-01…04): the **group is the borrower**, liability is
 * joint, and a group loan has one disbursement, one balance, one schedule and
 * one combined repayment. Members belong to the group but receive no sub-loan
 * and no member-level balance.
 *
 * What is here is the group and its membership. What is deliberately *not* here
 * is any way to lend to one — see GROUP-05 in the decision register. Every MSP2
 * exposure query reaches a loan's borrower attributes through
 * `loans.client_id`, and a group has no single sector, gender, age or district,
 * so a group loan would drop out of MSP2-03, 09 and 10 without saying so.
 * Nothing in the supplied documentation says how a group loan is reported, and
 * splitting one across members would be inventing a regulatory answer.
 */

export const GROUP_STATUSES = ['active', 'closed'] as const;

export type GroupStatus = (typeof GROUP_STATUSES)[number];

export const groupSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    branchId: uuidSchema,
    branchName: z.string().nullable(),
    /** When the group was formed, which is not when it was keyed in. */
    formedOn: isoDateSchema,
    status: z.enum(GROUP_STATUSES),
    /** Members whose interval is open right now. */
    currentMemberCount: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export type Group = z.infer<typeof groupSchema>;

/**
 * One person's membership of one group, as an interval.
 *
 * Intervals rather than a flat roster, because the approved rules require that
 * historical loan records stay interpretable when membership changes. "Who was
 * jointly liable when this was advanced" has no answer against a roster that
 * only knows today.
 */
export const groupMemberSchema = z
  .object({
    id: uuidSchema,
    groupId: uuidSchema,
    clientId: uuidSchema,
    clientName: z.string(),
    clientCode: z.string().nullable(),
    joinedOn: isoDateSchema,
    /** `null` while the member is still in the group. */
    leftOn: isoDateSchema.nullable(),
  })
  .strict();

export type GroupMember = z.infer<typeof groupMemberSchema>;

export const createGroupRequestSchema = z
  .object({
    code: requiredTextSchema(50),
    name: requiredTextSchema(200),
    /**
     * Which branch administers the group.
     *
     * Optional, and handled as the borrower form handles it: a branch-scoped
     * user has it filled in from their own assignment and is refused if they
     * name a different one.
     */
    branchId: uuidSchema.optional(),
    formedOn: isoDateSchema,
  })
  .strict();

export type CreateGroupRequest = z.infer<typeof createGroupRequestSchema>;

export const updateGroupRequestSchema = z
  .object({
    name: requiredTextSchema(200).optional(),
    status: z.enum(GROUP_STATUSES).optional(),
  })
  .strict()
  .refine((request) => request.name !== undefined || request.status !== undefined, {
    error: 'State what to change.',
  });

export type UpdateGroupRequest = z.infer<typeof updateGroupRequestSchema>;

export const addGroupMemberRequestSchema = z
  .object({
    clientId: uuidSchema,
    /** When they joined. Defaults to today; a future date is refused. */
    joinedOn: isoDateSchema.optional(),
  })
  .strict();

export type AddGroupMemberRequest = z.infer<typeof addGroupMemberRequestSchema>;

/**
 * Recording that a member has left.
 *
 * A departure closes the interval. It never deletes the membership, because the
 * period they were in the group is part of what makes an earlier loan legible.
 */
export const endGroupMembershipRequestSchema = z
  .object({
    leftOn: isoDateSchema.optional(),
  })
  .strict();

export type EndGroupMembershipRequest = z.infer<typeof endGroupMembershipRequestSchema>;

/** Reading membership as it stood on a date, rather than as it stands now. */
export const groupMemberQuerySchema = z
  .object({
    asAt: isoDateSchema.optional(),
  })
  .strict();

export type GroupMemberQuery = z.infer<typeof groupMemberQuerySchema>;
