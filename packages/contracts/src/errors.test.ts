import { describe, expect, it } from 'vitest';

import { ERROR_CODES, errorResponseSchema } from './errors.js';

describe('errorResponseSchema', () => {
  const base = {
    error: {
      code: 'validation_failed',
      message: 'The request could not be validated.',
      correlationId: '01930000-0000-7000-8000-000000000009',
    },
  };

  it('accepts a minimal error', () => {
    expect(errorResponseSchema.parse(base).error.code).toBe('validation_failed');
  });

  it('carries field errors as path segments a client can walk into a form', () => {
    const parsed = errorResponseSchema.parse({
      error: {
        ...base.error,
        details: [{ path: ['schedule', 0, 'principal'], message: 'Must be greater than zero.' }],
      },
    });

    expect(parsed.error.details?.[0]?.path).toEqual(['schedule', 0, 'principal']);
  });

  it('carries a retry delay when the caller is rate limited', () => {
    const parsed = errorResponseSchema.parse({
      error: { ...base.error, code: 'rate_limited', retryAfterSeconds: 30 },
    });

    expect(parsed.error.retryAfterSeconds).toBe(30);
  });

  it('always requires a correlation ID', () => {
    // "Quote this reference to support" is the only useful thing a user can be
    // told about a failure whose cause they must not be shown.
    const { correlationId: _omitted, ...withoutCorrelation } = base.error;
    expect(errorResponseSchema.safeParse({ error: withoutCorrelation }).success).toBe(false);
  });

  it('rejects a code outside the closed set', () => {
    expect(errorResponseSchema.safeParse({ error: { ...base.error, code: 'oops' } }).success).toBe(
      false,
    );
  });

  it('has no field for a stack trace, a SQL statement or a driver message', () => {
    // The system this replaces surfaced raw Postgres errors to the browser,
    // which told an attacker the schema and told the user nothing actionable.
    for (const leak of ['stack', 'sql', 'detail', 'query', 'cause']) {
      expect(errorResponseSchema.safeParse({ error: { ...base.error, [leak]: 'x' } }).success).toBe(
        false,
      );
    }
  });

  it('rejects an empty message, which would render as a blank error dialog', () => {
    expect(errorResponseSchema.safeParse({ error: { ...base.error, message: '' } }).success).toBe(
      false,
    );
  });

  it('names a code for every distinct action a caller might take', () => {
    expect([...ERROR_CODES]).toEqual([
      'validation_failed',
      'unauthenticated',
      'forbidden',
      'not_found',
      'conflict',
      'rule_violation',
      'rate_limited',
      'internal_error',
      'service_unavailable',
    ]);
  });
});
