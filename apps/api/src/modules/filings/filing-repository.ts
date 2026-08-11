import { type CompiledReturn, type FiledReturn, type FiledReturnDetail } from '@mfi/contracts';
import { type Database } from '@mfi/db';

import { notFound } from '../../http/errors.js';

/** A filing, and the document it recorded. */
interface FilingRow {
  id: string;
  year: number;
  quarter: number;
  form_codes: string[];
  finding_count: number;
  filed_by: string;
  filed_by_name: string;
  filed_at: Date;
  submission_reference: string | null;
}

/** The same row with the document, which only the detail queries select. */
interface FilingDetailRow extends FilingRow {
  document: CompiledReturn;
}

const FILING_SELECT = `SELECT f.id, f.year, f.quarter, f.form_codes, f.finding_count,
              f.filed_by, u.full_name AS filed_by_name, f.filed_at, f.submission_reference
         FROM filed_returns f
         JOIN users u ON u.id = f.filed_by`;

const FILING_DETAIL_SELECT = `SELECT f.id, f.year, f.quarter, f.form_codes, f.finding_count,
              f.filed_by, u.full_name AS filed_by_name, f.filed_at, f.submission_reference,
              f.document
         FROM filed_returns f
         JOIN users u ON u.id = f.filed_by`;

export interface FilingToArchive {
  readonly year: number;
  readonly quarter: number;
  readonly document: CompiledReturn;
  readonly formCodes: readonly string[];
  readonly findingCount: number;
}

export interface FilingRepository {
  list(institutionId: string, userId: string): Promise<FiledReturn[]>;
  find(institutionId: string, userId: string, id: string): Promise<FiledReturnDetail | null>;
  archive(
    institutionId: string,
    userId: string,
    filing: FilingToArchive,
  ): Promise<FiledReturnDetail>;
  recordSubmissionReference(
    institutionId: string,
    userId: string,
    id: string,
    reference: string,
  ): Promise<FiledReturn>;
}

export class PostgresFilingRepository implements FilingRepository {
  public constructor(private readonly database: Database) {}

  public async list(institutionId: string, userId: string): Promise<FiledReturn[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<FilingRow>(`${FILING_SELECT} ORDER BY f.filed_at DESC`);
      return rows.rows.map(toFiling);
    });
  }

  public async find(
    institutionId: string,
    userId: string,
    id: string,
  ): Promise<FiledReturnDetail | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<FilingDetailRow>(`${FILING_DETAIL_SELECT} WHERE f.id = $1`, [
        id,
      ]);
      const row = rows.rows[0];
      return row === undefined ? null : toDetail(row);
    });
  }

  public async archive(
    institutionId: string,
    userId: string,
    filing: FilingToArchive,
  ): Promise<FiledReturnDetail> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO filed_returns
           (institution_id, year, quarter, document, form_codes, finding_count, filed_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          institutionId,
          filing.year,
          filing.quarter,
          // Serialised here rather than by the driver's object mapping, so what
          // is stored is exactly the bytes the API served.
          JSON.stringify(filing.document),
          filing.formCodes,
          filing.findingCount,
          userId,
        ],
      );

      const rows = await client.query<FilingDetailRow>(`${FILING_DETAIL_SELECT} WHERE f.id = $1`, [
        inserted.rows[0]?.id ?? '',
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw notFound('The filing could not be read back after being recorded.');
      }
      return toDetail(row);
    });
  }

  public async recordSubmissionReference(
    institutionId: string,
    userId: string,
    id: string,
    reference: string,
  ): Promise<FiledReturn> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query(
        'UPDATE filed_returns SET submission_reference = $2 WHERE id = $1',
        [id, reference],
      );

      if (updated.rowCount === 0) {
        throw notFound('That filing does not exist.');
      }

      const rows = await client.query<FilingRow>(`${FILING_SELECT} WHERE f.id = $1`, [id]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw notFound('That filing does not exist.');
      }
      return toFiling(row);
    });
  }
}

function toFiling(row: FilingRow): FiledReturn {
  return {
    id: row.id,
    year: row.year,
    quarter: row.quarter,
    formCodes: row.form_codes,
    findingCount: row.finding_count,
    filedBy: row.filed_by,
    filedByName: row.filed_by_name,
    filedAt: row.filed_at.toISOString(),
    submissionReference: row.submission_reference,
  };
}

function toDetail(row: FilingDetailRow): FiledReturnDetail {
  return {
    ...toFiling(row),
    // `jsonb` comes back parsed. Stored as the wire shape and served as the
    // wire shape, so the document a caller reads is the one that was filed
    // rather than a rendering of it. The route re-parses it against the
    // response schema, which is where a document written by an older version
    // of this system would be caught rather than served as if current.
    document: row.document,
  };
}
