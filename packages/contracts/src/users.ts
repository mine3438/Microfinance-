import { z } from 'zod';

import { ROLES } from './authorization.js';
import { passwordSchema } from './auth.js';
import { emailSchema, isoTimestampSchema, requiredTextSchema, uuidSchema } from './scalars.js';

/**
 * Staff accounts, and the invitations that create them.
 *
 * Until this module existed an institution could not add a member of staff at
 * all. `user.read`, `user.invite` and `user.manage` were seeded by migration
 * 0005 and enforced nothing; the `invitations` table was created by the same
 * migration and nothing ever wrote to it. Every user in every deployment came
 * from a seed script, which means the loan-officer persona the whole product is
 * designed around could not be created by the people who need it.
 *
 * The shapes below are deliberately thin. An invitation is not a user, and the
 * two are kept apart on the wire because they answer different questions: "who
 * works here" and "who has been asked to".
 */

/** How a member of staff stands with the institution. Mirrors `users.status`. */
export const USER_STATUSES = ['invited', 'active', 'suspended'] as const;

export type UserStatus = (typeof USER_STATUSES)[number];

/**
 * The four states an invitation can be in.
 *
 * Derived on read from `expires_at`, `accepted_at` and `revoked_at` rather than
 * stored. A stored status would be a fourth copy of the same fact and could
 * disagree with the three timestamps that actually govern acceptance — and the
 * one that governs is whichever the acceptance path reads, not whichever the
 * list screen shows.
 */
export const INVITATION_STATES = ['pending', 'accepted', 'expired', 'revoked'] as const;

export type InvitationState = (typeof INVITATION_STATES)[number];

/** A member of staff, as a staff list shows them. */
export const staffMemberSchema = z
  .object({
    id: uuidSchema,
    fullName: z.string(),
    email: emailSchema,
    /** `null` for institution-wide authority — administrators, accountants, auditors. */
    branchId: uuidSchema.nullable(),
    branchName: z.string().nullable(),
    roles: z.array(z.enum(ROLES)),
    status: z.enum(USER_STATUSES),
    /** `null` until they have signed in once. */
    lastLoginAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export type StaffMember = z.infer<typeof staffMemberSchema>;

/** An invitation, as the staff screen lists it. */
export const invitationSchema = z
  .object({
    id: uuidSchema,
    email: emailSchema,
    fullName: z.string(),
    roleCode: z.enum(ROLES),
    branchId: uuidSchema.nullable(),
    branchName: z.string().nullable(),
    state: z.enum(INVITATION_STATES),
    invitedBy: uuidSchema,
    invitedByName: z.string().nullable(),
    expiresAt: isoTimestampSchema,
    acceptedAt: isoTimestampSchema.nullable(),
    revokedAt: isoTimestampSchema.nullable(),
    createdAt: isoTimestampSchema,
  })
  .strict();

export type Invitation = z.infer<typeof invitationSchema>;

/**
 * Inviting a member of staff.
 *
 * The institution is never a field. It comes from the inviter's own session,
 * because an institution identifier a caller can set is an invitation into
 * somebody else's tenant.
 */
export const createInvitationRequestSchema = z
  .object({
    email: emailSchema,
    fullName: requiredTextSchema(200),
    roleCode: z.enum(ROLES),
    /**
     * Which branch the invitee works in.
     *
     * Optional, and handled exactly as the borrower form handles it: a
     * branch-scoped inviter has it filled in from their own assignment and is
     * refused if they name a different one, while an institution-wide inviter
     * must state it or leave it null deliberately. `null` means institution-wide
     * authority, which is what the `users` table means by a null branch.
     */
    branchId: uuidSchema.nullable().optional(),
  })
  .strict();

export type CreateInvitationRequest = z.infer<typeof createInvitationRequestSchema>;

/**
 * What an invitee is told before they accept.
 *
 * Enough to know what they are joining and no more: no identifiers they could
 * use elsewhere, and nothing about the institution's other staff.
 */
export const invitationPreviewSchema = z
  .object({
    institutionName: z.string(),
    fullName: z.string(),
    email: emailSchema,
    roleCode: z.enum(ROLES),
    branchName: z.string().nullable(),
    expiresAt: isoTimestampSchema,
  })
  .strict();

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/**
 * Accepting an invitation.
 *
 * The token travels in the body rather than the path. A token in a URL is
 * written to the server's access log, kept in browser history, and sent in the
 * `Referer` header of anything the page subsequently loads — three copies of a
 * single-use credential in places nobody audits.
 */
export const acceptInvitationRequestSchema = z
  .object({
    token: z.string().min(1).max(512),
    password: passwordSchema,
  })
  .strict();

export type AcceptInvitationRequest = z.infer<typeof acceptInvitationRequestSchema>;

/** Reading an invitation before accepting it. Same reasoning about the token. */
export const previewInvitationRequestSchema = z
  .object({ token: z.string().min(1).max(512) })
  .strict();

export type PreviewInvitationRequest = z.infer<typeof previewInvitationRequestSchema>;

/**
 * What creating an invitation returns.
 *
 * `link` is present only when the configured delivery mechanism does not send
 * the invitation anywhere itself — see the `manual` mode in the API's
 * `notifications` module. It is the one place the token appears in plaintext,
 * it is returned once, to the authenticated administrator who has just created
 * it, and it is never stored.
 */
export const createdInvitationSchema = z
  .object({
    invitation: invitationSchema,
    /** How the invitation reached, or did not reach, the invitee. */
    delivery: z.enum(['manual', 'logged']),
    /** Present only for `manual` delivery. */
    link: z.string().nullable(),
  })
  .strict();

export type CreatedInvitation = z.infer<typeof createdInvitationSchema>;

/**
 * Amending a member of staff.
 *
 * Suspension and restoration only, plus branch reassignment. Deliberately not
 * role changes: a role change is a change of authority and belongs with the
 * same no-escalation check an invitation goes through, which needs its own
 * endpoint rather than an optional field on this one.
 */
export const updateStaffRequestSchema = z
  .object({
    status: z.enum(['active', 'suspended']).optional(),
    branchId: uuidSchema.nullable().optional(),
  })
  .strict()
  .refine((request) => request.status !== undefined || request.branchId !== undefined, {
    error: 'State what to change.',
  });

export type UpdateStaffRequest = z.infer<typeof updateStaffRequestSchema>;
