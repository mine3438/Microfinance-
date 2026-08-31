import { type Database } from '@mfi/db';

/**
 * The figures an institution types into its quarterly statements.
 *
 * Nothing here decides which lines may be written. The database does, through a
 * composite key that resolves only for lines BOT accepts entry on and this
 * system does not already answer — so a derived line has no row to hold a
 * second opinion about the loan book, and this layer's job is to pass a figure
 * through and let the schema refuse a bad one.
 */

export interface StatementLineInput {
  readonly sno: number;
  readonly amount: string;
}

/** One line of a statement, as BOT publishes it. */
export interface StatementFormLine {
  readonly sno: number;
  readonly label: string;
  readonly isComputed: boolean;
  readonly acceptsEntry: boolean;
}

export interface StatementRepository {
  formLines(institutionId: string, userId: string, formCode: string): Promise<StatementFormLine[]>;
  saveLines(
    institutionId: string,
    userId: string,
    formCode: string,
    year: number,
    quarter: number,
    lines: readonly StatementLineInput[],
  ): Promise<void>;
}

export class PostgresStatementRepository implements StatementRepository {
  public constructor(private readonly database: Database) {}

  public async formLines(
    institutionId: string,
    userId: string,
    formCode: string,
  ): Promise<StatementFormLine[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        sno: number;
        label: string;
        is_computed: boolean;
        accepts_statement_entry: boolean | null;
      }>(
        `SELECT sno, label, is_computed, accepts_statement_entry
           FROM reference.form_lines WHERE form_code = $1 ORDER BY sno`,
        [formCode],
      );

      return rows.rows.map((row) => ({
        sno: row.sno,
        label: row.label,
        isComputed: row.is_computed,
        acceptsEntry: row.accepts_statement_entry === true,
      }));
    });
  }

  public async saveLines(
    institutionId: string,
    userId: string,
    formCode: string,
    year: number,
    quarter: number,
    lines: readonly StatementLineInput[],
  ): Promise<void> {
    await this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // One statement per call, in one transaction. A balance sheet half
      // written is one whose totals describe neither the old figures nor the
      // new, and rule 1 would be checked against the difference.
      for (const line of lines) {
        await client.query(
          `INSERT INTO financial_statement_lines
             (institution_id, form_code, sno, year, quarter, amount, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (institution_id, form_code, sno, year, quarter)
           DO UPDATE SET amount = EXCLUDED.amount, updated_by = EXCLUDED.updated_by`,
          [institutionId, formCode, line.sno, year, quarter, line.amount, userId],
        );
      }
    });
  }
}
