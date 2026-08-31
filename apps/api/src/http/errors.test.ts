import { DomainValidationError } from '@mfi/domain';
import { describe, expect, it } from 'vitest';

import { InvalidTokenError } from '../auth/access-token.js';
import { ApiError, classify, toErrorResponse } from './errors.js';

/** A driver error, shaped the way `pg` shapes one. */
function postgresError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(
      'duplicate key value violates unique constraint "clients_code_unique_per_institution"',
    ),
    { code, table: 'clients', constraint: 'clients_code_unique_per_institution' },
  );
}

describe('classify', () => {
  it('passes an ApiError through unchanged', () => {
    const original = new ApiError('conflict', 'Already recorded.');

    expect(classify(original)).toBe(original);
  });

  it('turns a domain rule violation into a 422 carrying its message', () => {
    // These messages are written for the person who triggered them, which is
    // why the domain raises typed errors rather than returning booleans.
    const classified = classify(new DomainValidationError('A payment must be positive.'));

    expect(classified.status).toBe(422);
    expect(classified.message).toBe('A payment must be positive.');
  });

  it('reduces an invalid token to a bare 401', () => {
    const classified = classify(new InvalidTokenError('signature verification failed'));

    expect(classified.status).toBe(401);
    // The reason goes to the log. Returning it would let a caller tell a forged
    // token from an expired one.
    expect(classified.message).not.toContain('signature');
  });

  it.each([
    ['unique_violation', '23505', 409],
    ['foreign_key_violation', '23503', 400],
    ['check_violation', '23514', 400],
    ['not_null_violation', '23502', 400],
    ['invalid_text_representation', '22P02', 400],
    ['numeric_value_out_of_range', '22003', 400],
  ])('maps %s to %s rather than a 500', (_label, code, status) => {
    // The schema is the last line of defence and is meant to be. But a
    // constraint firing on bad input is the caller's fault: reported as a 500
    // it is untrue, unactionable, and hides real faults in the logs.
    expect(classify(postgresError(code)).status).toBe(status);
  });

  it('discloses no table or constraint name when it does', () => {
    const classified = classify(postgresError('23505'));

    expect(classified.message).not.toContain('clients');
    expect(classified.message).not.toContain('constraint');
  });

  it('leaves an unrecognised database error as an opaque 500', () => {
    // Deny by default: only codes named above are treated as the caller's
    // fault. A serialisation failure or a dead connection is ours.
    expect(classify(postgresError('40001')).status).toBe(500);
  });

  it('turns anything unrecognised into an opaque 500', () => {
    const classified = classify(new Error('connection terminated unexpectedly'));

    expect(classified.status).toBe(500);
    expect(classified.message).not.toContain('connection');
  });

  it('survives a thrown value that is not an error at all', () => {
    expect(classify('something odd').status).toBe(500);
    expect(classify(null).status).toBe(500);
  });
});

describe('toErrorResponse', () => {
  it('always carries the correlation id', () => {
    const body = toErrorResponse(new ApiError('not_found', 'No such client.'), 'trace-1');

    expect(body.error.correlationId).toBe('trace-1');
  });

  it('omits details and retry when there are none, rather than sending nulls', () => {
    const body = toErrorResponse(new ApiError('not_found', 'No such client.'), 'trace-1');

    expect(Object.keys(body.error).sort()).toEqual(['code', 'correlationId', 'message']);
  });
});
