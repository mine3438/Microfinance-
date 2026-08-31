import {
  type Complaint,
  type ComplaintListQuery,
  type ComplaintNature,
  type LogComplaintRequest,
  type ReferComplaintRequest,
  type ReferralDestination,
  type ResolutionRoute,
  type ResolveComplaintRequest,
} from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';
import { conflict, notFound } from '../../http/errors.js';

/**
 * Complaint persistence.
 *
 * Nothing here decides what belongs on MSP2-06. The form is derived from these
 * rows by date at compile time, so this layer's job is to keep the dates and
 * the two BOT vocabularies honest and let the schema refuse the rest — a nature
 * BOT does not publish, a resolution with no route, a referral with no date.
 */

interface ComplaintRow {
  id: string;
  complaint_code: string;
  complainant_name: string;
  client_id: string | null;
  client_name: string | null;
  branch_id: string;
  branch_name: string;
  nature_code: string;
  nature_name: string;
  summary: string;
  amount: string;
  received_on: Date;
  resolved_on: Date | null;
  resolved_by: ResolutionRoute | null;
  resolution_note: string | null;
  referred_to: ReferralDestination | null;
  referred_on: Date | null;
  recorded_by: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * A complete projection, written out rather than composed.
 *
 * Same reason as the finance repository: the lint rule that bans interpolated
 * SQL cannot tell a constant from a caller's input, and the right response is
 * to give it nothing to flag. Every parameter below travels as `$1`.
 */
const COMPLAINT_SELECT = `SELECT c.id, c.complaint_code, c.complainant_name, c.client_id,
              cl.full_name AS client_name, c.branch_id, b.name AS branch_name,
              c.nature_code, n.name AS nature_name, c.summary, c.amount,
              c.received_on, c.resolved_on, c.resolved_by, c.resolution_note,
              c.referred_to, c.referred_on, c.recorded_by, c.created_at, c.updated_at
         FROM complaints c
         JOIN branches b ON b.id = c.branch_id
         JOIN reference.complaint_natures n ON n.code = c.nature_code
         LEFT JOIN clients cl ON cl.id = c.client_id`;

export interface ComplaintRepository {
  natures(institutionId: string, userId: string): Promise<ComplaintNature[]>;
  list(
    institutionId: string,
    userId: string,
    filters: ComplaintListQuery,
  ): Promise<PagedRows<Complaint>>;
  find(institutionId: string, userId: string, id: string): Promise<Complaint | null>;
  log(institutionId: string, userId: string, request: LogComplaintRequest): Promise<Complaint>;
  resolve(
    institutionId: string,
    userId: string,
    id: string,
    request: ResolveComplaintRequest,
  ): Promise<Complaint>;
  refer(
    institutionId: string,
    userId: string,
    id: string,
    request: ReferComplaintRequest,
  ): Promise<Complaint>;
}

export class PostgresComplaintRepository implements ComplaintRepository {
  public constructor(private readonly database: Database) {}

  public async natures(institutionId: string, userId: string): Promise<ComplaintNature[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ComplaintNature>(
        'SELECT code, sno, name FROM reference.complaint_natures ORDER BY sno',
      );
      return rows.rows;
    });
  }

  public async list(
    institutionId: string,
    userId: string,
    filters: ComplaintListQuery,
  ): Promise<PagedRows<Complaint>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      const bind = (value: unknown): string => {
        parameters.push(value);
        return `$${String(parameters.length)}`;
      };

      if (filters.state === 'open') {
        conditions.push('c.resolved_on IS NULL');
      }
      if (filters.state === 'resolved') {
        conditions.push('c.resolved_on IS NOT NULL');
      }
      if (filters.natureCode !== undefined) {
        conditions.push(`c.nature_code = ${bind(filters.natureCode)}`);
      }
      if (filters.branchId !== undefined) {
        conditions.push(`c.branch_id = ${bind(filters.branchId)}`);
      }
      if (filters.cursor !== undefined) {
        conditions.push(`c.id < ${bind(decodeCursor(filters.cursor))}`);
      }

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

      const rows = await client.query<ComplaintRow>(
        `${COMPLAINT_SELECT} ${where} ORDER BY c.id DESC LIMIT ${bind(filters.limit + 1)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toComplaint), nextCursor: page.nextCursor };
    });
  }

  public async find(institutionId: string, userId: string, id: string): Promise<Complaint | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ComplaintRow>(`${COMPLAINT_SELECT} WHERE c.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toComplaint(row);
    });
  }

  public async log(
    institutionId: string,
    userId: string,
    request: LogComplaintRequest,
  ): Promise<Complaint> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Allocated inside the transaction, and through the function that takes a
      // row lock, so two complaints logged at the same moment cannot take the
      // same code.
      const code = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'complaint', 'CMP',
                extract(year FROM $2::date)::integer) AS code`,
        [institutionId, request.receivedOn],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO complaints
           (institution_id, branch_id, complaint_code, client_id, complainant_name,
            nature_code, summary, amount, received_on, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING id`,
        [
          institutionId,
          request.branchId,
          code.rows[0]?.code ?? '',
          request.clientId ?? null,
          request.complainantName,
          request.natureCode,
          request.summary,
          request.amount ?? '0.00',
          request.receivedOn,
          userId,
        ],
      );

      return this.readBack(client, inserted.rows[0]?.id ?? '');
    });
  }

  public async resolve(
    institutionId: string,
    userId: string,
    id: string,
    request: ResolveComplaintRequest,
  ): Promise<Complaint> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // `resolved_on IS NULL` in the predicate rather than a read-then-write:
      // two operators resolving the same complaint at once would otherwise both
      // succeed, and the second would overwrite the first's route and note.
      const updated = await client.query(
        `UPDATE complaints
            SET resolved_on = $2, resolved_by = $3, resolution_note = $4
          WHERE id = $1 AND resolved_on IS NULL`,
        [id, request.resolvedOn, request.resolvedBy, request.resolutionNote],
      );

      if (updated.rowCount === 0) {
        await this.refuseMissingOr(
          client,
          id,
          'That complaint has already been resolved. Resolving it again would move it between ' +
            'quarters on MSP2-06.',
        );
      }

      return this.readBack(client, id);
    });
  }

  public async refer(
    institutionId: string,
    userId: string,
    id: string,
    request: ReferComplaintRequest,
  ): Promise<Complaint> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Only an open complaint can be referred: BOT's lines 6 to 9 count
      // *unresolved* complaints referred somewhere, so a referral recorded
      // against a closed one would be counted nowhere and read as a mistake.
      const updated = await client.query(
        `UPDATE complaints
            SET referred_to = $2, referred_on = $3
          WHERE id = $1 AND resolved_on IS NULL`,
        [id, request.referredTo, request.referredOn],
      );

      if (updated.rowCount === 0) {
        await this.refuseMissingOr(
          client,
          id,
          'That complaint has been resolved, so it cannot be referred. MSP2-06 counts referrals ' +
            'of unresolved complaints only.',
        );
      }

      return this.readBack(client, id);
    });
  }

  /**
   * Tell "no such complaint" apart from "the complaint refused the change".
   *
   * A zero row count means one or the other, and answering 409 to a caller who
   * asked about something that does not exist leaks that it does not.
   */
  private async refuseMissingOr(
    client: TransactionClient,
    id: string,
    message: string,
  ): Promise<never> {
    const existing = await client.query<{ id: string }>('SELECT id FROM complaints WHERE id = $1', [
      id,
    ]);
    if (existing.rows.length === 0) {
      throw notFound('That complaint does not exist.');
    }
    throw conflict(message);
  }

  private async readBack(client: TransactionClient, id: string): Promise<Complaint> {
    const rows = await client.query<ComplaintRow>(`${COMPLAINT_SELECT} WHERE c.id = $1`, [id]);
    const row = rows.rows[0];
    if (row === undefined) {
      throw notFound('That complaint does not exist.');
    }
    return toComplaint(row);
  }
}

function dateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toComplaint(row: ComplaintRow): Complaint {
  return {
    id: row.id,
    complaintCode: row.complaint_code,
    complainantName: row.complainant_name,
    clientId: row.client_id,
    clientName: row.client_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    natureCode: row.nature_code,
    natureName: row.nature_name,
    summary: row.summary,
    amount: row.amount,
    receivedOn: dateOnly(row.received_on),
    resolvedOn: row.resolved_on === null ? null : dateOnly(row.resolved_on),
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    referredTo: row.referred_to,
    referredOn: row.referred_on === null ? null : dateOnly(row.referred_on),
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}
