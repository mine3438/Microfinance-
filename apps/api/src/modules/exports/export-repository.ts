import { type Database } from '@mfi/db';

import { notFound } from '../../http/errors.js';

/**
 * The things an export needs that the archived document does not carry.
 *
 * A filed return records figures against codes, which is what makes it stable:
 * `tz_arusha__karatu` means the same district in ten years' time and "Karatu"
 * might not. Rendering it for a person, or for BOT's own sheet, needs the names
 * back — and the institution's own name and registration code, which live on
 * the tenant row rather than in the document.
 */

/** Who is filing, as BOT's header block wants it. */
export interface InstitutionIdentity {
  readonly name: string;
  /** `null` until BOT issues one. No return can be exported without it. */
  readonly mspCode: string | null;
}

/** BOT's published vocabularies, by code. */
export interface ReferenceLabels {
  readonly institutions: ReadonlyMap<string, string>;
  readonly sectors: ReadonlyMap<string, string>;
  readonly loanTypes: ReadonlyMap<string, string>;
  readonly districts: ReadonlyMap<string, string>;
  readonly regions: ReadonlyMap<string, string>;
}

export interface ExportRepository {
  identity(institutionId: string, userId: string): Promise<InstitutionIdentity>;
  labels(): Promise<ReferenceLabels>;
}

interface IdentityRow {
  name: string;
  msp_code: string | null;
}

interface NameRow {
  code: string;
  name: string;
}

const INSTITUTIONS_SELECT = 'SELECT code, name FROM reference.financial_institutions';
const SECTORS_SELECT = 'SELECT code, name FROM reference.sectors';
const LOAN_TYPES_SELECT = 'SELECT code, name FROM reference.loan_types';
const DISTRICTS_SELECT = 'SELECT code, name FROM reference.districts';
const REGIONS_SELECT = 'SELECT code, name FROM reference.regions';

export class PostgresExportRepository implements ExportRepository {
  /**
   * BOT's vocabularies, held for the life of the process.
   *
   * Reference data behind a migration: it cannot change while the server runs,
   * and re-reading four hundred rows per export would be four round trips to
   * learn the same answer.
   */
  private cached: ReferenceLabels | null = null;

  public constructor(private readonly database: Database) {}

  public async identity(institutionId: string, userId: string): Promise<InstitutionIdentity> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<IdentityRow>(
        'SELECT name, msp_code FROM institutions WHERE id = $1',
        [institutionId],
      );
      const row = rows.rows[0];
      if (row === undefined) {
        throw notFound('That institution does not exist.');
      }
      return { name: row.name, mspCode: row.msp_code };
    });
  }

  public async labels(): Promise<ReferenceLabels> {
    // Reference data, identical for every tenant, so this is the one read in
    // the export path that is not tenant-scoped. No institution's figures pass
    // through it.
    this.cached ??= await this.database.withTransaction(async (client) => {
      const [institutions, sectors, loanTypes, districts, regions] = await Promise.all([
        client.query<NameRow>(INSTITUTIONS_SELECT),
        client.query<NameRow>(SECTORS_SELECT),
        client.query<NameRow>(LOAN_TYPES_SELECT),
        client.query<NameRow>(DISTRICTS_SELECT),
        client.query<NameRow>(REGIONS_SELECT),
      ]);

      const byCode = (rows: { rows: NameRow[] }): ReadonlyMap<string, string> =>
        new Map(rows.rows.map((row) => [row.code, row.name]));

      return {
        institutions: byCode(institutions),
        sectors: byCode(sectors),
        loanTypes: byCode(loanTypes),
        districts: byCode(districts),
        regions: byCode(regions),
      };
    });
    return this.cached;
  }
}
