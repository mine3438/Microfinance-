import { fileURLToPath } from 'node:url';

import { type CompiledReturn } from '@mfi/contracts';
import { Money } from '@mfi/money';
import ExcelJS from 'exceljs';

import { ruleViolation } from '../../http/errors.js';
import { type CellMap, type FormSheet } from './cell-map.js';

/**
 * A filed return, written into BOT's own workbook.
 *
 * The deliverable is not a spreadsheet of this system's design: BOT publishes a
 * template, their EDI validator reads it, and what an institution uploads is
 * that file with its cells filled. So the template ships with this API
 * (`assets/`) and every export starts from an untouched copy of it.
 *
 * Three rules govern what gets written.
 *
 * 1. **Only where BOT has no formula.** Every total, subtotal and ratio on the
 *    ten sheets is computed by the template itself. Writing a figure over one
 *    would substitute this system's arithmetic for the arithmetic BOT's
 *    validator checks — and if the two ever disagreed, the institution would
 *    file the wrong one without knowing. Computed cells simply have no address
 *    in the cell map, so there is nowhere to put them.
 * 2. **Numbers as numbers.** A money figure written as text makes BOT's `SUM`
 *    return zero. The conversion from this system's exact decimals to the
 *    doubles a spreadsheet stores is the one place floating point is
 *    unavoidable, so it is checked rather than assumed: a figure that does not
 *    survive the round trip exactly refuses the export instead of rounding
 *    quietly.
 * 3. **Repair what the template cannot resolve.** BOT's template carries a link
 *    to an external workbook — `minne.xlsm`, a file on somebody's machine —
 *    that is not distributed with it. Nine of the ten sheets read their
 *    institution name, MSP code and quarter-end date through that link, cached
 *    as "TESTING MSP" / "M001" / 31-12-2021, and MSP2-05 reads total assets the
 *    same way. Those cells are written literally, and the two dropdown lists
 *    that resolve through the same link are repointed at the workbook's own
 *    "Static Information" sheet, where BOT ships identical values. See
 *    §21.4 of the architecture.
 */

/** The template, beside the code that reads it. */
const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../assets/BOT-MSP2-template.xlsx', import.meta.url),
);

/** Rows 2, 4 and 6 of every sheet: who is filing, and for when. */
export interface WorkbookIdentity {
  readonly institutionName: string;
  readonly mspCode: string;
  /** Last day of the quarter, `YYYY-MM-DD`. */
  readonly quarterEndsOn: string;
}

const IDENTITY_ROWS = { name: 2, mspCode: 4, quarterEnd: 6 } as const;

/**
 * The two dropdown lists, repointed at the sheet the template already carries.
 *
 * BOT's own definitions name `'[1]Static Information'` — the external workbook.
 * The addresses are otherwise unchanged, and the values at them are identical,
 * so this restores the dropdowns rather than altering them.
 */
const LOCAL_LIST_RANGES = [
  { name: 'Banks', ranges: ["'Static Information'!$B$3:$B$58"] },
  { name: 'Agent_Banking', ranges: ["'Static Information'!$G$3:$G$54"] },
] as const;

/**
 * Convert an exact decimal to the double a spreadsheet cell holds.
 *
 * Everything this system computes is exact; XLSX stores IEEE-754. A TZS figure
 * with two decimal places stays exact well past any balance sheet a Tier II
 * institution will file, but "well past" is not "always", and a return is not
 * the place to find the boundary. So the conversion is verified: parse the
 * double back into an exact decimal and compare. If they differ the export is
 * refused, naming the figure.
 */
function asCellNumber(amount: string, describedAs: string): number {
  const value = Number(amount);
  if (!Number.isFinite(value)) {
    throw ruleViolation(`${describedAs} is not a figure this system can put in a cell: ${amount}.`);
  }
  if (!Money.of(String(value)).equals(Money.of(amount))) {
    throw ruleViolation(
      `${describedAs} is ${amount}, which a spreadsheet cell cannot hold exactly. Filing it ` +
        'would change the figure, so the export is refused rather than rounded.',
    );
  }
  return value;
}

/**
 * Percentages take the same treatment, with their own precision.
 *
 * BOT's rate columns are plain numbers formatted without decimals; the stored
 * value keeps whatever this system computed, which is what their validator
 * reads.
 */
function asCellRate(rate: string, describedAs: string): number {
  const value = Number(rate);
  if (!Number.isFinite(value)) {
    throw ruleViolation(`${describedAs} is not a rate this system can put in a cell: ${rate}.`);
  }
  return value;
}

/** A writer bound to one sheet, which knows nothing beyond where things go. */
class SheetWriter {
  public constructor(
    private readonly sheet: ExcelJS.Worksheet,
    private readonly map: FormSheet,
  ) {}

  /** Write a value, or say nothing if BOT computes that column themselves. */
  public put(row: number, columnKey: string, value: number | string): void {
    const column = this.map.columns.get(columnKey);
    if (column === undefined) {
      return;
    }
    this.sheet.getCell(`${column}${String(row)}`).value = value;
  }

  public rowForSno(sno: number): number | undefined {
    return this.map.rowBySno.get(sno);
  }

  public identity(identity: WorkbookIdentity): void {
    const column = this.map.identityColumn;
    this.sheet.getCell(`${column}${String(IDENTITY_ROWS.name)}`).value = identity.institutionName;
    this.sheet.getCell(`${column}${String(IDENTITY_ROWS.mspCode)}`).value = identity.mspCode;
    // A date, not the text of one: BOT's cell is date-formatted and validated
    // against a minimum, and a string there fails both.
    this.sheet.getCell(`${column}${String(IDENTITY_ROWS.quarterEnd)}`).value = new Date(
      `${identity.quarterEndsOn}T00:00:00Z`,
    );
  }
}

/**
 * Fill BOT's template with a compiled return.
 *
 * Takes the document as filed — strings, exactly as the archive holds them —
 * rather than the domain objects it was made from, so what is exported is what
 * was filed and not a second compilation of the same quarter.
 */
export async function buildReturnWorkbook(
  document: CompiledReturn,
  identity: WorkbookIdentity,
  map: CellMap,
  institutionNames: ReadonlyMap<string, string>,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(TEMPLATE_PATH);

  workbook.definedNames.model = LOCAL_LIST_RANGES.map((entry) => ({
    name: entry.name,
    ranges: [...entry.ranges],
  }));
  // Every total on every sheet is a formula whose cached result belongs to
  // BOT's sample data. Recalculating on open is what makes the figures below
  // add up to the totals a reader sees.
  workbook.calcProperties.fullCalcOnLoad = true;

  const writerFor = (formCode: string): SheetWriter => {
    const sheetMap = map.sheet(formCode);
    if (sheetMap === undefined) {
      throw ruleViolation(
        `${formCode} has no cell map, so it cannot be written to BOT's template.`,
      );
    }
    const sheet = workbook.getWorksheet(sheetMap.sheetName);
    if (sheet === undefined) {
      throw ruleViolation(`The template has no sheet named ${sheetMap.sheetName}.`);
    }
    const writer = new SheetWriter(sheet, sheetMap);
    writer.identity(identity);
    return writer;
  };

  writeMsp2_01(writerFor('MSP2-01'), document);
  writeMsp2_02(writerFor('MSP2-02'), document);
  writeMsp2_03(writerFor('MSP2-03'), map.sheet('MSP2-03'), document);
  writeMsp2_04(writerFor('MSP2-04'), map.sheet('MSP2-04'), document);
  writeMsp2_05(writerFor('MSP2-05'), document);
  writeMsp2_06(writerFor('MSP2-06'), document);
  writeMsp2_07(writerFor('MSP2-07'), map.sheet('MSP2-07'), document);
  writeMsp2_08(writerFor('MSP2-08'), map.sheet('MSP2-08'), document, institutionNames);
  writeMsp2_09(writerFor('MSP2-09'), map.sheet('MSP2-09'), document);
  writeMsp2_10(writerFor('MSP2-10'), map.sheet('MSP2-10'), document);

  const written = await workbook.xlsx.writeBuffer();
  return Buffer.from(written);
}

/** MSP2-01 — the balance sheet. Entered and derived lines; totals are BOT's. */
function writeMsp2_01(writer: SheetWriter, document: CompiledReturn): void {
  for (const line of document.msp2_01.rows) {
    const row = writer.rowForSno(line.sno);
    if (row === undefined) {
      continue;
    }
    writer.put(row, 'amount', asCellNumber(line.amount, `MSP2-01 Sno${String(line.sno)}`));
  }
}

/** MSP2-02 — income and expense, for the quarter and the year to date. */
function writeMsp2_02(writer: SheetWriter, document: CompiledReturn): void {
  for (const line of document.msp2_02.rows) {
    const row = writer.rowForSno(line.sno);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-02 Sno${String(line.sno)}`;
    writer.put(row, 'quarter_amount', asCellNumber(line.quarterAmount, where));
    writer.put(row, 'year_to_date_amount', asCellNumber(line.yearToDateAmount, `${where} YTD`));
  }
}

/** MSP2-03 — sectoral classification. BOT sums the five classes themselves. */
function writeMsp2_03(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
): void {
  for (const line of document.msp2_03.rows) {
    const row = map?.rowBySector.get(line.sectorCode);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-03 ${line.sectorCode}`;
    writer.put(row, 'borrower_count', line.borrowerCount);
    writer.put(row, 'current', asCellNumber(line.outstandingByClass.current, `${where} current`));
    writer.put(row, 'esm', asCellNumber(line.outstandingByClass.esm, `${where} ESM`));
    writer.put(
      row,
      'substandard',
      asCellNumber(line.outstandingByClass.substandard, `${where} substandard`),
    );
    writer.put(
      row,
      'doubtful',
      asCellNumber(line.outstandingByClass.doubtful, `${where} doubtful`),
    );
    writer.put(row, 'loss', asCellNumber(line.outstandingByClass.loss, `${where} loss`));
    writer.put(
      row,
      'written_off_during_period',
      asCellNumber(line.writtenOffDuringPeriod, `${where} written off`),
    );
  }
}

/**
 * MSP2-04 — interest rate structure.
 *
 * The weighted-average columns are BOT's own formula, anomaly and all
 * (02-BOT-REPORTING-SPEC.md §5.1), so they are left to compute. A loan type no
 * institution lends under has no rate at all, and an empty cell is the honest
 * answer — writing zero would report a 0% product.
 */
function writeMsp2_04(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
): void {
  for (const line of document.msp2_04.rows) {
    const row = map?.rowByLoanType.get(line.botLoanType);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-04 ${line.botLoanType}`;
    writer.put(row, 'borrower_count', line.borrowerCount);
    writer.put(row, 'total_outstanding', asCellNumber(line.totalOutstanding, where));
    if (line.straightLine.lowest !== null) {
      writer.put(row, 'straight_line_lowest', asCellRate(line.straightLine.lowest, where));
    }
    if (line.straightLine.highest !== null) {
      writer.put(row, 'straight_line_highest', asCellRate(line.straightLine.highest, where));
    }
    if (line.reducingBalance.lowest !== null) {
      writer.put(row, 'reducing_balance_lowest', asCellRate(line.reducingBalance.lowest, where));
    }
    if (line.reducingBalance.highest !== null) {
      writer.put(row, 'reducing_balance_highest', asCellRate(line.reducingBalance.highest, where));
    }
  }
}

/**
 * MSP2-05 — liquid assets.
 *
 * Sno10 (Total Assets) is in the map even though BOT's template has a formula
 * there, because that formula reads the external workbook and resolves to
 * nothing. Everything below it — the 5% minimum, the excess, the ratio — is
 * computed by the template from that one cell.
 */
function writeMsp2_05(writer: SheetWriter, document: CompiledReturn): void {
  for (const line of document.msp2_05.rows) {
    const row = writer.rowForSno(line.sno);
    if (row === undefined) {
      continue;
    }
    writer.put(row, 'amount', asCellNumber(line.amount, `MSP2-05 Sno${String(line.sno)}`));
  }
}

/**
 * MSP2-06 — complaints.
 *
 * Sno5 is absent from the map because BOT's template computes the whole of that
 * row, the count and value columns included. So the roll-forward this system
 * derives from the records and the one their sheet computes from the four lines
 * above it are produced independently — and validation rule 8 is what makes
 * sure they say the same thing before anything is filed.
 *
 * The nature columns are keyed by BOT's own nature codes, so a category they
 * add would be a migration rather than a change here.
 */
function writeMsp2_06(writer: SheetWriter, document: CompiledReturn): void {
  for (const line of document.msp2_06.rows) {
    const row = writer.rowForSno(line.sno);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-06 Sno${String(line.sno)}`;
    writer.put(row, 'number', line.count);
    writer.put(row, 'value', asCellNumber(line.value, `${where} value`));
    for (const [natureCode, count] of Object.entries(line.byNature)) {
      writer.put(row, natureCode, count);
    }
  }
}

/**
 * Fill a free section, refusing rather than truncating.
 *
 * BOT allots a fixed number of blank rows per section. An institution with more
 * counterparties than rows has a real problem — one BOT has to answer — and the
 * wrong response is to file a return that is quietly short by one bank.
 */
function sectionRows(
  map: FormSheet | undefined,
  sectionKey: string,
  needed: number,
  describedAs: string,
): number[] {
  const section = map?.sections.get(sectionKey);
  if (section === undefined) {
    throw ruleViolation(`${describedAs} has no section in the cell map.`);
  }
  const available = section.lastRow - section.firstRow + 1;
  if (needed > available) {
    throw ruleViolation(
      `${describedAs} has ${String(needed)} rows to report and BOT's template allows ` +
        `${String(available)}. The return is refused rather than filed short — this needs a ` +
        'ruling from BOT, not a dropped counterparty.',
    );
  }
  return Array.from({ length: needed }, (_, index) => section.firstRow + index);
}

/** MSP2-07 — deposits and borrowings, in four sections BOT subtotals. */
function writeMsp2_07(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
): void {
  for (const section of document.msp2_07.sections) {
    const rows = sectionRows(map, section.kind, section.rows.length, `MSP2-07 ${section.kind}`);
    section.rows.forEach((line, index) => {
      const row = rows[index];
      if (row === undefined) {
        return;
      }
      const where = `MSP2-07 ${line.counterparty}`;
      writer.put(row, 'counterparty', line.counterparty);
      writer.put(row, 'deposit_tzs', asCellNumber(line.depositTzs, `${where} deposits`));
      writer.put(
        row,
        'deposit_foreign_tzs_equivalent',
        asCellNumber(line.depositForeignTzsEquivalent, `${where} foreign deposits`),
      );
      writer.put(row, 'borrowing_tzs', asCellNumber(line.borrowingTzs, `${where} borrowings`));
      writer.put(
        row,
        'borrowing_foreign_tzs_equivalent',
        asCellNumber(line.borrowingForeignTzsEquivalent, `${where} foreign borrowings`),
      );
    });
  }
}

/**
 * MSP2-08 — agent banking balances.
 *
 * The archived document names each bank by its reference code, because a code
 * is stable and a name is not. BOT's form wants the name as they publish it,
 * which is what the dropdown on that column offers.
 *
 * The compiled form carries a row for every one of the fifty-odd institutions
 * BOT lists, so that the total is provably over all of them. BOT's sheet has
 * twenty-eight rows and a dropdown, which is a form for listing the banks an
 * institution actually holds a balance with. Only those are written: a zero row
 * says nothing the total does not, and there is no cell for it to say it in.
 */
function writeMsp2_08(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
  institutionNames: ReadonlyMap<string, string>,
): void {
  const held = document.msp2_08.rows.filter((line) => !Money.of(line.balance).isZero());
  const rows = sectionRows(map, 'agent_banking', held.length, 'MSP2-08 agent banking');
  held.forEach((line, index) => {
    const row = rows[index];
    if (row === undefined) {
      return;
    }
    const name = institutionNames.get(line.institutionCode);
    if (name === undefined) {
      throw ruleViolation(
        `MSP2-08 names ${line.institutionCode}, which is not an institution BOT publishes.`,
      );
    }
    writer.put(row, 'counterparty', name);
    writer.put(row, 'balance', asCellNumber(line.balance, `MSP2-08 ${name}`));
  });
}

/** MSP2-09 — loans disbursed during the quarter, split by gender. */
function writeMsp2_09(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
): void {
  for (const line of document.msp2_09.rows) {
    const row = map?.rowBySector.get(line.sectorCode);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-09 ${line.sectorCode}`;
    writer.put(row, 'female_count', line.female.count);
    writer.put(row, 'female_amount', asCellNumber(line.female.amount, `${where} female`));
    writer.put(row, 'male_count', line.male.count);
    writer.put(row, 'male_amount', asCellNumber(line.male.amount, `${where} male`));
  }
}

/**
 * MSP2-10 — geographic distribution.
 *
 * Districts only. A region's row sums its districts and Tanzania's sums the
 * regions, all in the template, so this system writes 193 rows and BOT's
 * workbook produces the other 36.
 */
function writeMsp2_10(
  writer: SheetWriter,
  map: FormSheet | undefined,
  document: CompiledReturn,
): void {
  for (const line of document.msp2_10.districts) {
    const row = map?.rowByDistrict.get(line.districtCode);
    if (row === undefined) {
      continue;
    }
    const where = `MSP2-10 ${line.districtCode}`;
    writer.put(row, 'branch_count', line.branchCount);
    writer.put(row, 'employee_count', line.employeeCount);
    writer.put(row, 'compulsory_savings', asCellNumber(line.compulsorySavings, `${where} savings`));

    for (const [key, cell] of Object.entries(line.cells)) {
      writer.put(row, `borrowers_${key}`, cell.borrowerCount);
      writer.put(row, `loans_${key}`, cell.loanCount);
      writer.put(row, `outstanding_${key}`, asCellNumber(cell.outstanding, `${where} ${key}`));
    }
  }
}
