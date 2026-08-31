import { type RoleCode, type SessionUser, isPermission, isRoleCode } from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';
import { type Permission, type Principal } from '@mfi/identity';

/** What `auth.find_login_identity` returns, in this layer's vocabulary. */
export interface LoginIdentity {
  readonly userId: string;
  readonly institutionId: string;
  /** `null` for an invited user who has not set a password. */
  readonly passwordHash: string | null;
  readonly userStatus: string;
  readonly institutionStatus: string;
}

/** What `auth.find_refresh_token` returns. */
export interface RefreshTokenRecord {
  readonly tokenId: string;
  readonly institutionId: string;
  readonly userId: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly userStatus: string;
  readonly institutionStatus: string;
}

/** A resolved principal together with the profile the client renders. */
export interface ResolvedSession {
  readonly principal: Principal;
  readonly user: SessionUser;
}

/** A refresh token about to be stored. */
export interface RefreshTokenToStore {
  readonly hash: string;
  readonly familyId: string;
  readonly expiresAt: Date;
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

/**
 * Everything authentication needs from the database.
 *
 * Declared as an interface the use cases depend on, with the Postgres
 * implementation below it. The use cases hold the rules — when a family is
 * revoked, what a suspended institution means — and never see a client or a
 * statement.
 */
export interface SessionRepository {
  findLoginIdentity(email: string): Promise<LoginIdentity | null>;
  findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null>;
  resolveSession(institutionId: string, userId: string): Promise<ResolvedSession | null>;
  /** Store a new refresh token, and stamp the login. One transaction. */
  beginSession(
    institutionId: string,
    userId: string,
    token: RefreshTokenToStore,
    now: Date,
  ): Promise<void>;
  /**
   * Consume `usedTokenId` and issue `replacement` in its place.
   *
   * Both in one transaction, because a rotation that stored the new token but
   * failed to consume the old one would leave two live tokens in a family and
   * make the next legitimate refresh look like a replay.
   */
  rotateRefreshToken(
    institutionId: string,
    usedTokenId: string,
    replacement: RefreshTokenToStore,
    now: Date,
  ): Promise<void>;
  /** Revoke every token in a family. */
  revokeFamily(institutionId: string, familyId: string, reason: string, now: Date): Promise<void>;
}

interface LoginIdentityRow {
  user_id: string;
  institution_id: string;
  password_hash: string | null;
  user_status: string;
  institution_status: string;
}

interface RefreshTokenRow {
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

interface ProfileRow {
  id: string;
  email: string;
  full_name: string;
  institution_name: string;
  branch_id: string | null;
  branch_name: string | null;
  branch_code: string | null;
  email_verified_at: Date | null;
  last_login_at: Date | null;
}

/** Postgres-backed implementation. */
export class PostgresSessionRepository implements SessionRepository {
  public constructor(private readonly database: Database) {}

  /**
   * Resolve an email with no tenant context.
   *
   * Goes through `auth.find_login_identity`, the SECURITY DEFINER lookup added
   * by migration 0012 — see its header for why the exemption exists and how
   * narrow it is. This is one of only two places in the application that runs
   * outside a tenant transaction, which is why both are named methods here
   * rather than an option on a general one.
   */
  public async findLoginIdentity(email: string): Promise<LoginIdentity | null> {
    const result = await this.database.withTransaction(async (client) =>
      client.query<LoginIdentityRow>('SELECT * FROM auth.find_login_identity($1)', [email]),
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      userId: row.user_id,
      institutionId: row.institution_id,
      passwordHash: row.password_hash,
      userStatus: row.user_status,
      institutionStatus: row.institution_status,
    };
  }

  public async findRefreshToken(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const result = await this.database.withTransaction(async (client) =>
      client.query<RefreshTokenRow>('SELECT * FROM auth.find_refresh_token($1)', [tokenHash]),
    );

    const row = result.rows[0];
    if (row === undefined) {
      return null;
    }

    return {
      tokenId: row.token_id,
      institutionId: row.institution_id,
      userId: row.user_id,
      familyId: row.family_id,
      expiresAt: row.expires_at,
      usedAt: row.used_at,
      revokedAt: row.revoked_at,
      userStatus: row.user_status,
      institutionStatus: row.institution_status,
    };
  }

  /**
   * Load the principal and the profile, inside the tenant.
   *
   * Deliberately not part of the pre-tenant lookup. Once the institution is
   * known, everything else is read through the ordinary row-level-security
   * path, so the profile a user sees is scoped by the same policies that scope
   * every other read. The exemption covers identification only.
   */
  public async resolveSession(
    institutionId: string,
    userId: string,
  ): Promise<ResolvedSession | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const profile = await client.query<ProfileRow>(
        `SELECT u.id, u.email, u.full_name, u.branch_id,
                u.email_verified_at, u.last_login_at,
                i.name AS institution_name,
                b.name AS branch_name, b.code AS branch_code
           FROM users u
           JOIN institutions i ON i.id = u.institution_id
           LEFT JOIN branches b ON b.id = u.branch_id
          WHERE u.id = $1`,
        [userId],
      );

      const row = profile.rows[0];
      if (row === undefined) {
        return null;
      }

      const roles = await client.query<{ role_code: string }>(
        'SELECT role_code FROM user_roles WHERE user_id = $1 ORDER BY role_code',
        [userId],
      );
      const permissions = await client.query<{ code: string }>(
        'SELECT code FROM user_permissions($1) AS code ORDER BY code',
        [userId],
      );

      // Narrowed rather than cast. The database is the authority on what a role
      // and a permission are, but a code seeded there and unknown here means
      // the two have drifted, and silently trusting it would put a string the
      // application cannot check into an authorisation decision.
      const roleCodes: RoleCode[] = roles.rows
        .map((entry) => entry.role_code)
        .filter((code): code is RoleCode => isRoleCode(code));
      const permissionCodes: Permission[] = permissions.rows
        .map((entry) => entry.code)
        .filter((code): code is Permission => isPermission(code));

      const branch =
        row.branch_id === null || row.branch_name === null || row.branch_code === null
          ? null
          : { id: row.branch_id, name: row.branch_name, code: row.branch_code };

      return {
        principal: {
          userId: row.id,
          institutionId,
          branchId: row.branch_id,
          roles: roleCodes,
          permissions: new Set(permissionCodes),
        },
        user: {
          id: row.id,
          email: row.email,
          fullName: row.full_name,
          institutionId,
          institutionName: row.institution_name,
          branch,
          roles: roleCodes,
          permissions: permissionCodes,
          emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
          lastLoginAt: row.last_login_at?.toISOString() ?? null,
        },
      };
    });
  }

  public async beginSession(
    institutionId: string,
    userId: string,
    token: RefreshTokenToStore,
    now: Date,
  ): Promise<void> {
    await this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      await this.insertRefreshToken(client, institutionId, userId, token);
      await client.query('UPDATE users SET last_login_at = $1 WHERE id = $2', [now, userId]);
    });
  }

  public async rotateRefreshToken(
    institutionId: string,
    usedTokenId: string,
    replacement: RefreshTokenToStore,
    now: Date,
  ): Promise<void> {
    await this.database.withTenantTransaction({ institutionId }, async (client) => {
      // Guarded by `used_at IS NULL`, so two refreshes racing on the same token
      // cannot both succeed: the second updates no rows and is treated as the
      // replay it is.
      const consumed = await client.query(
        'UPDATE refresh_tokens SET used_at = $1 WHERE id = $2 AND used_at IS NULL',
        [now, usedTokenId],
      );

      if (consumed.rowCount !== 1) {
        throw new ConcurrentRotationError(usedTokenId);
      }

      const owner = await client.query<{ user_id: string }>(
        'SELECT user_id FROM refresh_tokens WHERE id = $1',
        [usedTokenId],
      );
      const userId = owner.rows[0]?.user_id;
      if (userId === undefined) {
        throw new ConcurrentRotationError(usedTokenId);
      }

      await this.insertRefreshToken(client, institutionId, userId, replacement);
    });
  }

  public async revokeFamily(
    institutionId: string,
    familyId: string,
    reason: string,
    now: Date,
  ): Promise<void> {
    await this.database.withTenantTransaction({ institutionId }, async (client) => {
      await client.query(
        `UPDATE refresh_tokens
            SET revoked_at = $1, revoked_reason = $2
          WHERE family_id = $3 AND revoked_at IS NULL`,
        [now, reason, familyId],
      );
    });
  }

  private async insertRefreshToken(
    client: TransactionClient,
    institutionId: string,
    userId: string,
    token: RefreshTokenToStore,
  ): Promise<void> {
    await client.query(
      `INSERT INTO refresh_tokens
         (institution_id, user_id, family_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        institutionId,
        userId,
        token.familyId,
        token.hash,
        token.expiresAt,
        token.userAgent,
        token.ipAddress,
      ],
    );
  }
}

/**
 * Two requests tried to rotate the same refresh token.
 *
 * Raised when the guarded update consumes no row, which means another
 * transaction already consumed it. Indistinguishable from a replay at this
 * layer, and treated as one: the caller ends the session rather than guessing
 * which of the two was legitimate.
 */
export class ConcurrentRotationError extends Error {
  public override readonly name = 'ConcurrentRotationError';

  public constructor(public readonly tokenId: string) {
    super(`Refresh token ${tokenId} was consumed by a concurrent request.`);
  }
}
