import { describe, expect, it } from 'vitest';

import { WeakPasswordError } from './errors.js';
import {
  ARGON2_PARAMETERS,
  MAXIMUM_PASSWORD_LENGTH,
  MINIMUM_PASSWORD_LENGTH,
  assertPasswordPolicy,
  dummyHash,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

const VALID_PASSWORD = 'correct horse battery staple';

describe('argon2 configuration', () => {
  it('actually produces argon2id hashes', async () => {
    // The algorithm is configured as a numeric literal, because the library
    // declares it as an ambient const enum that cannot be imported under
    // verbatimModuleSyntax. This asserts the number means what we think: a
    // silently wrong value would select argon2d or argon2i, both weaker
    // choices against a stolen database.
    const hash = await hashPassword(VALID_PASSWORD);

    expect(hash.startsWith('$argon2id$')).toBe(true);
  });

  it('encodes the OWASP-recommended cost parameters', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    expect(hash).toContain('$v=19$');
    expect(hash).toContain(
      `m=${String(ARGON2_PARAMETERS.memoryCost)},` +
        `t=${String(ARGON2_PARAMETERS.timeCost)},` +
        `p=${String(ARGON2_PARAMETERS.parallelism)}`,
    );
  });
});

describe('password policy', () => {
  it('accepts a long passphrase with no special characters', async () => {
    // Length over composition, per NIST SP 800-63B.
    await expect(hashPassword(VALID_PASSWORD)).resolves.toBeTypeOf('string');
  });

  it.each([
    ['blank', ''],
    ['whitespace only', '            '],
    ['one short of the minimum', 'a'.repeat(MINIMUM_PASSWORD_LENGTH - 1)],
  ])('rejects a password that is %s', (_label, password) => {
    expect(() => {
      assertPasswordPolicy(password);
    }).toThrow(WeakPasswordError);
  });

  it('accepts exactly the minimum length', () => {
    expect(() => {
      assertPasswordPolicy('a'.repeat(MINIMUM_PASSWORD_LENGTH));
    }).not.toThrow();
  });

  it('rejects input beyond the maximum, which is a cost-amplification guard', () => {
    // Hashing is deliberately expensive, so unbounded input is an
    // attacker-controlled multiplier on server work.
    expect(() => {
      assertPasswordPolicy('a'.repeat(MAXIMUM_PASSWORD_LENGTH + 1));
    }).toThrow(/at most/);
  });

  it('enforces the policy inside hashPassword, not only at the boundary', async () => {
    // So no code path can store a hash of a password the policy would reject.
    await expect(hashPassword('short')).rejects.toThrow(WeakPasswordError);
  });
});

describe('verification', () => {
  it('accepts the correct password', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    await expect(verifyPassword(hash, VALID_PASSWORD)).resolves.toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    await expect(verifyPassword(hash, 'correct horse battery stapl')).resolves.toBe(false);
  });

  it('is case sensitive', async () => {
    const hash = await hashPassword(VALID_PASSWORD);

    await expect(verifyPassword(hash, VALID_PASSWORD.toUpperCase())).resolves.toBe(false);
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without a per-hash salt, identical passwords share a hash and one
    // rainbow-table hit compromises every account that chose it.
    const first = await hashPassword(VALID_PASSWORD);
    const second = await hashPassword(VALID_PASSWORD);

    expect(first).not.toBe(second);
    await expect(verifyPassword(first, VALID_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(second, VALID_PASSWORD)).resolves.toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not a hash', 'not-a-hash'],
    ['truncated', '$argon2id$v=19$m=19456,t=2,p=1$abc'],
    ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuv'],
  ])('returns false rather than throwing on a %s stored value', async (_label, storedHash) => {
    // A corrupt stored hash must fail authentication, not surface an internal
    // error to whoever is trying to log in.
    await expect(verifyPassword(storedHash, VALID_PASSWORD)).resolves.toBe(false);
  });
});

describe('account enumeration guard', () => {
  it('provides a verifiable hash for addresses that do not exist', async () => {
    // Verified and discarded when an address is unknown, so login costs the
    // same either way. Without it, an unknown address returns measurably
    // faster — no hash is computed at all — and login becomes an oracle for
    // which addresses are registered.
    const hash = await dummyHash();

    expect(hash.startsWith('$argon2id$')).toBe(true);
    await expect(verifyPassword(hash, 'anything at all')).resolves.toBe(false);
  });

  it('returns the same hash on repeat calls, so it costs nothing per request', async () => {
    expect(await dummyHash()).toBe(await dummyHash());
  });
});

describe('rehash detection', () => {
  it('leaves a hash at current parameters alone', async () => {
    expect(needsRehash(await hashPassword(VALID_PASSWORD))).toBe(false);
  });

  it('flags a hash made with less memory', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=2,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('flags a hash made with fewer iterations', () => {
    expect(needsRehash('$argon2id$v=19$m=19456,t=1,p=1$c2FsdA$aGFzaA')).toBe(true);
  });

  it('flags a hash from a different algorithm entirely', () => {
    expect(needsRehash('$2b$12$abcdefghijklmnopqrstuv')).toBe(true);
  });

  it('flags an unparseable value', () => {
    expect(needsRehash('')).toBe(true);
  });

  it('leaves a stronger-than-current hash alone', () => {
    // Upgrading is one-directional: a hash already above the current cost is
    // not weakened back down to it.
    expect(needsRehash('$argon2id$v=19$m=65536,t=4,p=2$c2FsdA$aGFzaA')).toBe(false);
  });
});
