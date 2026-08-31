import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Entropy in a generated token, in bytes.
 *
 * 256 bits. Enough that guessing is not a threat model, which is what lets
 * these be hashed with SHA-256 rather than argon2 — see {@link hashToken}.
 */
export const TOKEN_BYTES = 32;

/** Length of the hex digest a token hashes to. */
const HASH_HEX_LENGTH = 64;

/**
 * Mint a token for an invitation, password reset, verification, or refresh.
 *
 * base64url so it survives a URL or an email without escaping — these values
 * travel in links, and a `+` or `/` mangled by a mail client is a support
 * ticket that looks like a bug.
 */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hash a token for storage.
 *
 * SHA-256, deliberately, where passwords get argon2. The two cases are not
 * alike: argon2's cost exists to make guessing a *low-entropy* human-chosen
 * secret infeasible. A token carries 256 bits of entropy from a CSPRNG, so
 * guessing is already infeasible and a slow hash would buy nothing while adding
 * latency to every refresh — the most frequent authenticated operation there is.
 *
 * What the hash does buy is that a database disclosure yields no usable tokens:
 * the value in the user's email or cookie cannot be recovered from what is
 * stored.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compare a token against a stored hash without leaking timing.
 *
 * A plain `===` on hashes exits at the first differing byte, so response time
 * correlates with how much of a guess was correct. That is exploitable when an
 * attacker can iterate, and the constant-time comparison costs nothing.
 */
export function tokenMatchesHash(token: string, storedHash: string): boolean {
  const computed = hashToken(token);

  // timingSafeEqual throws on length mismatch, which would itself be a timing
  // signal. Hashes are fixed-length, so anything else is malformed input.
  if (computed.length !== storedHash.length || storedHash.length !== HASH_HEX_LENGTH) {
    return false;
  }

  return timingSafeEqual(Buffer.from(computed, 'utf8'), Buffer.from(storedHash, 'utf8'));
}

/** A minted token and the hash to store for it. */
export interface IssuedToken {
  /** Sent to the user. Never stored. */
  readonly token: string;
  /** Stored. Cannot be reversed into the token. */
  readonly hash: string;
  /** When the token stops being valid. */
  readonly expiresAt: Date;
}

/** Issue a token with an expiry, in one step so the pair cannot be mismatched. */
export function issueToken(lifetimeSeconds: number, now: Date = new Date()): IssuedToken {
  if (!Number.isFinite(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new RangeError(
      `Token lifetime must be a positive number of seconds, received ${String(lifetimeSeconds)}.`,
    );
  }
  const token = generateToken();
  return {
    token,
    hash: hashToken(token),
    expiresAt: new Date(now.getTime() + lifetimeSeconds * 1000),
  };
}

/**
 * Default lifetimes.
 *
 * Short for anything that grants access; longer for an invitation, which a new
 * member of staff may not open until the next working day.
 */
export const TOKEN_LIFETIMES = {
  /** Refresh token. Rotated on every use, so a long life is bounded by rotation. */
  refresh: 30 * 24 * 60 * 60,
  /** Invitation. Long enough to survive a weekend. */
  invitation: 7 * 24 * 60 * 60,
  /** Email verification. */
  emailVerification: 24 * 60 * 60,
  /**
   * Password reset. Deliberately the shortest: it is the one token that can
   * take an account over, and a reset link sits in an inbox that may itself be
   * compromised.
   */
  passwordReset: 60 * 60,
} as const;

/** Whether a token has passed its expiry. */
export function isExpired(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}
