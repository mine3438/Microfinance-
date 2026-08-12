import { type CompiledReturn, type ValidationFinding } from '@mfi/contracts';
import PDFDocument from 'pdfkit';

import { type ReferenceLabels } from './export-repository.js';

/**
 * A filed return, rendered for a person.
 *
 * The workbook is what BOT receives; this is what a board sees, what an auditor
 * is handed, and what gets signed before anything is uploaded. So it is not a
 * second attempt at BOT's layout — it is the same figures set out to be read,
 * with the things a reader needs and a spreadsheet cell cannot hold: who filed
 * it, when, against which acknowledgement, and every validation finding that
 * stood at the moment of filing.
 *
 * Two properties it shares with the workbook. It is built from the **archived
 * document**, so it says what was filed rather than what this quarter would
 * compile to now. And **no figure is recomputed**: every amount is the string
 * the archive holds, printed as it stands. A renderer that re-totalled a column
 * could disagree with the return, and the return is the record.
 *
 * Codes become names here — `tz_arusha__karatu` is stable and "Karatu" is
 * legible — which is the one thing this file needs the reference data for.
 */

/** Everything on the cover that is not in the document itself. */
export interface PdfCover {
  readonly institutionName: string;
  readonly mspCode: string;
  readonly filedAt: string;
  readonly filedByName: string;
  readonly submissionReference: string | null;
}

/** A4 landscape, in points, matching pdfkit's own units. */
const PAGE = { width: 841.89, height: 595.28 } as const;
const MARGIN = 36;
const CONTENT_WIDTH = PAGE.width - MARGIN * 2;
const BOTTOM = PAGE.height - MARGIN;

const FONT = 'Helvetica';
const FONT_BOLD = 'Helvetica-Bold';

const ROW_HEIGHT = 13;
const BODY_SIZE = 8;
const HEADING_SIZE = 8;

/** One column of a table. Widths are points and are not negotiated. */
interface Column {
  readonly heading: string;
  readonly width: number;
  readonly align?: 'left' | 'right';
}

/** A row is one string per column, already formatted. Nothing is computed. */
type Row = readonly string[];

/**
 * A table that paginates and repeats its headings.
 *
 * Deliberately small: it draws text at computed offsets and rules a line under
 * the heading. Anything more — wrapping, spanning, borders — would be a layout
 * engine, and what this document needs is legibility, not typesetting.
 */
class Sheet {
  private y = MARGIN;

  public constructor(private readonly doc: PDFKit.PDFDocument) {}

  private space(needed: number): void {
    if (this.y + needed <= BOTTOM) {
      return;
    }
    this.doc.addPage({ size: [PAGE.width, PAGE.height], margin: MARGIN });
    this.y = MARGIN;
  }

  public title(text: string, size = 13): void {
    this.space(size + 10);
    this.doc.font(FONT_BOLD).fontSize(size).text(text, MARGIN, this.y, { width: CONTENT_WIDTH });
    this.y += size + 8;
  }

  public paragraph(text: string, size = 9): void {
    const height = this.doc
      .font(FONT)
      .fontSize(size)
      .heightOfString(text, { width: CONTENT_WIDTH });
    this.space(height + 4);
    this.doc.text(text, MARGIN, this.y, { width: CONTENT_WIDTH });
    this.y += height + 4;
  }

  public gap(points = 10): void {
    this.y += points;
  }

  /** Draw a table. Returns nothing: the sheet keeps its own cursor. */
  public table(columns: readonly Column[], rows: readonly Row[], boldLast = false): void {
    this.headings(columns);
    rows.forEach((row, index) => {
      if (this.y + ROW_HEIGHT > BOTTOM) {
        this.doc.addPage({ size: [PAGE.width, PAGE.height], margin: MARGIN });
        this.y = MARGIN;
        this.headings(columns);
      }
      const bold = boldLast && index === rows.length - 1;
      this.doc.font(bold ? FONT_BOLD : FONT).fontSize(BODY_SIZE);
      this.cells(columns, row);
      this.y += ROW_HEIGHT;
    });
    this.y += 6;
  }

  private headings(columns: readonly Column[]): void {
    this.space(ROW_HEIGHT * 2);
    this.doc.font(FONT_BOLD).fontSize(HEADING_SIZE);
    this.cells(
      columns,
      columns.map((column) => column.heading),
    );
    this.y += ROW_HEIGHT - 3;
    this.doc
      .moveTo(MARGIN, this.y)
      .lineTo(MARGIN + CONTENT_WIDTH, this.y)
      .lineWidth(0.5)
      .stroke();
    this.y += 3;
  }

  private cells(columns: readonly Column[], values: Row): void {
    let x = MARGIN;
    columns.forEach((column, index) => {
      this.doc.text(values[index] ?? '', x, this.y, {
        width: column.width,
        align: column.align ?? 'left',
        ellipsis: true,
        lineBreak: false,
      });
      x += column.width + 4;
    });
  }
}

/**
 * A labelled row of figures, sized to the page.
 *
 * The numeric columns share whatever is left after the label, so a table never
 * runs off the right edge however many measures a form carries.
 */
function labelled(headings: readonly string[], label: string, labelWidth: number): Column[] {
  const each = (CONTENT_WIDTH - labelWidth - 4 * headings.length) / headings.length;
  return [
    { heading: label, width: labelWidth },
    ...headings.map((heading) => ({ heading, width: each, align: 'right' as const })),
  ];
}

const count = (value: number): string => value.toLocaleString('en-US');

/** A rate, or a dash where no loan of that kind exists to have one. */
const rate = (value: string | null): string => value ?? '—';

export function buildReturnPdf(
  document: CompiledReturn,
  cover: PdfCover,
  labels: ReferenceLabels,
): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [PAGE.width, PAGE.height],
    margin: MARGIN,
    info: {
      Title:
        `MSP2 return — ${cover.institutionName} — ` +
        `${String(document.period.year)} Q${String(document.period.quarter)}`,
      Author: cover.institutionName,
    },
  });

  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

  const sheet = new Sheet(doc);
  writeCover(sheet, document, cover);
  writeMsp2_01(sheet, document);
  writeMsp2_02(sheet, document);
  writeMsp2_03(sheet, document, labels);
  writeMsp2_04(sheet, document, labels);
  writeMsp2_05(sheet, document);
  writeMsp2_07(sheet, document);
  writeMsp2_08(sheet, document, labels);
  writeMsp2_09(sheet, document, labels);
  writeMsp2_10(sheet, document, labels);

  doc.end();
  return finished;
}

function writeCover(sheet: Sheet, document: CompiledReturn, cover: PdfCover): void {
  sheet.title(cover.institutionName, 18);
  sheet.title(
    `Bank of Tanzania MSP2 quarterly return — ${String(document.period.year)} Q${String(document.period.quarter)}`,
    12,
  );
  sheet.paragraph(`MSP code ${cover.mspCode}`);
  sheet.paragraph(
    `Quarter ended ${document.period.endDate}. Filed by ${cover.filedByName} on ${cover.filedAt}.`,
  );
  sheet.paragraph(
    cover.submissionReference === null
      ? 'No acknowledgement has been recorded against this filing yet.'
      : `Acknowledged by BOT as ${cover.submissionReference}.`,
  );
  sheet.gap();

  writeFindings(sheet, document.validation.findings);

  if (document.unavailableForms.length > 0) {
    sheet.title('Forms this return does not carry', 11);
    sheet.paragraph(
      'BOT requires these forms and this system does not yet produce them. They are named here ' +
        'rather than omitted, so nobody reads a partial return as a complete one.',
    );
    for (const form of document.unavailableForms) {
      sheet.paragraph(`${form.code} — ${form.reason}`);
    }
  }
}

/**
 * The findings, as they stood when the return was filed.
 *
 * A filing cannot carry a blocking finding — the filing route refuses one — so
 * everything here is a warning. Printed rather than summarised as a count,
 * because "three warnings" tells a board nothing and the warnings themselves
 * are the part worth reading before signing.
 */
function writeFindings(sheet: Sheet, findings: readonly ValidationFinding[]): void {
  sheet.title('Validation at the time of filing', 11);

  if (findings.length === 0) {
    sheet.paragraph('Every check this system runs against BOT’s rules passed, with no warnings.');
    sheet.gap();
    return;
  }

  sheet.table(
    [
      { heading: 'Form', width: 60 },
      { heading: 'Rule', width: 40 },
      { heading: 'Severity', width: 60 },
      { heading: 'Finding', width: CONTENT_WIDTH - 172 },
    ],
    findings.map((finding) => [
      finding.formCode,
      finding.ruleId === null ? '—' : String(finding.ruleId),
      finding.severity,
      finding.message,
    ]),
  );
}

function writeMsp2_01(sheet: Sheet, document: CompiledReturn): void {
  sheet.title('MSP2-01 — Balance Sheet');
  sheet.paragraph(
    'Lines marked computed are the template’s own arithmetic; derived lines come from elsewhere ' +
      'in this system and cannot be typed over.',
  );
  sheet.table(
    [
      { heading: 'Sno', width: 34, align: 'right' },
      { heading: 'Particulars', width: CONTENT_WIDTH - 34 - 90 - 90 - 12 },
      { heading: 'Source', width: 90 },
      { heading: 'Amount (TZS)', width: 90, align: 'right' },
    ],
    document.msp2_01.rows.map((row) => [String(row.sno), row.label, row.source, row.amount]),
  );
}

function writeMsp2_02(sheet: Sheet, document: CompiledReturn): void {
  sheet.title('MSP2-02 — Statement of Income and Expense');
  sheet.paragraph(
    `Year to date covers ${document.msp2_02.yearToDateFrom} to ${document.msp2_02.yearToDateTo}.`,
  );
  sheet.table(
    [
      { heading: 'Sno', width: 34, align: 'right' },
      { heading: 'Particulars', width: CONTENT_WIDTH - 34 - 110 - 110 - 12 },
      { heading: 'Quarter (TZS)', width: 110, align: 'right' },
      { heading: 'Year to date (TZS)', width: 110, align: 'right' },
    ],
    document.msp2_02.rows.map((row) => [
      String(row.sno),
      row.label,
      row.quarterAmount,
      row.yearToDateAmount,
    ]),
  );
}

function writeMsp2_03(sheet: Sheet, document: CompiledReturn, labels: ReferenceLabels): void {
  sheet.title('MSP2-03 — Sectoral Classification and Provisioning');
  sheet.paragraph(
    `Non-performing loans are ${document.msp2_03.nonPerformingRatio}% of gross loans.`,
  );

  const columns = labelled(
    [
      'Borrowers',
      'Outstanding',
      'Current',
      'ESM',
      'Substandard',
      'Doubtful',
      'Loss',
      'Written off',
    ],
    'Sector',
    150,
  );
  const line = (name: string, row: CompiledReturn['msp2_03']['total']): Row => [
    name,
    count(row.borrowerCount),
    row.totalOutstanding,
    row.outstandingByClass.current,
    row.outstandingByClass.esm,
    row.outstandingByClass.substandard,
    row.outstandingByClass.doubtful,
    row.outstandingByClass.loss,
    row.writtenOffDuringPeriod,
  ];

  sheet.table(
    columns,
    [
      ...document.msp2_03.rows.map((row) =>
        line(labels.sectors.get(row.sectorCode) ?? row.sectorCode, row),
      ),
      line('Total', document.msp2_03.total),
    ],
    true,
  );
}

function writeMsp2_04(sheet: Sheet, document: CompiledReturn, labels: ReferenceLabels): void {
  sheet.title('MSP2-04 — Interest Rate Structure');
  sheet.paragraph(
    `Rates are percent per annum, converted on the ${document.msp2_04.annualisation} ` +
      'convention. The weighted averages are BOT’s own formula, reproduced as their template ' +
      'computes it.',
  );

  const columns = labelled(
    [
      'Borrowers',
      'Outstanding',
      'SL average',
      'SL lowest',
      'SL highest',
      'RB average',
      'RB lowest',
      'RB highest',
    ],
    'Loan type',
    150,
  );
  const line = (name: string, row: CompiledReturn['msp2_04']['total']): Row => [
    name,
    count(row.borrowerCount),
    row.totalOutstanding,
    rate(row.straightLine.weightedAverage),
    rate(row.straightLine.lowest),
    rate(row.straightLine.highest),
    rate(row.reducingBalance.weightedAverage),
    rate(row.reducingBalance.lowest),
    rate(row.reducingBalance.highest),
  ];

  sheet.table(
    columns,
    [
      ...document.msp2_04.rows.map((row) =>
        line(labels.loanTypes.get(row.botLoanType) ?? row.botLoanType, row),
      ),
      line('Total', document.msp2_04.total),
    ],
    true,
  );
}

function writeMsp2_05(sheet: Sheet, document: CompiledReturn): void {
  sheet.title('MSP2-05 — Computation of Liquid Assets');
  sheet.paragraph(
    document.msp2_05.meetsRequirement
      ? `Liquid assets are ${document.msp2_05.liquidAssetRatio ?? '—'}% of total assets, above ` +
          'BOT’s 5% minimum.'
      : `Liquid assets are ${document.msp2_05.liquidAssetRatio ?? '—'}% of total assets, BELOW ` +
          'BOT’s 5% minimum. This is a prudential breach and does not stop the return being ' +
          'filed.',
  );
  sheet.table(
    [
      { heading: 'Sno', width: 34, align: 'right' },
      { heading: 'Particulars', width: CONTENT_WIDTH - 34 - 90 - 110 - 12 },
      { heading: 'Source', width: 90 },
      { heading: 'Amount (TZS)', width: 110, align: 'right' },
    ],
    document.msp2_05.rows.map((row) => [String(row.sno), row.label, row.source, row.amount]),
  );
}

function writeMsp2_07(sheet: Sheet, document: CompiledReturn): void {
  sheet.title('MSP2-07 — Deposits and Borrowings');

  const columns = labelled(
    [
      'Deposits TZS',
      'Deposits FX',
      'Deposits total',
      'Borrowings TZS',
      'Borrowings FX',
      'Borrowings total',
    ],
    'Counterparty',
    200,
  );
  const line = (name: string, row: CompiledReturn['msp2_07']['total']): Row => [
    name,
    row.depositTzs,
    row.depositForeignTzsEquivalent,
    row.depositTotal,
    row.borrowingTzs,
    row.borrowingForeignTzsEquivalent,
    row.borrowingTotal,
  ];

  const rows: Row[] = [];
  for (const section of document.msp2_07.sections) {
    for (const row of section.rows) {
      rows.push(line(row.counterparty, row));
    }
    rows.push(line(`Subtotal — ${section.kind.replace(/_/gu, ' ')}`, section.subtotal));
  }
  rows.push(line('Total', document.msp2_07.total));

  sheet.table(columns, rows, true);
}

function writeMsp2_08(sheet: Sheet, document: CompiledReturn, labels: ReferenceLabels): void {
  sheet.title('MSP2-08 — Agent Banking Balances');
  // The compiled form carries every institution BOT lists so its total is
  // provably over all of them; a page of zeros is not what a reader needs.
  const held = document.msp2_08.rows.filter((row) => Number(row.balance) !== 0);
  sheet.paragraph(
    held.length === 0
      ? 'No agent-banking balances were held at the quarter end.'
      : `Balances held with ${String(held.length)} of the institutions on BOT’s agent-banking list.`,
  );

  sheet.table(
    labelled(['Balance (TZS)'], 'Bank', 300),
    [
      ...held.map((row) => [
        labels.institutions.get(row.institutionCode) ?? row.institutionCode,
        row.balance,
      ]),
      ['Total', document.msp2_08.total],
    ],
    true,
  );
}

function writeMsp2_09(sheet: Sheet, document: CompiledReturn, labels: ReferenceLabels): void {
  sheet.title('MSP2-09 — Loans Disbursed During the Quarter');
  sheet.paragraph(
    'A flow rather than a balance: principal advanced during the quarter, not the amount still ' +
      'owing at the end of it.',
  );

  const columns = labelled(
    [
      'Female number',
      'Female amount',
      'Male number',
      'Male amount',
      'Total number',
      'Total amount',
    ],
    'Sector',
    180,
  );
  const line = (name: string, row: CompiledReturn['msp2_09']['total']): Row => [
    name,
    count(row.female.count),
    row.female.amount,
    count(row.male.count),
    row.male.amount,
    count(row.total.count),
    row.total.amount,
  ];

  sheet.table(
    columns,
    [
      ...document.msp2_09.rows.map((row) =>
        line(labels.sectors.get(row.sectorCode) ?? row.sectorCode, row),
      ),
      line('Total', document.msp2_09.total),
    ],
    true,
  );
}

/**
 * MSP2-10, in two passes over the same districts.
 *
 * Fifteen numeric columns will not fit across a page at a size anyone can read.
 * Splitting them beats dropping them: every figure the form carries appears,
 * and each table stays legible.
 *
 * Districts the institution has nothing in are left out. The form has a row for
 * all 193 and the workbook fills all 193, because BOT's grand total is over the
 * whole country; ten pages of zeros is not what makes a reader see where an
 * institution actually operates.
 */
function writeMsp2_10(sheet: Sheet, document: CompiledReturn, labels: ReferenceLabels): void {
  const named = (districtCode: string, regionCode: string): string =>
    `${labels.districts.get(districtCode) ?? districtCode} (${labels.regions.get(regionCode) ?? regionCode})`;

  const operating = document.msp2_10.districts.filter(
    (row) =>
      row.branchCount > 0 ||
      row.employeeCount > 0 ||
      row.totalBorrowers > 0 ||
      Number(row.compulsorySavings) !== 0 ||
      Number(row.totalOutstanding) !== 0,
  );

  sheet.title('MSP2-10 — Geographic Distribution: establishment and borrowers');
  sheet.paragraph(
    `${String(operating.length)} of Tanzania’s ${String(document.msp2_10.districts.length)} ` +
      'districts carry a figure on this return. The rest are filed as nil and are not repeated ' +
      'here; the workbook carries all of them.',
  );
  sheet.table(
    labelled(
      [
        'Branches',
        'Employees',
        'Compulsory savings',
        'Borrowers ≤35 F',
        'Borrowers ≤35 M',
        'Borrowers >35 F',
        'Borrowers >35 M',
        'Total borrowers',
      ],
      'District',
      170,
    ),
    [
      ...operating.map((row) => [
        named(row.districtCode, row.regionCode),
        count(row.branchCount),
        count(row.employeeCount),
        row.compulsorySavings,
        count(row.cells.up_to_35_female.borrowerCount),
        count(row.cells.up_to_35_male.borrowerCount),
        count(row.cells.above_35_female.borrowerCount),
        count(row.cells.above_35_male.borrowerCount),
        count(row.totalBorrowers),
      ]),
      [
        'Grand total',
        count(document.msp2_10.grandTotal.branchCount),
        count(document.msp2_10.grandTotal.employeeCount),
        document.msp2_10.grandTotal.compulsorySavings,
        '',
        '',
        '',
        '',
        count(document.msp2_10.grandTotal.totalBorrowers),
      ],
    ],
    true,
  );

  sheet.title('MSP2-10 — Geographic Distribution: loans outstanding');
  sheet.table(
    labelled(
      [
        'Loans ≤35 F',
        'Loans ≤35 M',
        'Loans >35 F',
        'Loans >35 M',
        'Outstanding ≤35 F',
        'Outstanding ≤35 M',
        'Outstanding >35 F',
        'Outstanding >35 M',
        'Total outstanding',
      ],
      'District',
      150,
    ),
    [
      ...operating.map((row) => [
        named(row.districtCode, row.regionCode),
        count(row.cells.up_to_35_female.loanCount),
        count(row.cells.up_to_35_male.loanCount),
        count(row.cells.above_35_female.loanCount),
        count(row.cells.above_35_male.loanCount),
        row.cells.up_to_35_female.outstanding,
        row.cells.up_to_35_male.outstanding,
        row.cells.above_35_female.outstanding,
        row.cells.above_35_male.outstanding,
        row.totalOutstanding,
      ]),
      ['Grand total', '', '', '', '', '', '', '', '', document.msp2_10.grandTotal.totalOutstanding],
    ],
    true,
  );
}
