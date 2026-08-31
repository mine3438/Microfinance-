import { describe, expect, it } from 'vitest';

import {
  TOKEN_BYTES,
  TOKEN_LIFETIMES,
  generateToken,
  hashToken,
  isExpired,
  issueToken,
  tokenMatchesHash,
} from './tokens.js';

describe('token generation', () => {
  it('produces URL-safe values', () => {
    // These travel in email links. A '+' or '/' mangled by a mail client is a
    // support ticket that looks like a bug.
    expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('carries the full 256 bits of entropy', () => {
    // base64url encodes 3 bytes per 4 characters, without padding.
    expect(generateToken()).toHaveLength(Math.ceil((TOKEN_BYTES * 8) / 6));
  });

  it('never repeats across a large sample', () => {
    const tokens = new Set(Array.from({ length: 10_000 }, () => generateToken()));

    expect(tokens.size).toBe(10_000);
  });
});

describe('token hashing', () => {
  it('produces a 64-character hex digest', () => {
    expect(hashToken('some-token')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(hashToken('some-token')).toBe(hashToken('some-token'));
  });

  it('differs for different inputs', () => {
    expect(hashToken('token-a')).not.toBe(hashToken('token-b'));
  });

  it('does not contain the token, so a database disclosure yields nothing usable', () => {
    const token = generateToken();

    expect(hashToken(token)).not.toContain(token);
  });
});

describe('token comparison', () => {
  it('accepts a token against its own hash', () => {
    const token = generateToken();

    expect(tokenMatchesHash(token, hashToken(token))).toBe(true);
  });

  it('rejects a different token', () => {
    expect(tokenMatchesHash(generateToken(), hashToken(generateToken()))).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['too short', 'abc'],
    ['one character short', 'a'.repeat(63)],
    ['one character long', 'a'.repeat(65)],
  ])('rejects a %s stored hash without throwing', (_label, storedHash) => {
    // timingSafeEqual throws on a length mismatch, and that throw would itself
    // be a timing signal. Malformed input has to fail quietly.
    expect(() => tokenMatchesHash('token', storedHash)).not.toThrow();
    expect(tokenMatchesHash('token', storedHash)).toBe(false);
  });

  it('rejects a hash that differs only in its final character', () => {
    const token = generateToken();
    const hash = hashToken(token);
    const tampered = hash.slice(0, -1) + (hash.endsWith('a') ? 'b' : 'a');

    expect(tokenMatchesHash(token, tampered)).toBe(false);
  });
});

describe('token issuance', () => {
  it('returns a token, its hash, and an expiry together', () => {
    const now = new Date('2026-08-07T10:00:00.000Z');
    const issued = issueToken(3600, now);

    expect(hashToken(issued.token)).toBe(issued.hash);
    expect(issued.expiresAt.toISOString()).toBe('2026-08-07T11:00:00.000Z');
  });

  it('pairs the hash to the token it issued, so the two cannot be mismatched', () => {
    const issued = issueToken(60);

    expect(tokenMatchesHash(issued.token, issued.hash)).toBe(true);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects a lifetime of %j', (lifetime) => {
    expect(() => issueToken(lifetime)).toThrow(RangeError);
  });
});

describe('token lifetimes', () => {
  it('gives password reset the shortest window', () => {
    // It is the one token that can take an account over, and a reset link sits
    // in an inbox that may itself be compromised.
    const others = [
      TOKEN_LIFETIMES.refresh,
      TOKEN_LIFETIMES.invitation,
      TOKEN_LIFETIMES.emailVerification,
    ];

    expect(others.every((lifetime) => lifetime > TOKEN_LIFETIMES.passwordReset)).toBe(true);
  });

  it('gives an invitation long enough to survive a weekend', () => {
    expect(TOKEN_LIFETIMES.invitation).toBeGreaterThanOrEqual(3 * 24 * 60 * 60);
  });
});

describe('expiry', () => {
  const now = new Date('2026-08-07T10:00:00.000Z');

  it('treats a future expiry as live', () => {
    expect(isExpired(new Date('2026-08-07T10:00:01.000Z'), now)).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isExpired(new Date('2026-08-07T09:59:59.000Z'), now)).toBe(true);
  });

  it('treats the exact expiry instant as expired', () => {
    // The boundary belongs to the closed side: a token is valid *until* its
    // expiry, not through it.
    expect(isExpired(now, now)).toBe(true);
  });
});
