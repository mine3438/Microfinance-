import { hash, verify } from '@node-rs/argon2';

import { WeakPasswordError } from './errors.js';

/**
 * `Algorithm.Argon2id` from `@node-rs/argon2`, as a literal.
 *
 * The library declares it as an ambient `const enum`, which cannot be imported
 * under `verbatimModuleSyntax` — the value has no runtime existence to import.
 * A magic number in a security parameter is unacceptable on its own, so a test
 * asserts that a hash produced with it is prefixed `$argon2id$`. That check is
 * stronger than the import would have been: it verifies the algorithm actually
 * used, not the constant we believed maps to it.
 */
const ARGON2ID = 2;

/**
 * Argon2id parameters, stated explicitly rather than left to library defaults.
 *
 * These are OWASP's recommended argon2id configuration: 19 MiB of memory, two
 * iterations, one degree of parallelism. Writing them out means a future
 * library upgrade that changes its defaults cannot silently weaken every
 * password in the system, and it makes the cost a reviewable decision rather
 * than an inherited one.
 *
 * argon2id specifically — not argon2i or argon2d — because it resists both
 * side-channel and GPU attacks, which is the combination a stolen database
 * dump calls for.
 */
export const ARGON2_PARAMETERS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Minimum password length.
 *
 * NIST SP 800-63B advises length over composition rules: forced symbols and
 * digits push users toward predictable substitutions without adding real
 * entropy. Twelve characters with no composition requirement is stronger in
 * practice than eight with four character classes.
 */
export const MINIMUM_PASSWORD_LENGTH = 12;

/**
 * Maximum accepted length.
 *
 * Not a security limit — argon2 handles arbitrary input — but a denial-of-
 * service one. Hashing is deliberately expensive, so unbounded input is an
 * attacker-controlled cost multiplier.
 */
export const MAXIMUM_PASSWORD_LENGTH = 256;

/**
 * A hash of a value no user will ever supply.
 *
 * Used when authenticating an address that does not exist: verifying against
 * this takes the same time as verifying a real password, so response timing
 * does not reveal which addresses are registered. Without it, login becomes an
 * account-enumeration oracle — measurably faster for unknown addresses, since
 * no hash is computed at all.
 *
 * Computed once at module load rather than per request.
 */
let cachedDummyHash: string | undefined;

/**
 * Reject passwords the policy does not allow.
 *
 * @throws {WeakPasswordError} when the password is too short, too long, or blank.
 */
export function assertPasswordPolicy(password: string): void {
  if (password.trim().length === 0) {
    throw new WeakPasswordError('Password must not be blank.');
  }
  if (password.length < MINIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at least ${String(MINIMUM_PASSWORD_LENGTH)} characters.`,
    );
  }
  if (password.length > MAXIMUM_PASSWORD_LENGTH) {
    throw new WeakPasswordError(
      `Password must be at most ${String(MAXIMUM_PASSWORD_LENGTH)} characters.`,
    );
  }
}

/**
 * Hash a password for storage.
 *
 * The policy is enforced here rather than only at the API boundary, so no code
 * path can store a hash of a password the policy would have rejected.
 *
 * @throws {WeakPasswordError} when the password fails {@link assertPasswordPolicy}.
 */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordPolicy(password);
  return hash(password, ARGON2_PARAMETERS);
}

/**
 * Check a password against a stored hash.
 *
 * Returns `false` rather than throwing on a malformed hash: a corrupt or
 * truncated stored value must fail authentication, not surface an internal
 * error to whoever is trying to log in.
 */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password, ARGON2_PARAMETERS);
  } catch {
    return false;
  }
}

/**
 * A hash to verify against when the account does not exist.
 *
 * Call this and discard the result, so an unknown address costs the same as a
 * known one. See {@link cachedDummyHash} for why.
 */
export async function dummyHash(): Promise<string> {
  cachedDummyHash ??= await hash(
    'account-enumeration-guard-not-a-real-password',
    ARGON2_PARAMETERS,
  );
  return cachedDummyHash;
}

/**
 * Whether a stored hash was produced with parameters weaker than the current ones.
 *
 * Cost parameters rise over time as hardware improves. A hash encodes the
 * parameters it was made with, so an old one can be spotted and transparently
 * upgraded the next time the user logs in — the only moment the plaintext is
 * available to rehash.
 */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (match === null) {
    // Not argon2id at all, or unparseable: replace it at the next opportunity.
    return true;
  }
  const [, memory, time, parallelism] = match;
  return (
    Number(memory) < ARGON2_PARAMETERS.memoryCost ||
    Number(time) < ARGON2_PARAMETERS.timeCost ||
    Number(parallelism) < ARGON2_PARAMETERS.parallelism
  );
}
