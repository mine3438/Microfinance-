import { type Database } from '@mfi/db';

/**
 * Where each figure goes in BOT's own workbook.
 *
 * Read from `reference.form_sheets`, `form_columns`, `form_rows` and
 * `form_sections` — seeded by migration 0017 from the template itself. None of
 * it is arithmetic: "Sno *n* sits on row *n* + 13" happens to hold across all
 * ten sheets today, and the day BOT inserts a line it will not, so the exporter
 * never computes an address it could look up.
 *
 * The map is loaded once per process. It is reference data behind a migration,
 * so it cannot change while the server is running, and re-reading four tables
 * on every export would be four round trips to learn the same answer.
 */

/** One form's sheet, and how its rows and columns are addressed. */
export interface FormSheet {
  readonly formCode: string;
  readonly sheetName: string;
  readonly snoRowOffset: number;
  /** Column carrying the name (row 2), MSP code (row 4) and date (row 6). */
  readonly identityColumn: string;
  /** Wire-shape field name to spreadsheet column letter. */
  readonly columns: ReadonlyMap<string, string>;
  /** Sno to row, for the three forms addressed by numbered line. */
  readonly rowBySno: ReadonlyMap<number, number>;
  /** Reference code to row, for the forms addressed by taxonomy. */
  readonly rowBySector: ReadonlyMap<string, number>;
  readonly rowByLoanType: ReadonlyMap<string, number>;
  readonly rowByDistrict: ReadonlyMap<string, number>;
  /** Free ranges filled in order, for MSP2-07 and MSP2-08. */
  readonly sections: ReadonlyMap<string, FormSection>;
}

/** A block of blank rows an institution fills with whatever it holds. */
export interface FormSection {
  readonly firstRow: number;
  readonly lastRow: number;
}

export interface CellMap {
  /** `undefined` for a form the map does not cover, never a fabricated sheet. */
  sheet(formCode: string): FormSheet | undefined;
}

export interface CellMapRepository {
  load(): Promise<CellMap>;
}

interface SheetRow {
  form_code: string;
  sheet_name: string;
  sno_row_offset: number;
  identity_column: string;
}

interface ColumnRow {
  form_code: string;
  column_key: string;
  column_letter: string;
}

interface RowRow {
  form_code: string;
  row_number: number;
  sno: number | null;
  sector_code: string | null;
  loan_type_code: string | null;
  district_code: string | null;
}

interface SectionRow {
  form_code: string;
  section_key: string;
  first_row: number;
  last_row: number;
}

/** A sheet under construction, before it is frozen into a `FormSheet`. */
interface MutableSheet {
  formCode: string;
  sheetName: string;
  snoRowOffset: number;
  identityColumn: string;
  columns: Map<string, string>;
  rowBySno: Map<number, number>;
  rowBySector: Map<string, number>;
  rowByLoanType: Map<string, number>;
  rowByDistrict: Map<string, number>;
  sections: Map<string, FormSection>;
}

const SHEETS_SELECT = `SELECT form_code, sheet_name, sno_row_offset, identity_column
     FROM reference.form_sheets`;

const COLUMNS_SELECT = `SELECT form_code, column_key, column_letter
     FROM reference.form_columns`;

const ROWS_SELECT = `SELECT form_code, row_number, sno, sector_code, loan_type_code, district_code
     FROM reference.form_rows`;

const SECTIONS_SELECT = `SELECT form_code, section_key, first_row, last_row
     FROM reference.form_sections`;

export class PostgresCellMapRepository implements CellMapRepository {
  private cached: CellMap | null = null;

  public constructor(private readonly database: Database) {}

  public async load(): Promise<CellMap> {
    this.cached ??= await this.read();
    return this.cached;
  }

  private async read(): Promise<CellMap> {
    // Reference data, identical for every tenant, so this is the one read in
    // the reporting path that is not tenant-scoped. No institution's figures
    // pass through it.
    const [sheets, columns, rows, sections] = await this.database.withTransaction(async (client) =>
      Promise.all([
        client.query<SheetRow>(SHEETS_SELECT),
        client.query<ColumnRow>(COLUMNS_SELECT),
        client.query<RowRow>(ROWS_SELECT),
        client.query<SectionRow>(SECTIONS_SELECT),
      ]),
    );

    const byForm = new Map<string, MutableSheet>();
    for (const row of sheets.rows) {
      byForm.set(row.form_code, {
        formCode: row.form_code,
        sheetName: row.sheet_name,
        snoRowOffset: row.sno_row_offset,
        identityColumn: row.identity_column,
        columns: new Map(),
        rowBySno: new Map(),
        rowBySector: new Map(),
        rowByLoanType: new Map(),
        rowByDistrict: new Map(),
        sections: new Map(),
      });
    }

    for (const row of columns.rows) {
      byForm.get(row.form_code)?.columns.set(row.column_key, row.column_letter);
    }

    for (const row of rows.rows) {
      const sheet = byForm.get(row.form_code);
      if (sheet === undefined) {
        continue;
      }
      // Exactly one of these is set; the database's own check constraint is
      // what makes that true, so no branch here needs to handle two at once.
      if (row.sno !== null) {
        sheet.rowBySno.set(row.sno, row.row_number);
      } else if (row.sector_code !== null) {
        sheet.rowBySector.set(row.sector_code, row.row_number);
      } else if (row.loan_type_code !== null) {
        sheet.rowByLoanType.set(row.loan_type_code, row.row_number);
      } else if (row.district_code !== null) {
        sheet.rowByDistrict.set(row.district_code, row.row_number);
      }
    }

    for (const row of sections.rows) {
      byForm
        .get(row.form_code)
        ?.sections.set(row.section_key, { firstRow: row.first_row, lastRow: row.last_row });
    }

    return { sheet: (formCode: string): FormSheet | undefined => byForm.get(formCode) };
  }
}
