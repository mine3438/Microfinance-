import { type ErrorCode, type ErrorResponse, type FieldError } from '@mfi/contracts';
import { DatabaseError, MissingTenantContextError } from '@mfi/db';
import { DomainError } from '@mfi/domain';
import { MoneyError } from '@mfi/money';
import { type ZodError } from 'zod';

import { InvalidTokenError } from '../auth/access-token.js';

/** HTTP status for each error code. One mapping, so no route invents its own. */
const STATUS_BY_CODE: Readonly<Record<ErrorCode, number>> = Object.freeze({
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rule_violation: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
});

/**
 * A failure the API is willing to describe to the caller.
 *
 * The distinction that matters: an `ApiError` carries a message written to be
 * read by a user, and anything else that reaches the error handler does not.
 * Throwing this is the act of deciding a message is safe to disclose, which is
 * why it is explicit rather than inferred from an exception's text.
 */
export class ApiError extends Error {
  public override readonly name = 'ApiError';

  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: readonly FieldError[],
    options?: { cause?: unknown; retryAfterSeconds?: number },
  ) {
    super(message, options === undefined ? undefined : { cause: options.cause });
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }

  /** Seconds to wait before retrying. Set on `rate_limited` only. */
  public readonly retryAfterSeconds: number | undefined;

  public get status(): number {
    return STATUS_BY_CODE[this.code];
  }
}

/**
 * Refuse a caller that has exceeded its allowance.
 *
 * Returned by the rate limiter's `errorResponseBuilder`, which **throws**
 * whatever that function returns. Returning a plain response body there sends
 * an unrecognised object into the error handler, where the deny-by-default rule
 * correctly turns it into a 500 — a rate limit reported as a server fault, and
 * one that tells the caller nothing about when to try again.
 */
export const rateLimited = (retryAfterSeconds: number): ApiError =>
  new ApiError(
    'rate_limited',
    `Too many requests. Try again in ${String(retryAfterSeconds)} seconds.`,
    undefined,
    { retryAfterSeconds },
  );

/**
 * No credentials, or credentials that no longer authenticate.
 *
 * One message for every cause. Distinguishing "no token" from "expired token"
 * from "token for a deleted user" would be a small convenience for a client and
 * a reliable oracle for anyone probing the endpoint.
 */
export const unauthenticated = (message = 'Authentication is required.'): ApiError =>
  new ApiError('unauthenticated', message);

export const forbidden = (
  message = 'You do not have permission to perform this action.',
): ApiError => new ApiError('forbidden', message);

export const notFound = (message = 'Not found.'): ApiError => new ApiError('not_found', message);

export const conflict = (message: string): ApiError => new ApiError('conflict', message);

export const ruleViolation = (message: string): ApiError => new ApiError('rule_violation', message);

/** Turn a zod failure into field errors a form can attach to its inputs. */
export function validationFailed(error: ZodError, message = 'The request is not valid.'): ApiError {
  const details: FieldError[] = error.issues.map((issue) => ({
    path: issue.path.map((segment) => (typeof segment === 'symbol' ? String(segment) : segment)),
    message: issue.message,
  }));

  return new ApiError('validation_failed', message, details);
}

/**
 * What a client is told about an unexpected failure.
 *
 * The message is fixed and says nothing. Whatever was thrown — a driver error
 * naming a constraint and a table, a stack trace, a failed SQL statement — is
 * logged against the correlation ID and never travels. The system this replaces
 * surfaced raw Postgres errors to the browser, which described the schema to an
 * attacker and told the user nothing they could act on (§10.5).
 */
const INTERNAL_MESSAGE =
  'Something went wrong on our side. Quote the reference below if you contact support.';

/**
 * Classify anything thrown during a request.
 *
 * The default is `internal_error` with a fixed message, and every other outcome
 * requires a type this codebase defined. That direction matters: a new error
 * type added anywhere becomes a 500 with nothing disclosed, rather than
 * whatever its `message` happens to contain.
 */
export function classify(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof InvalidTokenError) {
    // The specific reason is logged, not returned.
    return unauthenticated();
  }

  if (error instanceof MissingTenantContextError) {
    // Reaching a tenant-scoped operation with no tenant is a defect in this
    // server, not something the caller did. It is called out separately from
    // the generic case only so that it is never mistaken for a client error and
    // handed a 4xx, which would hide it in the logs among ordinary bad input.
    return new ApiError('internal_error', INTERNAL_MESSAGE, undefined, { cause: error });
  }

  if (error instanceof DomainError || error instanceof MoneyError) {
    // A business rule refused the operation. These messages are written for the
    // person who triggered them — "a payment must be positive", "the approver
    // may not be the person who submitted" — and are the reason the domain
    // raises typed errors rather than returning booleans.
    return new ApiError('rule_violation', error.message, undefined, { cause: error });
  }

  if (error instanceof DatabaseError) {
    return new ApiError('internal_error', INTERNAL_MESSAGE, undefined, { cause: error });
  }

  return new ApiError('internal_error', INTERNAL_MESSAGE, undefined, { cause: error });
}

/** Build the response body. The only place an error becomes JSON. */
export function toErrorResponse(error: ApiError, correlationId: string): ErrorResponse {
  return {
    error: {
      code: error.code,
      message: error.message,
      correlationId,
      ...(error.details === undefined ? {} : { details: [...error.details] }),
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    },
  };
}
