import { z } from 'zod';

/**
 * Every failure the API is willing to name.
 *
 * A closed set, because a client that branches on error text breaks the moment
 * someone improves the wording. Codes are stable; messages are not.
 *
 * The set is deliberately coarse. A code exists when a caller would reasonably
 * do something different on seeing it — retry after a delay, re-authenticate,
 * show a field error, tell the user to contact their administrator. Codes that
 * only describe where in the server the failure happened are the caller's
 * problem to ignore and ours to keep supporting, so they are not minted.
 */
export const ERROR_CODES = [
  /** The request body, query or parameters did not satisfy the schema. */
  'validation_failed',
  /** No credentials, or credentials that no longer authenticate. */
  'unauthenticated',
  /** Authenticated, but lacking the permission the operation requires. */
  'forbidden',
  /** The addressed resource does not exist, or is not visible to this caller. */
  'not_found',
  /** The request is valid but conflicts with the current state of the resource. */
  'conflict',
  /** A business rule refused the operation. */
  'rule_violation',
  /** Too many requests; `retryAfterSeconds` says when to try again. */
  'rate_limited',
  /** Something failed that the caller cannot correct. */
  'internal_error',
  /** A dependency the request needed is unavailable. */
  'service_unavailable',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * One thing wrong with one field.
 *
 * `path` is a JSON pointer-ish segment list rather than a dotted string, so a
 * client can walk it into a nested form without parsing. Array indices appear
 * as numbers.
 */
export const fieldErrorSchema = z
  .object({
    path: z.array(z.union([z.string(), z.number().int()])),
    message: z.string().min(1),
  })
  .strict();

export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * The single shape every non-2xx response takes.
 *
 * Uniform on purpose: a client writes one error handler, not one per endpoint.
 *
 * What is **not** here is as deliberate as what is. No stack trace, no SQL, no
 * driver message, no internal identifier beyond the correlation ID (§10.5).
 * The system this replaces surfaced raw Postgres errors to the browser, which
 * told an attacker the schema and told the user nothing they could act on.
 */
export const errorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.enum(ERROR_CODES),
        /** Safe to display. Never contains internal detail. */
        message: z.string().min(1),
        /**
         * Ties this response to the server logs.
         *
         * Present on every error including internal ones, because "quote this
         * reference to support" is the only useful thing a user can be told
         * about a failure whose cause they must not see.
         */
        correlationId: z.string().min(1),
        /** Present when `code` is `validation_failed`. */
        details: z.array(fieldErrorSchema).optional(),
        /** Present when `code` is `rate_limited`. */
        retryAfterSeconds: z.number().int().positive().optional(),
      })
      // Strict, so that a field which would leak internals cannot be added to
      // an error response by accident — an error object spread from a caught
      // exception carries `stack` and, from the driver, `detail` and `query`.
      // A schema that quietly stripped them would let the mistake through in a
      // handler that does not go via this schema; one that rejects them makes
      // the mistake fail where it is made.
      .strict(),
  })
  .strict();

export type ErrorResponse = z.infer<typeof errorResponseSchema>;
