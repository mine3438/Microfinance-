import { type Group, type GroupMember, type GroupStatus } from '@mfi/contracts';
import { type Database } from '@mfi/db';

/**
 * Lending groups, and membership over time.
 *
 * Membership is held as intervals rather than a roster. The approved rules
 * require that historical loan records stay interpretable when membership
 * changes, and "who was jointly liable when this was advanced" is a question a
 * roster cannot answer once somebody leaves.
 *
 * Nothing here reaches `loans`. Lending to a group waits on GROUP-05 — the
 * unresolved question of how a group loan is reported on MSP2-03, 09 and 10,
 * whose exposure queries all reach borrower attributes through
 * `loans.client_id`.
 */

export interface GroupToCreate {
  readonly code: string;
  readonly name: string;
  readonly branchId: string;
  readonly formedOn: string;
}

export interface GroupChanges {
  readonly name?: string | undefined;
  readonly status?: GroupStatus | undefined;
}

interface GroupRow {
  id: string;
  code: string;
  name: string;
  branch_id: string;
  branch_name: string | null;
  formed_on: Date;
  status: string;
  current_member_count: string;
  created_at: Date;
}

interface MemberRow {
  id: string;
  group_id: string;
  client_id: string;
  client_name: string;
  client_code: string | null;
  joined_on: Date;
  left_on: Date | null;
}

const GROUP_PROJECTION = `
  SELECT g.id, g.code, g.name, g.branch_id, b.name AS branch_name,
         g.formed_on, g.status, g.created_at,
         (SELECT count(*) FROM group_members m
           WHERE m.group_id = g.id AND m.left_on IS NULL)::text AS current_member_count
    FROM groups g
    LEFT JOIN branches b ON b.id = g.branch_id`;

const MEMBER_PROJECTION = `
  SELECT m.id, m.group_id, m.client_id, c.full_name AS client_name, c.client_code,
         m.joined_on, m.left_on
    FROM group_members m
    JOIN clients c ON c.id = m.client_id`;

function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toStatus(value: string): GroupStatus {
  if (value !== 'active' && value !== 'closed') {
    throw new Error(`A group row carries an unrecognised status: ${value}`);
  }
  return value;
}

function toGroup(row: GroupRow): Group {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    formedOn: formatDateOnly(row.formed_on),
    status: toStatus(row.status),
    currentMemberCount: Number(row.current_member_count),
    createdAt: row.created_at.toISOString(),
  };
}

function toMember(row: MemberRow): GroupMember {
  return {
    id: row.id,
    groupId: row.group_id,
    clientId: row.client_id,
    clientName: row.client_name,
    clientCode: row.client_code,
    joinedOn: formatDateOnly(row.joined_on),
    leftOn: row.left_on === null ? null : formatDateOnly(row.left_on),
  };
}

export interface GroupRepository {
  list(institutionId: string, userId: string, branchId: string | null): Promise<Group[]>;
  find(institutionId: string, userId: string, groupId: string): Promise<Group | null>;
  create(institutionId: string, userId: string, group: GroupToCreate): Promise<Group>;
  update(
    institutionId: string,
    userId: string,
    groupId: string,
    changes: GroupChanges,
  ): Promise<Group | null>;
  /** Whether a client exists in this institution, for membership. */
  clientExists(institutionId: string, userId: string, clientId: string): Promise<boolean>;
  /**
   * Membership, either as it stands now or as it stood on a date.
   *
   * `asAt` is what makes an old loan legible: it returns the intervals that
   * were open on that day, not the ones open today.
   */
  members(
    institutionId: string,
    userId: string,
    groupId: string,
    asAt: string | null,
  ): Promise<GroupMember[]>;
  /**
   * The groups one borrower belongs to, now or on a date.
   *
   * The reverse of {@link GroupRepository.members}, and the query that
   * `group_members_institution_client_idx` was created to serve. Until this
   * existed, that index answered no question the application ever asked.
   */
  groupsForClient(
    institutionId: string,
    userId: string,
    clientId: string,
    asAt: string | null,
  ): Promise<GroupMember[]>;
  addMember(
    institutionId: string,
    userId: string,
    groupId: string,
    clientId: string,
    joinedOn: string,
  ): Promise<GroupMember | null>;
  endMembership(
    institutionId: string,
    userId: string,
    groupId: string,
    clientId: string,
    leftOn: string,
  ): Promise<GroupMember | null>;
}

export class PostgresGroupRepository implements GroupRepository {
  public constructor(private readonly database: Database) {}

  public async list(
    institutionId: string,
    userId: string,
    branchId: string | null,
  ): Promise<Group[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows =
        branchId === null
          ? await client.query<GroupRow>(`${GROUP_PROJECTION} ORDER BY g.name`)
          : await client.query<GroupRow>(
              `${GROUP_PROJECTION} WHERE g.branch_id = $1 ORDER BY g.name`,
              [branchId],
            );
      return rows.rows.map(toGroup);
    });
  }

  public async find(institutionId: string, userId: string, groupId: string): Promise<Group | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<GroupRow>(`${GROUP_PROJECTION} WHERE g.id = $1`, [groupId]);
      const row = rows.rows[0];
      return row === undefined ? null : toGroup(row);
    });
  }

  public async create(institutionId: string, userId: string, group: GroupToCreate): Promise<Group> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO groups (institution_id, branch_id, code, name, formed_on)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [institutionId, group.branchId, group.code, group.name, group.formedOn],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('The group was inserted but returned no identifier.');
      }

      const rows = await client.query<GroupRow>(`${GROUP_PROJECTION} WHERE g.id = $1`, [id]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw new Error('The group was created but could not be read back.');
      }
      return toGroup(row);
    });
  }

  public async update(
    institutionId: string,
    userId: string,
    groupId: string,
    changes: GroupChanges,
  ): Promise<Group | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const assignments: string[] = [];
      const parameters: unknown[] = [groupId];

      if (changes.name !== undefined) {
        parameters.push(changes.name);
        assignments.push(`name = $${String(parameters.length)}`);
      }
      if (changes.status !== undefined) {
        parameters.push(changes.status);
        assignments.push(`status = $${String(parameters.length)}`);
      }

      if (assignments.length === 0) {
        return null;
      }

      // eslint-disable-next-line no-restricted-syntax -- column names are literals, never input
      const statement = `UPDATE groups SET ${assignments.join(', ')} WHERE id = $1 RETURNING id`;
      const updated = await client.query<{ id: string }>(statement, parameters);

      if (updated.rows[0] === undefined) {
        return null;
      }

      const rows = await client.query<GroupRow>(`${GROUP_PROJECTION} WHERE g.id = $1`, [groupId]);
      const row = rows.rows[0];
      return row === undefined ? null : toGroup(row);
    });
  }

  public async clientExists(
    institutionId: string,
    userId: string,
    clientId: string,
  ): Promise<boolean> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{ id: string }>('SELECT id FROM clients WHERE id = $1', [
        clientId,
      ]);
      return rows.rows[0] !== undefined;
    });
  }

  public async members(
    institutionId: string,
    userId: string,
    groupId: string,
    asAt: string | null,
  ): Promise<GroupMember[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // An interval was open on a date when it began on or before it and had
      // not yet ended. Half-open at the end: somebody who left on the 5th was
      // still a member on the 5th.
      const rows =
        asAt === null
          ? await client.query<MemberRow>(
              `${MEMBER_PROJECTION} WHERE m.group_id = $1 AND m.left_on IS NULL
                ORDER BY c.full_name`,
              [groupId],
            )
          : await client.query<MemberRow>(
              `${MEMBER_PROJECTION}
                WHERE m.group_id = $1
                  AND m.joined_on <= $2
                  AND (m.left_on IS NULL OR m.left_on >= $2)
                ORDER BY c.full_name`,
              [groupId, asAt],
            );
      return rows.rows.map(toMember);
    });
  }

  public async groupsForClient(
    institutionId: string,
    userId: string,
    clientId: string,
    asAt: string | null,
  ): Promise<GroupMember[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows =
        asAt === null
          ? await client.query<MemberRow>(
              MEMBER_PROJECTION +
                ' WHERE m.client_id = $1 AND m.left_on IS NULL ORDER BY m.joined_on',
              [clientId],
            )
          : await client.query<MemberRow>(
              MEMBER_PROJECTION +
                ' WHERE m.client_id = $1 AND m.joined_on <= $2' +
                ' AND (m.left_on IS NULL OR m.left_on >= $2) ORDER BY m.joined_on',
              [clientId, asAt],
            );
      return rows.rows.map(toMember);
    });
  }

  public async addMember(
    institutionId: string,
    userId: string,
    groupId: string,
    clientId: string,
    joinedOn: string,
  ): Promise<GroupMember | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO group_members (institution_id, group_id, client_id, joined_on)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [institutionId, groupId, clientId, joinedOn],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        return null;
      }

      const rows = await client.query<MemberRow>(`${MEMBER_PROJECTION} WHERE m.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toMember(row);
    });
  }

  /**
   * Close the open interval.
   *
   * `left_on IS NULL` on the write is the guard: a member who has already left
   * matches nothing, so a repeated departure changes no dates rather than
   * rewriting the one on record.
   */
  public async endMembership(
    institutionId: string,
    userId: string,
    groupId: string,
    clientId: string,
    leftOn: string,
  ): Promise<GroupMember | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<{ id: string }>(
        `UPDATE group_members SET left_on = $3
          WHERE group_id = $1 AND client_id = $2 AND left_on IS NULL
          RETURNING id`,
        [groupId, clientId, leftOn],
      );

      const id = updated.rows[0]?.id;
      if (id === undefined) {
        return null;
      }

      const rows = await client.query<MemberRow>(`${MEMBER_PROJECTION} WHERE m.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toMember(row);
    });
  }
}
