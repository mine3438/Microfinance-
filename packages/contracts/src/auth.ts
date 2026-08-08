import { z } from 'zod';

import { PERMISSIONS, ROLES } from './authorization.js';
import { emailSchema, isoTimestampSchema, uuidSchema } from './scalars.js';

/**
 * Shortest password accepted.
 *
 * Length is the only password rule enforced. Composition rules — an upper, a
 * digit, a symbol — measurably reduce entropy in practice by pushing people
 * towards `Password1!`, and NIST SP 800-63B has advised against them since
 * 2017. Twelve characters with no further constraint admits a passphrase,
 * which is both stronger and easier to remember.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Longest password accepted.
 *
 * A bound is required, not a nicety: argon2id hashes whatever it is given, so
 * an unbounded password field is a CPU-exhaustion vector against the most
 * expensive operation the server performs. 128 characters is far beyond any
 * real passphrase.
 */
export const MAXIMUM_PASSWORD_LENGTH = 128;

/**
 * A password on its way in.
 *
 * Not trimmed. Leading and trailing spaces are legitimate characters in a
 * passphrase, and silently removing them means a password set through one
 * client cannot be entered through another.
 */
export const passwordSchema = z
  .string()
  .min(
    MINIMUM_PASSWORD_LENGTH,
    `Must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters. A memorable phrase is stronger than a short complex password.`,
  )
  .max(MAXIMUM_PASSWORD_LENGTH, `Must be at most ${String(MAXIMUM_PASSWORD_LENGTH)} characters.`);

export const loginRequestSchema = z
  .object({
    email: emailSchema,
    /**
     * Only length-bounded on login, never checked against the password policy.
     *
     * An existing password predates whatever the policy is today. Rejecting a
     * login because the stored password no longer satisfies the current rules
     * locks out the account instead of prompting a change.
     */
    password: z.string().min(1, 'Password is required.').max(MAXIMUM_PASSWORD_LENGTH),
  })
  .strict();

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** A branch the user is assigned to, or `null` for institution-wide authority. */
export const sessionBranchSchema = z
  .object({
    id: uuidSchema,
    name: z.string(),
    code: z.string(),
  })
  .strict();

/**
 * Who the caller is, as the client needs to know it.
 *
 * Permissions are sent resolved rather than as role names for the client to
 * expand. The expansion is an authorisation decision, and an authorisation
 * decision made twice is an authorisation decision that can disagree with
 * itself. The server resolves; the client renders.
 *
 * This is a convenience for the interface, never a control. The API re-derives
 * the principal from the token on every request and checks it again there,
 * because a client is free to send whatever it likes.
 */
export const sessionUserSchema = z
  .object({
    id: uuidSchema,
    email: z.string(),
    fullName: z.string(),
    institutionId: uuidSchema,
    institutionName: z.string(),
    branch: sessionBranchSchema.nullable(),
    roles: z.array(z.enum(ROLES)),
    permissions: z.array(z.enum(PERMISSIONS)),
    emailVerifiedAt: isoTimestampSchema.nullable(),
    lastLoginAt: isoTimestampSchema.nullable(),
  })
  .strict();

export type SessionUser = z.infer<typeof sessionUserSchema>;

/**
 * What a successful login returns.
 *
 * The refresh token is **not** here. It is set as an `HttpOnly`, `Secure`,
 * `SameSite=Strict` cookie, so script running in the page cannot read it and an
 * XSS payload cannot exfiltrate it. The access token is returned in the body
 * for the client to hold in memory only — never in `localStorage`, which is
 * readable by any script on the origin and survives the tab.
 *
 * The asymmetry is the point: the short-lived token lives where XSS can reach
 * it but expires in minutes; the long-lived one lives where XSS cannot.
 */
export const loginResponseSchema = z
  .object({
    accessToken: z.string(),
    /** Seconds until `accessToken` expires. */
    expiresIn: z.number().int().positive(),
    user: sessionUserSchema,
  })
  .strict();

export type LoginResponse = z.infer<typeof loginResponseSchema>;

/**
 * What a refresh returns.
 *
 * No user record. A refresh is not a re-authentication and must not be treated
 * as a cheap way to poll for changed permissions — permission changes take
 * effect when the access token next expires, which bounds the staleness to the
 * token lifetime.
 */
export const refreshResponseSchema = z
  .object({
    accessToken: z.string(),
    expiresIn: z.number().int().positive(),
  })
  .strict();

export type RefreshResponse = z.infer<typeof refreshResponseSchema>;

/** Acknowledgement of an operation with nothing to return. */
export const acknowledgementSchema = z.object({ ok: z.literal(true) }).strict();

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
