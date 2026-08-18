import { z } from 'zod';

import { paginationQuerySchema } from './pagination.js';
import { isoDateSchema, isoTimestampSchema, requiredTextSchema, uuidSchema } from './scalars.js';

/**
 * Borrower records.
 *
 * Almost every field here exists because a BOT return needs it, not because a
 * form looked incomplete without it. `gender` is two values because MSP2-09 and
 * MSP2-10 provide exactly two columns; `districtCode` and `sectorCode` are
 * controlled vocabularies because those returns aggregate across a fixed
 * hierarchy and one misspelling drops a borrower silently out of the total.
 */

/** BOT's two columns. Not a product opinion — see `gender.ts` in `@mfi/domain`. */
export const GENDERS = ['male', 'female'] as const;
export type Gender = (typeof GENDERS)[number];

export const CLIENT_STATUSES = ['active', 'inactive'] as const;
export type ClientStatus = (typeof CLIENT_STATUSES)[number];

/**
 * A phone number on the way in.
 *
 * Accepted in any of the forms a Tanzanian user actually types — `0712345678`,
 * `+255712345678`, `255712345678`, with or without spaces — and normalised to
 * E.164 by the domain before it is stored. The loose bound here is deliberate:
 * the precise rule lives in `PhoneNumber.parse`, and duplicating it as a regex
 * would create a second definition that can disagree with the first.
 *
 * The system this replaces stored whatever was typed and validated only in the
 * browser, so the same borrower could exist twice under `0712345678` and
 * `+255712345678` — two client records, two loan histories, one person.
 */
export const phoneInputSchema = z
  .string()
  .trim()
  .min(9, 'A phone number is required.')
  .max(20, 'That is too long to be a phone number.');

/** A district or sector code from BOT's seeded taxonomy. */
const referenceCodeSchema = z.string().trim().min(1).max(32);

/**
 * Earliest date of birth treated as plausible.
 *
 * Mirrors the `clients_date_of_birth_plausible` constraint. The bound is
 * generous rather than a policy on lending age, which the documentation does
 * not state — its purpose is to catch a mistyped year, which is far more common
 * than a borrower born in 1887.
 */
const EARLIEST_BIRTH_DATE = '1900-01-01';

/**
 * A date of birth.
 *
 * Checked here as well as by the database. The constraint is the real defence —
 * it holds against an import or a future endpoint that skips this schema — but
 * a constraint firing produces an error that names no field. Validating first
 * is what lets the refusal say *which* input was wrong, and put it beside the
 * right box on a form.
 */
export const dateOfBirthSchema = isoDateSchema
  .refine((value) => value > EARLIEST_BIRTH_DATE, {
    error: 'That is too long ago to be a date of birth — check the year.',
  })
  .refine((value) => value < new Date().toISOString().slice(0, 10), {
    error: 'A date of birth cannot be today or in the future.',
  });

export const clientSchema = z
  .object({
    id: uuidSchema,
    /** Allocated by the database, never supplied: `MFI-2026-001`. */
    clientCode: z.string(),
    branchId: uuidSchema,
    branchName: z.string(),
    fullName: z.string(),
    gender: z.enum(GENDERS),
    dateOfBirth: isoDateSchema,
    /** Always E.164, whatever form it was entered in. */
    phone: z.string(),
    districtCode: z.string(),
    districtName: z.string(),
    sectorCode: z.string(),
    sectorName: z.string(),
    status: z.enum(CLIENT_STATUSES),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export type Client = z.infer<typeof clientSchema>;

export const createClientRequestSchema = z
  .object({
    /**
     * Which branch owns the relationship.
     *
     * Required by the schema because MSP2-10 reports borrowers per district
     * through their branch, and a client belonging to no branch could not be
     * placed on that return.
     *
     * Optional here: a user assigned to a branch has it filled in from their
     * own assignment, and is refused if they name a different one. Only a user
     * with institution-wide authority must state it, because for them there is
     * nothing to infer.
     */
    branchId: uuidSchema.optional(),
    fullName: requiredTextSchema(200),
    gender: z.enum(GENDERS),
    dateOfBirth: dateOfBirthSchema,
    phone: phoneInputSchema,
    districtCode: referenceCodeSchema,
    sectorCode: referenceCodeSchema,
  })
  .strict();

export type CreateClientRequest = z.infer<typeof createClientRequestSchema>;

/**
 * What may be corrected after registration.
 *
 * Not `branchId`, and not `clientCode`. Moving a client between branches
 * changes which officer's portfolio they count in and which district they
 * report under, and the documentation says nothing about who may do it or what
 * happens to loans already in flight — so it is not a field on an edit form
 * (01-ARCHITECTURE.md §13). `clientCode` is allocated once and may appear on a
 * signed loan agreement.
 *
 * Every key is optional, and at least one must be present: an update naming
 * nothing is a mistake in the caller, not a no-op worth accepting.
 */
export const updateClientRequestSchema = z
  .object({
    fullName: requiredTextSchema(200).optional(),
    phone: phoneInputSchema.optional(),
    districtCode: referenceCodeSchema.optional(),
    sectorCode: referenceCodeSchema.optional(),
    status: z.enum(CLIENT_STATUSES).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    error: 'Name at least one field to change.',
  });

export type UpdateClientRequest = z.infer<typeof updateClientRequestSchema>;

/** Filters a client list accepts, on top of the pagination parameters. */
export const clientListQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CLIENT_STATUSES).optional(),
  branchId: uuidSchema.optional(),
  /**
   * Free-text match on name or client code.
   *
   * Bounded, and matched with a parameterised `ILIKE` rather than assembled
   * into SQL. A search box is the most-typed unvalidated input in any admin
   * system.
   */
  search: z.string().trim().min(1).max(100).optional(),
});

export type ClientListQuery = z.infer<typeof clientListQuerySchema>;

/**
 * A branch, as a client needs it to file something against one.
 *
 * Served rather than derived from the session, because the session's branch is
 * `null` for a user with institution-wide authority — and a screen that read
 * only the session would leave exactly those users unable to record a client, a
 * complaint or a savings account at all.
 */
export const branchSchema = z
  .object({
    id: uuidSchema,
    code: z.string(),
    name: z.string(),
    isHeadOffice: z.boolean(),
    status: z.enum(['active', 'closed']),
  })
  .strict();

export type Branch = z.infer<typeof branchSchema>;
