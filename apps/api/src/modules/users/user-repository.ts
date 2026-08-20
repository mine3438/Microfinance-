import {
  type Invitation,
  type InvitationState,
  type Permission,
  type RoleCode,
  type StaffMember,
  type UserStatus,
  isPermission,
  isRoleCode,
} from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';

/** What the pre-tenant lookup returns, in this layer's vocabulary. */
export interface InvitationIdentity {
  readonly invitationId: string;
  readonly institutionId: string;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly institutionStatus: string;
}

/** An invitation being created, with its token already hashed. */
export interface InvitationToCreate {
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: RoleCode;
  readonly branchId: string | null;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly invitedBy: string;
}

/** What an address already is within one institution, if anything. */
export interface ExistingAccount {
  readonly userId: string;
  readonly status: UserStatus;
  readonly hasPassword: boolean;
}

/** Everything acceptance needs about an invitation, read under the tenant. */
export interface InvitationSubject {
  readonly invitationId: string;
  readonly institutionId: string;
  readonly institutionName: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleCode: RoleCode;
  readonly branchId: string | null;
  readonly branchName: string | null;
  readonly expiresAt: Date;
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
}

interface StaffRow {
  id: string;
  full_name: string;
  email: string;
  branch_id: string | null;
  branch_name: string | null;
  roles: string[] | null;
  status: string;
  last_login_at: Date | null;
  created_at: Date;
}

interface InvitationRow {
  id: string;
  email: string;
  full_name: string;
  role_code: string;
  branch_id: string | null;
  branch_name: string | null;
  invited_by: string;
  invited_by_name: string | null;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function toStatus(value: string): UserStatus {
  if (value !== 'invited' && value !== 'active' && value !== 'suspended') {
    throw new Error(`A user row carries an unrecognised status: ${value}`);
  }
  return value;
}

function toRole(value: string): RoleCode {
  if (!isRoleCode(value)) {
    throw new Error(`A row names a role this application does not recognise: ${value}`);
  }
  return value;
}

const STAFF_PROJECTION = `
  SELECT u.id, u.full_name, u.email, u.branch_id, b.name AS branch_name,
         u.status, u.last_login_at, u.created_at,
         (SELECT array_agg(r.role_code ORDER BY r.role_code)
            FROM user_roles r WHERE r.user_id = u.id) AS roles
    FROM users u
    LEFT JOIN branches b ON b.id = u.branch_id`;

const INVITATION_PROJECTION = `
  SELECT v.id, v.email, v.full_name, v.role_code, v.branch_id, b.name AS branch_name,
         v.invited_by, i.full_name AS invited_by_name,
         v.expires_at, v.accepted_at, v.revoked_at, v.created_at
    FROM invitations v
    LEFT JOIN branches b ON b.id = v.branch_id
    LEFT JOIN users i    ON i.id = v.invited_by`;

function toStaffMember(row: StaffRow): StaffMember {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    branchId: row.branch_id,
    branchName: row.branch_name,
    roles: (row.roles ?? []).map(toRole),
    status: toStatus(row.status),
    lastLoginAt: row.last_login_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Which of the four states an invitation is in, at a given instant.
 *
 * Derived, never stored. Order matters: a revoked invitation that has also
 * passed its expiry is reported revoked, because revocation is a decision
 * somebody made and expiry is only the clock — and the person reading the list
 * wants to know which.
 */
export function invitationStateAt(
  row: { accepted_at: Date | null; revoked_at: Date | null; expires_at: Date },
  now: Date,
): InvitationState {
  if (row.accepted_at !== null) {
    return 'accepted';
  }
  if (row.revoked_at !== null) {
    return 'revoked';
  }
  if (row.expires_at.getTime() <= now.getTime()) {
    return 'expired';
  }
  return 'pending';
}

function toInvitation(row: InvitationRow, now: Date): Invitation {
  return {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    roleCode: toRole(row.role_code),
    branchId: row.branch_id,
    branchName: row.branch_name,
    state: invitationStateAt(row, now),
    invitedBy: row.invited_by,
    invitedByName: row.invited_by_name,
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

export interface UserRepository {
  listStaff(institutionId: string, userId: string): Promise<StaffMember[]>;
  findStaff(institutionId: string, userId: string, staffId: string): Promise<StaffMember | null>;
  listInvitations(institutionId: string, userId: string, now: Date): Promise<Invitation[]>;
  /**
   * What a role grants, from `reference.role_permissions`.
   *
   * Read rather than derived. That table is the authority on what a role means;
   * a copy of the mapping in application code would be a second definition, and
   * the check it feeds — no-escalation — is the one that must not drift from
   * the catalogue it is checking against.
   */
  permissionsForRole(institutionId: string, userId: string, role: RoleCode): Promise<Permission[]>;
  /** What this address already is within this institution, if anything. */
  findAccountByEmail(
    institutionId: string,
    userId: string,
    email: string,
  ): Promise<ExistingAccount | null>;
  /** Create the account and the invitation together, or neither. */
  createInvitation(
    institutionId: string,
    userId: string,
    invitation: InvitationToCreate,
    now: Date,
  ): Promise<Invitation>;
  revokeInvitation(
    institutionId: string,
    userId: string,
    invitationId: string,
    now: Date,
  ): Promise<Invitation | null>;
  /** Pre-tenant: resolve a token hash to its institution and gating timestamps. */
  findInvitationByTokenHash(tokenHash: string): Promise<InvitationIdentity | null>;
  /** Tenant-scoped: everything acceptance needs to decide and to act. */
  loadInvitation(institutionId: string, invitationId: string): Promise<InvitationSubject | null>;
  /** Set the password, activate the account, consume the invitation. One transaction. */
  acceptInvitation(
    institutionId: string,
    invitationId: string,
    passwordHash: string,
    now: Date,
  ): Promise<boolean>;
  updateStaff(
    institutionId: string,
    userId: string,
    staffId: string,
    changes: { status?: 'active' | 'suspended'; branchId?: string | null },
  ): Promise<StaffMember | null>;
}

/**
 * Staff and invitations, in the database.
 *
 * Every tenant-scoped read and write goes through `withTenantTransaction`, so
 * row-level security applies to all of it. The one exemption is
 * {@link PostgresUserRepository.findInvitationByTokenHash}, which has no tenant
 * to scope to because establishing the tenant is what the call is for — and it
 * reaches the table through `auth.find_invitation`, a SECURITY DEFINER function
 * that returns six columns and can write nothing.
 */
export class PostgresUserRepository implements UserRepository {
  public constructor(private readonly database: Database) {}

  public async listStaff(institutionId: string, userId: string): Promise<StaffMember[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<StaffRow>(`${STAFF_PROJECTION} ORDER BY u.full_name`);
      return rows.rows.map(toStaffMember);
    });
  }

  public async findStaff(
    institutionId: string,
    userId: string,
    staffId: string,
  ): Promise<StaffMember | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<StaffRow>(`${STAFF_PROJECTION} WHERE u.id = $1`, [staffId]);
      const row = rows.rows[0];
      return row === undefined ? null : toStaffMember(row);
    });
  }

  public async listInvitations(
    institutionId: string,
    userId: string,
    now: Date,
  ): Promise<Invitation[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<InvitationRow>(`${INVITATION_PROJECTION} ORDER BY v.id DESC`);
      return rows.rows.map((row) => toInvitation(row, now));
    });
  }

  public async permissionsForRole(
    institutionId: string,
    userId: string,
    role: RoleCode,
  ): Promise<Permission[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{ permission_code: string }>(
        'SELECT permission_code FROM reference.role_permissions WHERE role_code = $1',
        [role],
      );

      // An unrecognised code means the seeded catalogue has moved ahead of this
      // build. Refusing is the only safe answer: silently dropping it would
      // make the escalation check pass by ignoring the permission it could not
      // name.
      return rows.rows.map((row) => {
        if (!isPermission(row.permission_code)) {
          throw new Error(
            'reference.role_permissions names a permission this build does not know: ' +
              row.permission_code,
          );
        }
        return row.permission_code;
      });
    });
  }

  public async findAccountByEmail(
    institutionId: string,
    userId: string,
    email: string,
  ): Promise<ExistingAccount | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{ id: string; status: string; has_password: boolean }>(
        `SELECT id, status, password_hash IS NOT NULL AS has_password
           FROM users WHERE lower(email) = lower($1)`,
        [email],
      );
      const row = rows.rows[0];
      return row === undefined
        ? null
        : { userId: row.id, status: toStatus(row.status), hasPassword: row.has_password };
    });
  }

  /**
   * Create the account and the invitation in one transaction.
   *
   * Both or neither. An invitation whose account insert failed is a token that
   * resolves to nothing; an account whose invitation failed is an address
   * consumed by a user who was never asked and can never accept — and because
   * `users_email_unique` is global, that address would then be unusable in
   * every institution, not just this one.
   *
   * Re-inviting reuses the existing account rather than inserting a second. It
   * has to: the address is unique across the whole database, so a second row is
   * not merely untidy, it is impossible. The account's name, branch and role
   * are brought into line with what is being offered this time, because the new
   * invitation supersedes the old one.
   */
  public async createInvitation(
    institutionId: string,
    userId: string,
    invitation: InvitationToCreate,
    now: Date,
  ): Promise<Invitation> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE lower(email) = lower($1)',
        [invitation.email],
      );

      const accountId = existing.rows[0]?.id ?? null;

      if (accountId === null) {
        const created = await client.query<{ id: string }>(
          `INSERT INTO users (institution_id, branch_id, email, full_name, status)
           VALUES ($1, $2, $3, $4, 'invited') RETURNING id`,
          [institutionId, invitation.branchId, invitation.email, invitation.fullName],
        );
        await assignRole(client, institutionId, requireId(created), invitation.roleCode);
      } else {
        await client.query('UPDATE users SET full_name = $2, branch_id = $3 WHERE id = $1', [
          accountId,
          invitation.fullName,
          invitation.branchId,
        ]);
        // Roles are additive rows, so the superseded offer's role is removed
        // rather than left alongside the new one.
        await client.query('DELETE FROM user_roles WHERE user_id = $1', [accountId]);
        await assignRole(client, institutionId, accountId, invitation.roleCode);
      }

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO invitations
           (institution_id, branch_id, email, full_name, role_code, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [
          institutionId,
          invitation.branchId,
          invitation.email,
          invitation.fullName,
          invitation.roleCode,
          invitation.tokenHash,
          invitation.invitedBy,
          invitation.expiresAt,
        ],
      );

      const rows = await client.query<InvitationRow>(`${INVITATION_PROJECTION} WHERE v.id = $1`, [
        requireId(inserted),
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The invitation was inserted but could not be read back.');
      }
      return toInvitation(row, now);
    });
  }

  public async revokeInvitation(
    institutionId: string,
    userId: string,
    invitationId: string,
    now: Date,
  ): Promise<Invitation | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Only a live invitation can be revoked. `accepted_at IS NULL` is what
      // stops revocation reaching backwards into a membership that already
      // exists — withdrawing an offer and suspending a member of staff are
      // different operations, and the second is not reachable through this one.
      const updated = await client.query<{ id: string }>(
        `UPDATE invitations SET revoked_at = $2
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING id`,
        [invitationId, now],
      );

      if (updated.rows[0] === undefined) {
        return null;
      }

      const rows = await client.query<InvitationRow>(`${INVITATION_PROJECTION} WHERE v.id = $1`, [
        invitationId,
      ]);
      const row = rows.rows[0];
      return row === undefined ? null : toInvitation(row, now);
    });
  }

  public async findInvitationByTokenHash(tokenHash: string): Promise<InvitationIdentity | null> {
    // No tenant: identifying the institution is what this call is for.
    return this.database.withTransaction(async (client) => {
      const rows = await client.query<{
        invitation_id: string;
        institution_id: string;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
        institution_status: string;
      }>('SELECT * FROM auth.find_invitation($1)', [tokenHash]);

      const row = rows.rows[0];
      return row === undefined
        ? null
        : {
            invitationId: row.invitation_id,
            institutionId: row.institution_id,
            expiresAt: row.expires_at,
            acceptedAt: row.accepted_at,
            revokedAt: row.revoked_at,
            institutionStatus: row.institution_status,
          };
    });
  }

  public async loadInvitation(
    institutionId: string,
    invitationId: string,
  ): Promise<InvitationSubject | null> {
    // No acting user: the person accepting has no account to act as yet. The
    // tenant is set, so every policy on every table still applies.
    return this.database.withTenantTransaction({ institutionId }, async (client) => {
      const rows = await client.query<{
        id: string;
        institution_name: string;
        email: string;
        full_name: string;
        role_code: string;
        branch_id: string | null;
        branch_name: string | null;
        expires_at: Date;
        accepted_at: Date | null;
        revoked_at: Date | null;
      }>(
        `SELECT v.id, i.name AS institution_name, v.email, v.full_name, v.role_code,
                v.branch_id, b.name AS branch_name, v.expires_at, v.accepted_at, v.revoked_at
           FROM invitations v
           JOIN institutions i ON i.id = v.institution_id
           LEFT JOIN branches b ON b.id = v.branch_id
          WHERE v.id = $1`,
        [invitationId],
      );

      const row = rows.rows[0];
      return row === undefined
        ? null
        : {
            invitationId: row.id,
            institutionId,
            institutionName: row.institution_name,
            email: row.email,
            fullName: row.full_name,
            roleCode: toRole(row.role_code),
            branchId: row.branch_id,
            branchName: row.branch_name,
            expiresAt: row.expires_at,
            acceptedAt: row.accepted_at,
            revokedAt: row.revoked_at,
          };
    });
  }

  /**
   * Consume the invitation and activate the account, atomically.
   *
   * The predicate on the UPDATE is the single-use enforcement, and it is on the
   * write rather than in a preceding read deliberately: two requests presenting
   * the same token concurrently both pass a check-then-act, and only one can
   * win a conditional UPDATE. The loser matches no row and is refused.
   *
   * Expiry is in the same predicate for the same reason. A token that expires
   * between the check and the write must not be redeemable, and the only way to
   * guarantee that is to make the clock part of the condition the database
   * evaluates.
   */
  public async acceptInvitation(
    institutionId: string,
    invitationId: string,
    passwordHash: string,
    now: Date,
  ): Promise<boolean> {
    return this.database.withTenantTransaction({ institutionId }, async (client) => {
      const consumed = await client.query<{ email: string }>(
        `UPDATE invitations SET accepted_at = $2
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > $2
          RETURNING email`,
        [invitationId, now],
      );

      const row = consumed.rows[0];
      if (row === undefined) {
        return false;
      }

      // Accepting proves control of the address the invitation was sent to, so
      // the account is verified by the same act that activates it.
      await client.query(
        `UPDATE users
            SET password_hash = $2,
                status = 'active',
                email_verified_at = COALESCE(email_verified_at, $3)
          WHERE lower(email) = lower($1)`,
        [row.email, passwordHash, now],
      );

      return true;
    });
  }

  public async updateStaff(
    institutionId: string,
    userId: string,
    staffId: string,
    changes: { status?: 'active' | 'suspended'; branchId?: string | null },
  ): Promise<StaffMember | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const assignments: string[] = [];
      const parameters: unknown[] = [staffId];

      if (changes.status !== undefined) {
        parameters.push(changes.status);
        assignments.push(`status = $${String(parameters.length)}`);
      }
      if (changes.branchId !== undefined) {
        parameters.push(changes.branchId);
        assignments.push(`branch_id = $${String(parameters.length)}`);
      }

      if (assignments.length === 0) {
        return null;
      }

      // eslint-disable-next-line no-restricted-syntax -- column names are literals, never input
      const statement = `UPDATE users SET ${assignments.join(', ')} WHERE id = $1 RETURNING id`;
      const updated = await client.query<{ id: string }>(statement, parameters);

      if (updated.rows[0] === undefined) {
        return null;
      }

      const rows = await client.query<StaffRow>(`${STAFF_PROJECTION} WHERE u.id = $1`, [staffId]);
      const row = rows.rows[0];
      return row === undefined ? null : toStaffMember(row);
    });
  }
}

async function assignRole(
  client: TransactionClient,
  institutionId: string,
  userId: string,
  role: RoleCode,
): Promise<void> {
  await client.query(
    'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
    [institutionId, userId, role],
  );
}

function requireId(result: { rows: { id: string }[] }): string {
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error('An insert returned no identifier.');
  }
  return row.id;
}
