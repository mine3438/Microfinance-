import { type Branch, type Client, type ClientStatus, type Gender } from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';

/** A client row joined to the names a caller needs to display it. */
interface ClientRow {
  id: string;
  client_code: string;
  branch_id: string;
  branch_name: string;
  full_name: string;
  gender: Gender;
  date_of_birth: Date;
  phone: string;
  district_code: string;
  district_name: string;
  sector_code: string;
  sector_name: string;
  status: ClientStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * One projection, used by every read.
 *
 * The joins to `branches`, `reference.districts` and `reference.sectors` are
 * here rather than at each call site so that a list and a single fetch cannot
 * return differently-shaped clients — and so that a list of fifty never becomes
 * fifty follow-up queries for district names. A repository that returns
 * fully-formed records is what makes N+1 unexpressible rather than merely
 * discouraged (§10.6).
 */
const CLIENT_PROJECTION = `
  SELECT c.id, c.client_code, c.branch_id, b.name AS branch_name,
         c.full_name, c.gender, c.date_of_birth, c.phone,
         c.district_code, d.name AS district_name,
         c.sector_code, s.name AS sector_name,
         c.status, c.created_at, c.updated_at
    FROM clients c
    JOIN branches b ON b.id = c.branch_id
    JOIN reference.districts d ON d.code = c.district_code
    JOIN reference.sectors s ON s.code = c.sector_code`;

function toClient(row: ClientRow): Client {
  return {
    id: row.id,
    clientCode: row.client_code,
    branchId: row.branch_id,
    branchName: row.branch_name,
    fullName: row.full_name,
    gender: row.gender,
    // `date_of_birth` is a DATE. The driver builds a Date at local midnight, so
    // formatting it through toISOString() in a zone behind UTC would move the
    // birthday back a day. The parts are read in local time, which is the zone
    // the driver put them in.
    dateOfBirth: formatDateOnly(row.date_of_birth),
    phone: row.phone,
    districtCode: row.district_code,
    districtName: row.district_name,
    sectorCode: row.sector_code,
    sectorName: row.sector_name,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** `YYYY-MM-DD` from a DATE, without a timezone conversion moving the day. */
function formatDateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** What a list request narrows by. */
export interface ClientListFilters {
  readonly limit: number;
  readonly cursor?: string | undefined;
  readonly status?: ClientStatus | undefined;
  /** Set by the use case, never straight from the query. */
  readonly branchId?: string | undefined;
  readonly search?: string | undefined;
}

export interface NewClient {
  readonly branchId: string;
  readonly fullName: string;
  readonly gender: Gender;
  readonly dateOfBirth: string;
  /** Already normalised to E.164 by the domain. */
  readonly phone: string;
  readonly districtCode: string;
  readonly sectorCode: string;
}

export interface ClientChanges {
  readonly fullName?: string | undefined;
  readonly phone?: string | undefined;
  readonly districtCode?: string | undefined;
  readonly sectorCode?: string | undefined;
  readonly status?: ClientStatus | undefined;
}

export interface ClientRepository {
  list(
    institutionId: string,
    userId: string,
    filters: ClientListFilters,
  ): Promise<PagedRows<Client>>;
  find(institutionId: string, userId: string, clientId: string): Promise<Client | null>;
  create(institutionId: string, userId: string, client: NewClient): Promise<Client>;
  update(
    institutionId: string,
    userId: string,
    clientId: string,
    changes: ClientChanges,
  ): Promise<Client | null>;
  /** Whether a branch exists in this institution. */
  branchExists(institutionId: string, userId: string, branchId: string): Promise<boolean>;
  listBranches(institutionId: string, userId: string): Promise<Branch[]>;
  /**
   * Which of the supplied reference codes BOT's taxonomy does not contain.
   *
   * Returns the offenders rather than a boolean so the refusal can name the
   * field. A foreign key would catch these anyway, but its error names a
   * constraint and not an input, so the caller learns only that "one of the
   * values" was wrong.
   */
  unknownReferenceCodes(codes: {
    districtCode: string;
    sectorCode: string;
  }): Promise<('districtCode' | 'sectorCode')[]>;
}

export class PostgresClientRepository implements ClientRepository {
  public constructor(private readonly database: Database) {}

  public async list(
    institutionId: string,
    userId: string,
    filters: ClientListFilters,
  ): Promise<PagedRows<Client>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Conditions are assembled as a list of parameterised fragments; no value
      // is ever interpolated. The placeholder numbers are positional and come
      // from the parameter array's own length, not from caller input.
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      if (filters.cursor !== undefined) {
        parameters.push(decodeCursor(filters.cursor));
        conditions.push(`c.id < $${String(parameters.length)}`);
      }
      if (filters.status !== undefined) {
        parameters.push(filters.status);
        conditions.push(`c.status = $${String(parameters.length)}`);
      }
      if (filters.branchId !== undefined) {
        parameters.push(filters.branchId);
        conditions.push(`c.branch_id = $${String(parameters.length)}`);
      }
      if (filters.search !== undefined) {
        // Escaped so that a caller typing `%` searches for a percent sign
        // rather than matching every row — a wildcard reaching the pattern is
        // not injection, but it does turn a search into a full scan.
        parameters.push(`%${escapeLikePattern(filters.search)}%`);
        const placeholder = `$${String(parameters.length)}`;
        conditions.push(
          `(c.full_name ILIKE ${placeholder} ESCAPE '\\' OR c.client_code ILIKE ${placeholder} ESCAPE '\\')`,
        );
      }

      // One row beyond the page, to answer "is there more" without a count.
      parameters.push(filters.limit + 1);

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
      const rows = await client.query<ClientRow>(
        `${CLIENT_PROJECTION} ${where} ORDER BY c.id DESC LIMIT $${String(parameters.length)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toClient), nextCursor: page.nextCursor };
    });
  }

  public async find(
    institutionId: string,
    userId: string,
    clientId: string,
  ): Promise<Client | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ClientRow>(`${CLIENT_PROJECTION} WHERE c.id = $1`, [
        clientId,
      ]);
      const row = rows.rows[0];
      return row === undefined ? null : toClient(row);
    });
  }

  public async create(
    institutionId: string,
    userId: string,
    newClient: NewClient,
  ): Promise<Client> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // `client_code` is absent on purpose: a BEFORE INSERT trigger allocates it
      // through `allocate_entity_code`, which takes a row lock so two
      // concurrent registrations cannot receive the same code. Supplying one
      // here would be a second allocator competing with that one.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO clients
           (institution_id, branch_id, full_name, gender, date_of_birth,
            phone, district_code, sector_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          institutionId,
          newClient.branchId,
          newClient.fullName,
          newClient.gender,
          newClient.dateOfBirth,
          newClient.phone,
          newClient.districtCode,
          newClient.sectorCode,
        ],
      );

      const id = inserted.rows[0]?.id;
      if (id === undefined) {
        throw new Error('Insert returned no client identifier.');
      }
      return this.requireById(client, id);
    });
  }

  public async update(
    institutionId: string,
    userId: string,
    clientId: string,
    changes: ClientChanges,
  ): Promise<Client | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const assignments: string[] = [];
      const parameters: unknown[] = [];

      // Column names come from this fixed map, never from the request. A caller
      // cannot name a column that is not listed here, so `institution_id` and
      // `client_code` are unreachable by construction rather than by a filter
      // someone has to remember to update.
      const columns: Record<keyof ClientChanges, string> = {
        fullName: 'full_name',
        phone: 'phone',
        districtCode: 'district_code',
        sectorCode: 'sector_code',
        status: 'status',
      };

      for (const [key, column] of Object.entries(columns) as [keyof ClientChanges, string][]) {
        const value = changes[key];
        if (value !== undefined) {
          parameters.push(value);
          assignments.push(`${column} = $${String(parameters.length)}`);
        }
      }

      if (assignments.length === 0) {
        return this.findWithin(client, clientId);
      }

      parameters.push(clientId);
      // Identifier interpolation, and the one kind this codebase permits. Every
      // fragment in `assignments` was built from the fixed `columns` map above,
      // so the text between the placeholders is a compile-time constant and no
      // caller input reaches it. The values remain parameterised.
      // eslint-disable-next-line no-restricted-syntax -- column names from a fixed map, never from input
      const statement = `UPDATE clients SET ${assignments.join(', ')} WHERE id = $${String(parameters.length)} RETURNING id`;
      const updated = await client.query<{ id: string }>(statement, parameters);

      const row = updated.rows[0];
      return row === undefined ? null : this.requireById(client, row.id);
    });
  }

  /**
   * The institution's branches.
   *
   * Closed ones are included, because a client, a loan or a complaint recorded
   * against a branch that has since closed still has to render with a name
   * rather than a bare identifier. A screen offering a branch to choose is
   * expected to filter to the active ones itself.
   */
  public async listBranches(institutionId: string, userId: string): Promise<Branch[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        id: string;
        code: string;
        name: string;
        is_head_office: boolean;
        status: 'active' | 'closed';
      }>(
        `SELECT id, code, name, is_head_office, status
           FROM branches
          ORDER BY is_head_office DESC, name`,
      );

      return rows.rows.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        isHeadOffice: row.is_head_office,
        status: row.status,
      }));
    });
  }

  public async branchExists(
    institutionId: string,
    userId: string,
    branchId: string,
  ): Promise<boolean> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query('SELECT 1 FROM branches WHERE id = $1', [branchId]);
      return rows.rowCount === 1;
    });
  }

  public async unknownReferenceCodes(codes: {
    districtCode: string;
    sectorCode: string;
  }): Promise<('districtCode' | 'sectorCode')[]> {
    // Unscoped: BOT's taxonomies belong to no institution and are granted
    // read-only to every tenant, so there is nothing to scope them by.
    return this.database.withTransaction(async (client) => {
      const found = await client.query<{ has_district: boolean; has_sector: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM reference.districts WHERE code = $1) AS has_district,
                EXISTS (SELECT 1 FROM reference.sectors   WHERE code = $2) AS has_sector`,
        [codes.districtCode, codes.sectorCode],
      );

      const row = found.rows[0];
      const offenders: ('districtCode' | 'sectorCode')[] = [];
      if (row?.has_district !== true) {
        offenders.push('districtCode');
      }
      if (row?.has_sector !== true) {
        offenders.push('sectorCode');
      }
      return offenders;
    });
  }

  private async findWithin(client: TransactionClient, clientId: string): Promise<Client | null> {
    const rows = await client.query<ClientRow>(`${CLIENT_PROJECTION} WHERE c.id = $1`, [clientId]);
    const row = rows.rows[0];
    return row === undefined ? null : toClient(row);
  }

  private async requireById(client: TransactionClient, clientId: string): Promise<Client> {
    const found = await this.findWithin(client, clientId);
    if (found === null) {
      // The row was written in this transaction, so a miss means the tenant
      // setting is not in effect for the read — R4, and a defect here rather
      // than anything the caller did.
      throw new Error(`Client ${clientId} was written but could not be read back.`);
    }
    return found;
  }
}

/** Escape the wildcards `ILIKE` treats specially, so a search is a search. */
function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
