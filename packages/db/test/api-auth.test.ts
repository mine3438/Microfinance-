import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * The pre-tenant authentication lookups, and the boundary around them.
 *
 * These functions are the only way anything in the system sees past row-level
 * security, so the tests that matter most are the ones proving how little they
 * can do. A lookup that quietly returned a second institution's user, or a role
 * that could write through the exemption it was given to read, would not fail
 * anywhere else — the application would work, and the isolation the rest of the
 * schema enforces would be gone.
 */

const INSTITUTION_A = '77777777-7777-7777-8777-777777777771';
const INSTITUTION_B = '77777777-7777-7777-8777-777777777772';

const EMAIL_A = 'auth.officer.a@faraja.co.tz';
const EMAIL_B = 'auth.officer.b@tumaini.co.tz';

let pool: pg.Pool;
let db: Database;

let userA: string;
let userB: string;

interface LoginIdentity {
  user_id: string;
  institution_id: string;
  password_hash: string | null;
  user_status: string;
  institution_status: string;
}

interface RefreshLookup {
  token_id: string;
  institution_id: string;
  user_id: string;
  family_id: string;
  expires_at: Date;
  used_at: Date | null;
  revoked_at: Date | null;
  user_status: string;
  institution_status: string;
}

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

/**
 * Two institutions, one active user each.
 *
 * Two rather than one throughout, because the interesting failure of a lookup
 * that bypasses tenancy is not "returns nothing" — it is "returns the wrong
 * tenant's row", and a single-institution fixture cannot see that.
 */
beforeEach(async () => {
  const owned = [INSTITUTION_A, INSTITUTION_B];

  await db.withTransaction(async (client) => {
    for (const table of ['refresh_tokens', 'user_tokens', 'user_roles', 'invitations', 'users']) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = ANY($1::uuid[])`, [owned]);
    }
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);

    await client.query(
      'INSERT INTO institutions (id, name, status) VALUES ($1, $2, $3), ($4, $5, $6)',
      [
        INSTITUTION_A,
        'Auth Institution A',
        'active',
        INSTITUTION_B,
        'Auth Institution B',
        'active',
      ],
    );

    const users = await client.query<{ id: string; institution_id: string }>(
      `INSERT INTO users (institution_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'Officer A', '$argon2id$v=19$fixture-a', 'active'),
              ($3, $4, 'Officer B', '$argon2id$v=19$fixture-b', 'active')
       RETURNING id, institution_id`,
      [INSTITUTION_A, EMAIL_A, INSTITUTION_B, EMAIL_B],
    );

    userA = users.rows.find((row) => row.institution_id === INSTITUTION_A)!.id;
    userB = users.rows.find((row) => row.institution_id === INSTITUTION_B)!.id;
  });
});

/** Call as `mfi_app` with no tenant setting, which is the state login runs in. */
async function asApplicationWithoutTenant<T>(
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  return db.withTransaction(async (client) => {
    await client.query('SET LOCAL ROLE mfi_app');
    return work(client);
  });
}

describe('auth.find_login_identity', () => {
  it('resolves an email with no tenant context, which is the whole point', async () => {
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]),
    );

    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.user_id).toBe(userA);
    expect(found.rows[0]?.institution_id).toBe(INSTITUTION_A);
  });

  it('matches regardless of case, as the lower(email) unique index does', async () => {
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [
        EMAIL_A.toUpperCase(),
      ]),
    );

    expect(found.rows[0]?.user_id).toBe(userA);
  });

  it('tolerates surrounding whitespace, which a paste into a login field carries', async () => {
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [`  ${EMAIL_A}  `]),
    );

    expect(found.rows[0]?.user_id).toBe(userA);
  });

  it('returns exactly one row for an email held in one institution', async () => {
    // The guarantee login rests on: email is unique across every tenant, so
    // resolving one cannot be ambiguous and no institution hint is needed.
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_B]),
    );

    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.user_id).toBe(userB);
    expect(found.rows[0]?.institution_id).toBe(INSTITUTION_B);
  });

  it('returns no row for an unknown email, deciding nothing about what that means', async () => {
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', ['nobody@x.co.tz']),
    );

    expect(found.rows).toHaveLength(0);
  });

  it('returns a suspended user rather than hiding them', async () => {
    // Hiding a suspended account here would make it indistinguishable from an
    // unknown email — the same response for two different situations, one of
    // which the user can act on by contacting their administrator. The refusal
    // belongs in the use case, which can answer identically while logging the
    // difference.
    await db.withTransaction(async (client) => {
      await client.query('UPDATE users SET status = $1 WHERE id = $2', ['suspended', userA]);
    });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]),
    );

    expect(found.rows[0]?.user_status).toBe('suspended');
  });

  it('reports a suspended institution, so its staff cannot log in to it', async () => {
    await db.withTransaction(async (client) => {
      await client.query('UPDATE institutions SET status = $1 WHERE id = $2', [
        'suspended',
        INSTITUTION_A,
      ]);
    });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]),
    );

    expect(found.rows[0]?.institution_status).toBe('suspended');
    expect(found.rows[0]?.user_status).toBe('active');
  });

  it('returns a null hash for an invited user who has not set a password', async () => {
    await db.withTransaction(async (client) => {
      await client.query('UPDATE users SET status = $1, password_hash = NULL WHERE id = $2', [
        'invited',
        userA,
      ]);
    });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]),
    );

    expect(found.rows[0]?.password_hash).toBeNull();
  });

  it('returns no column the session response does not need', async () => {
    // The exemption covers identification only. A name, a branch or a role
    // arriving here would mean the session payload was assembled outside the
    // tenant-scoped path, and the exemption would have quietly become the read
    // path for user data.
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<LoginIdentity>('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]),
    );

    expect(Object.keys(found.rows[0] ?? {}).sort()).toEqual([
      'institution_id',
      'institution_status',
      'password_hash',
      'user_id',
      'user_status',
    ]);
  });
});

describe('the exemption boundary', () => {
  it('leaves ordinary reads of users still governed by row-level security', async () => {
    // The function exists beside the policies, not instead of them. If calling
    // it relaxed anything for the rest of the transaction, this would return
    // both users.
    const rows = await asApplicationWithoutTenant(async (client) => {
      await client.query('SELECT * FROM auth.find_login_identity($1)', [EMAIL_A]);
      return client.query<{ count: string }>('SELECT count(*)::text AS count FROM users');
    });

    expect(rows.rows[0]?.count).toBe('0');
  });

  it('scopes an ordinary read to the caller institution even after a cross-tenant lookup', async () => {
    const rows = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        // Resolve institution B's user, then read the user table normally.
        await client.query('SELECT * FROM auth.find_login_identity($1)', [EMAIL_B]);
        return client.query<{ id: string }>('SELECT id FROM users');
      },
    );

    expect(rows.rows.map((row) => row.id)).toEqual([userA]);
  });

  it('denies mfi_auth every column no lookup returns', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query('SET LOCAL ROLE mfi_auth');
        await client.query('SELECT full_name FROM users');
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies mfi_auth any write at all', async () => {
    // The role holds SELECT and nothing else. Its policies are FOR SELECT, so
    // even a granted write would find no policy permitting it — two independent
    // reasons this fails, which is the point of granting privileges and
    // policies separately.
    await expect(
      db.withTransaction(async (client) => {
        await client.query('SET LOCAL ROLE mfi_auth');
        await client.query('UPDATE users SET status = $1 WHERE id = $2', ['suspended', userA]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('does not let mfi_auth reach a table it was never granted', async () => {
    // Denied outright rather than returning an empty result, and the stronger
    // outcome is worth asserting precisely: the role holds no privilege on the
    // table, so the request fails before row-level security is consulted at
    // all. NOBYPASSRLS is the second line — the exemption is exactly the three
    // policies written for it, and a table added by a later migration is
    // covered by none of them.
    await expect(
      db.withTransaction(async (client) => {
        await client.query('SET LOCAL ROLE mfi_auth');
        await client.query('SELECT count(*) FROM clients');
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('auth.find_refresh_token', () => {
  // Namespaced to this file. `refresh_tokens.token_hash` is unique across every
  // institution — deliberately, since a hash is looked up before any tenant is
  // known — while each suite's fixture only clears its own institutions' rows.
  // Two files sharing a literal hash therefore collide through whatever one of
  // them leaves behind, which is a property of the schema rather than a
  // fixture bug to fix in one place.
  const TOKEN_HASH = 'api-auth-issued'.padEnd(64, '0');
  const UNISSUED_HASH = 'api-auth-unissued'.padEnd(64, '0');

  /** A bind parameter is a value, never an expression — `now()` here is a literal. */
  const thirtyDaysFromNow = (): string =>
    new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  async function issueToken(
    overrides: {
      usedAt?: string | null;
      revokedAt?: string | null;
      expiresAt?: string;
      hash?: string;
    } = {},
  ): Promise<{ tokenId: string; familyId: string }> {
    return db.withTransaction(async (client) => {
      const inserted = await client.query<{ id: string; family_id: string }>(
        `INSERT INTO refresh_tokens
           (institution_id, user_id, family_id, token_hash, expires_at, used_at, revoked_at)
         VALUES ($1, $2, gen_random_uuid(), $3, $4, $5, $6)
         RETURNING id, family_id`,
        [
          INSTITUTION_A,
          userA,
          overrides.hash ?? TOKEN_HASH,
          overrides.expiresAt ?? thirtyDaysFromNow(),
          overrides.usedAt ?? null,
          overrides.revokedAt ?? null,
        ],
      );

      return { tokenId: inserted.rows[0]!.id, familyId: inserted.rows[0]!.family_id };
    });
  }

  it('resolves a token to its session with no tenant context', async () => {
    const { tokenId, familyId } = await issueToken();

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<RefreshLookup>('SELECT * FROM auth.find_refresh_token($1)', [TOKEN_HASH]),
    );

    expect(found.rows[0]?.token_id).toBe(tokenId);
    expect(found.rows[0]?.family_id).toBe(familyId);
    expect(found.rows[0]?.institution_id).toBe(INSTITUTION_A);
  });

  it('returns an already-used token, because that is what reuse detection reads', async () => {
    // Filtering consumed tokens out here would discard the evidence: a token
    // presented after it was rotated past means it was captured. Without the
    // row, a stolen token is indistinguishable from an expired one and the
    // family is never revoked.
    await issueToken({ usedAt: new Date().toISOString() });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<RefreshLookup>('SELECT * FROM auth.find_refresh_token($1)', [TOKEN_HASH]),
    );

    expect(found.rows).toHaveLength(1);
    expect(found.rows[0]?.used_at).not.toBeNull();
  });

  it('returns a revoked token rather than hiding it', async () => {
    await issueToken({ revokedAt: new Date().toISOString() });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<RefreshLookup>('SELECT * FROM auth.find_refresh_token($1)', [TOKEN_HASH]),
    );

    expect(found.rows[0]?.revoked_at).not.toBeNull();
  });

  it('returns nothing for a hash that was never issued', async () => {
    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<RefreshLookup>('SELECT * FROM auth.find_refresh_token($1)', [UNISSUED_HASH]),
    );

    expect(found.rows).toHaveLength(0);
  });

  it('carries the user and institution status, so a suspension ends live sessions', async () => {
    // Access tokens are short-lived but not instant. Checking status on refresh
    // is what bounds a suspended user's remaining access to one token lifetime
    // rather than to the refresh token's thirty days.
    await issueToken();
    await db.withTransaction(async (client) => {
      await client.query('UPDATE users SET status = $1 WHERE id = $2', ['suspended', userA]);
    });

    const found = await asApplicationWithoutTenant(async (client) =>
      client.query<RefreshLookup>('SELECT * FROM auth.find_refresh_token($1)', [TOKEN_HASH]),
    );

    expect(found.rows[0]?.user_status).toBe('suspended');
  });
});
