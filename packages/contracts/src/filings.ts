import { z } from 'zod';

import { compileReturnQuerySchema, compiledReturnSchema } from './reporting.js';
import { isoTimestampSchema, requiredTextSchema, uuidSchema } from './scalars.js';

/**
 * Returns as filed.
 *
 * A filing is a record of what was sent, not a query that can be re-run. Six
 * months after a submission the loan book has moved, a mis-keyed payment has
 * been reversed, and recompiling that quarter would produce a different
 * document from the one BOT holds — so the whole compiled return is stored and
 * served back verbatim.
 *
 * The system being replaced retained nothing: reports were generated in the
 * browser and never kept, so an institution asked to explain a figure had
 * nothing to produce (analysis R10).
 */

/** A filing as it appears in a list, without the document itself. */
export const filedReturnSchema = z
  .object({
    id: uuidSchema,
    year: z.number().int(),
    quarter: z.number().int(),
    /** Which forms the filed document contains. */
    formCodes: z.array(z.string()),
    /**
     * Validation findings recorded at the moment of filing.
     *
     * Kept because the verdict is part of what was relied on: a return filed
     * before a rule changed should still show the verdict it was filed under.
     */
    findingCount: z.number().int().nonnegative(),
    filedBy: uuidSchema,
    filedByName: z.string(),
    filedAt: isoTimestampSchema,
    /** BOT's acknowledgement, once the institution has one. */
    submissionReference: z.string().nullable(),
  })
  .strict();

export type FiledReturn = z.infer<typeof filedReturnSchema>;

/** A filing with the document it recorded. */
export const filedReturnDetailSchema = filedReturnSchema
  .extend({ document: compiledReturnSchema })
  .strict();

export type FiledReturnDetail = z.infer<typeof filedReturnDetailSchema>;

/**
 * Options on the filing itself.
 *
 * The same options a compilation takes, because the document archived has to be
 * the one that was reviewed — filing with a different rate convention from the
 * one on screen would record a return nobody looked at.
 */
export const fileReturnRequestSchema = compileReturnQuerySchema;

export type FileReturnRequest = z.infer<typeof fileReturnRequestSchema>;

export const recordSubmissionReferenceRequestSchema = z
  .object({ submissionReference: requiredTextSchema(100) })
  .strict();

export type RecordSubmissionReferenceRequest = z.infer<
  typeof recordSubmissionReferenceRequestSchema
>;
