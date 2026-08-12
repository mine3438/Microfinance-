import { type Database } from '@mfi/db';

import { notFound } from '../../http/errors.js';

/**
 * The two things an export needs that the archived document does not carry.
 *
 * A filed return records figures, not who filed it — the institution's name and
 * BOT registration code live on the tenant row, and BOT prints both at the top
 * of all ten forms. And MSP2-08 names its banks by reference code, which has to
 * become the name BOT publishes before it reaches their sheet.
 */

/** Who is filing, as BOT's header block wants it. */
export interface InstitutionIdentity {
  readonly name: string;
  /** `null` until BOT issues one. No return can be exported without it. */
  readonly mspCode: string | null;
}

export interface ExportRepository {
  identity(institutionId: string, userId: string): Promise<InstitutionIdentity>;
  institutionNames(): Promise<ReadonlyMap<string, string>>;
}

interface IdentityRow {
  name: string;
  msp_code: string | null;
}

interface NameRow {
  code: string;
  name: string;
}

export class PostgresExportRepository implements ExportRepository {
  /**
   * BOT's institution list, held for the life of the process.
   *
   * Reference data behind a migration: it cannot change while the server runs,
   * and re-reading fifty-odd rows per export would be a round trip to learn the
   * same answer.
   */
  private names: ReadonlyMap<string, string> | null = null;

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

  public async institutionNames(): Promise<ReadonlyMap<string, string>> {
    this.names ??= await this.database.withTransaction(async (client) => {
      const rows = await client.query<NameRow>(
        'SELECT code, name FROM reference.financial_institutions',
      );
      return new Map(rows.rows.map((row) => [row.code, row.name]));
    });
    return this.names;
  }
}
