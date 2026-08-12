import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync, inflateSync } from 'node:zlib';

import { type ErrorResponse, type FiledReturnDetail } from '@mfi/contracts';
import { hashPassword } from '@mfi/identity';
import ExcelJS from 'exceljs';
import { type Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_TEST_PASSWORD,
  freshAddress,
  seedUser,
  startHarness,
  type Harness,
  type SeededUser,
} from './harness.js';

/**
 * Exporting a filed return as BOT's own workbook.
 *
 * What this suite really asserts is that the file an institution uploads is
 * BOT's template with figures in it — not a spreadsheet of this system's
 * design that happens to look similar. So it opens the bytes the route
 * produced and checks three things a rewritten workbook would fail: BOT's
 * formulas are still formulas, their dropdown lists still resolve, and the
 * figures landed in the cells their own validator reads.
 */

let harness: Harness;
let accountant: SeededUser;
let accountantToken: string;
let officerToken: string;
let institutionName: string;

/** Sno2 is cash in hand; Sno52 is paid-up ordinary share capital. */
const CASH_IN_HAND = 2;
const SHARE_CAPITAL = 52;

/** Cash in hand is row 15 of the balance sheet, and amounts sit in column C. */
const CASH_CELL = 'C15';
/** Total assets: BOT's own formula, which this system must not overwrite. */
const TOTAL_ASSETS_CELL = 'C46';
const TOTAL_ASSETS_FORMULA = 'C14+C21+C27+C30+C36+C39';

const MSP_CODE = 'M0042';

beforeAll(async () => {
  harness = await startHarness();

  const officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  accountant = await seedUserIn(officer.institutionId, officer.branchId, ['accountant']);
  accountantToken = await tokenFor(accountant);

  institutionName = await harness.database.withTransaction(async (client) => {
    const rows = await client.query<{ name: string }>(
      'SELECT name FROM institutions WHERE id = $1',
      [officer.institutionId],
    );
    return rows.rows[0]!.name;
  });

  await harness.database.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_health (institution_id, classifications_updated_at)
       VALUES ($1, now())
       ON CONFLICT (institution_id)
       DO UPDATE SET classifications_updated_at = EXCLUDED.classifications_updated_at`,
      [officer.institutionId],
    );
  });
});

afterAll(async () => {
  await harness.close();
});

async function seedUserIn(
  institutionId: string,
  branchId: string,
  roles: readonly string[],
): Promise<SeededUser> {
  const email = `staff.${randomUUID().slice(0, 8)}@seed.test`;
  const passwordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

  return harness.database.withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Accountant', $4, 'active') RETURNING id`,
      [institutionId, branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await client.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, userId, role],
      );
    }
    return { institutionId, branchId, userId, email, password: DEFAULT_TEST_PASSWORD };
  });
}

async function tokenFor(user: SeededUser): Promise<string> {
  const login = await harness.server.inject({
    method: 'POST',
    url: '/auth/login',
    remoteAddress: freshAddress(),
    payload: { email: user.email, password: user.password },
  });
  return login.json<{ accessToken: string }>().accessToken;
}

const request = async (
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string,
  payload?: Record<string, unknown>,
): Promise<InjectResponse> =>
  harness.server.inject({
    method,
    url,
    remoteAddress: freshAddress(),
    headers: { authorization: `Bearer ${token}` },
    ...(payload === undefined ? {} : { payload }),
  });

/** A period per test, varying the year so no two suites' quarters collide. */
let used = 0;
const freshPeriod = (): { year: number; quarter: number } => {
  used += 1;
  return { year: 2015 + Math.floor((used - 1) / 4), quarter: ((used - 1) % 4) + 1 };
};

/** Record the BOT registration code every form is printed with. */
async function setMspCode(institutionId: string, code: string | null): Promise<void> {
  await harness.database.withTransaction(async (client) => {
    await client.query('UPDATE institutions SET msp_code = $2 WHERE id = $1', [
      institutionId,
      code,
    ]);
  });
}

/** File a quarter whose balance sheet balances, and return the filing. */
async function fileBalancedQuarter(amount = '5000000.00'): Promise<FiledReturnDetail> {
  const period = freshPeriod();

  await request(
    'PUT',
    `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
    accountantToken,
    {
      lines: [
        { sno: CASH_IN_HAND, amount },
        { sno: SHARE_CAPITAL, amount },
      ],
    },
  );

  const filed = await request(
    'POST',
    `/reports/msp2/${String(period.year)}/${String(period.quarter)}/filing`,
    accountantToken,
    {},
  );
  return filed.json<FiledReturnDetail>();
}

/**
 * Read one part out of the .xlsx, which is a zip.
 *
 * ExcelJS writes `<calcPr>` but discards it on load, so the only way to assert
 * that an exported workbook recalculates on open is to look at the part itself.
 */
function partOf(response: InjectResponse, path: string): string {
  const zip = response.rawPayload;
  for (
    let at = zip.indexOf('PK\u0003\u0004');
    at !== -1;
    at = zip.indexOf('PK\u0003\u0004', at + 4)
  ) {
    const method = zip.readUInt16LE(at + 8);
    const compressedBytes = zip.readUInt32LE(at + 18);
    const nameLength = zip.readUInt16LE(at + 26);
    const extraLength = zip.readUInt16LE(at + 28);
    if (zip.subarray(at + 30, at + 30 + nameLength).toString() !== path) {
      continue;
    }
    const start = at + 30 + nameLength + extraLength;
    const body = zip.subarray(start, start + compressedBytes);
    return (method === 8 ? inflateRawSync(body) : body).toString('utf8');
  }
  throw new Error(`The exported workbook has no ${path}.`);
}

/**
 * Read the bytes a download produced back into a workbook.
 *
 * Through a file rather than in memory: ExcelJS augments the global `Buffer`
 * type with its own declaration, which its `load` overload will not accept a
 * modern one against. Reading the path it does accept keeps the assertion
 * honest without a cast that would hide a real mismatch.
 */
async function openWorkbook(response: InjectResponse): Promise<ExcelJS.Workbook> {
  const directory = await mkdtemp(join(tmpdir(), 'mfi-export-'));
  const path = join(directory, 'return.xlsx');
  await writeFile(path, response.rawPayload);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  return workbook;
}

/**
 * The text of a PDF, flattened.
 *
 * PDFKit writes each `text()` call as a `TJ` array of hex-encoded runs with
 * kerning adjustments between them, inside a compressed content stream. So the
 * words are recoverable without a parser: inflate every stream, take the runs
 * out of each array and drop the numbers. Crude, and enough to assert that a
 * figure reached the page rather than that it looks right there.
 */
function pdfText(response: InjectResponse): string {
  const showText = /\[((?:<[0-9a-fA-F]*>|[-\d.\s])*)\]\s*TJ/gu;
  const runs = /<([0-9a-fA-F]*)>/gu;

  const linesOf = (stream: string): string[] =>
    [...stream.matchAll(showText)].map((operator) =>
      [...(operator[1] ?? '').matchAll(runs)]
        .map((run) => Buffer.from(run[1] ?? '', 'hex').toString('latin1'))
        .join(''),
    );

  const found: string[] = [];
  const pdf = response.rawPayload;
  for (
    let at = pdf.indexOf('stream');
    at !== -1 && at < pdf.length;
    at = pdf.indexOf('stream', at + 6)
  ) {
    const start = pdf[at + 6] === 0x0d ? at + 8 : at + 7;
    const end = pdf.indexOf('endstream', start);
    if (end === -1) {
      break;
    }
    try {
      found.push(...linesOf(inflateSync(pdf.subarray(start, end)).toString('latin1')));
    } catch {
      // Not a deflated content stream — a font or an image. Nothing to read.
    }
  }
  return found.join('\n');
}

describe('GET /filings/:id/workbook', () => {
  it('fills BOT’s template rather than producing a spreadsheet of its own', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter('5000000.00');

    const response = await request('GET', `/filings/${filed.id}/workbook`, accountantToken);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(response.headers['content-disposition']).toContain(
      `MSP2_${MSP_CODE}_${String(filed.year)}Q${String(filed.quarter)}.xlsx`,
    );

    const workbook = await openWorkbook(response);
    // All ten forms plus BOT's lookup sheet, which is what makes it their file.
    expect(workbook.worksheets.map((sheet) => sheet.name)).toContain('Static Information');
    expect(workbook.worksheets).toHaveLength(11);
  });

  it('writes the figure as a number, in the cell BOT’s validator reads', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter('7500000.00');

    const workbook = await openWorkbook(
      await request('GET', `/filings/${filed.id}/workbook`, accountantToken),
    );

    // A money figure written as text makes BOT's own SUM return zero.
    const cash = workbook.getWorksheet('MSP2_01')?.getCell(CASH_CELL).value;
    expect(cash).toBe(7_500_000);
  });

  it('leaves BOT’s own arithmetic alone', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const response = await request('GET', `/filings/${filed.id}/workbook`, accountantToken);
    const workbook = await openWorkbook(response);

    // Total assets is the template's formula. Overwriting it would replace
    // BOT's arithmetic with this system's, and a disagreement between the two
    // would be filed without anyone seeing it.
    const total = workbook.getWorksheet('MSP2_01')?.getCell(TOTAL_ASSETS_CELL).value;
    expect(total).toMatchObject({ formula: TOTAL_ASSETS_FORMULA });

    // And the totals have to be recomputed on open: every cached result in the
    // template is BOT's sample data, not this institution's figures.
    expect(partOf(response, 'xl/workbook.xml')).toContain('fullCalcOnLoad="1"');
  });

  it('writes the complaints roll-forward and leaves BOT to close it', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const workbook = await openWorkbook(
      await request('GET', `/filings/${filed.id}/workbook`, accountantToken),
    );
    const sheet = workbook.getWorksheet('MSP2-06');

    // Sno1 is row 14: a count, written as a number even when it is nil.
    expect(sheet?.getCell('C14').value).toBe(0);
    // Sno5 is row 18, and BOT computes the whole of it — count and value alike.
    // This system derives the same figure from the records and never writes it.
    expect(sheet?.getCell('C18').value).toMatchObject({ formula: 'C14+C15-C16-C17' });
  });

  it('prints the institution on every form, not the one BOT left in the template', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const workbook = await openWorkbook(
      await request('GET', `/filings/${filed.id}/workbook`, accountantToken),
    );

    // Nine of the ten sheets read these three cells from an external workbook
    // BOT does not ship, cached as "TESTING MSP". Each is written literally.
    const named: [string, string][] = [
      ['MSP2_01', 'C'],
      ['MSP2-02', 'C'],
      ['MSP2-03', 'D'],
      ['MSP2-07', 'F'],
      ['MSP2-08', 'E'],
      ['MSP2-10', 'H'],
    ];
    for (const [sheetName, column] of named) {
      const sheet = workbook.getWorksheet(sheetName);
      expect(sheet?.getCell(`${column}2`).value).toBe(institutionName);
      expect(sheet?.getCell(`${column}4`).value).toBe(MSP_CODE);
    }
  });

  it('repoints the dropdown lists at the sheet the template already carries', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const workbook = await openWorkbook(
      await request('GET', `/filings/${filed.id}/workbook`, accountantToken),
    );

    // BOT's own definitions name `'[1]Static Information'` — the workbook that
    // is not distributed with the template. Left that way they resolve to
    // nothing once the external part is gone.
    const names = workbook.definedNames.model.map((entry) => entry.ranges.join(','));
    expect(names.join(' ')).not.toContain('[1]');
    expect(names.join(' ')).toContain("'Static Information'!$B$3:$B$58");
  });

  it('refuses to export without a BOT registration code', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();
    await setMspCode(accountant.institutionId, null);

    const response = await request('GET', `/filings/${filed.id}/workbook`, accountantToken);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('MSP code');

    await setMspCode(accountant.institutionId, MSP_CODE);
  });

  it('refuses a caller without report.read', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const response = await request('GET', `/filings/${filed.id}/workbook`, officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('does not export another institution’s filing', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const outsider = await seedUser(harness.database, { roles: ['accountant'] });
    const response = await request(
      'GET',
      `/filings/${filed.id}/workbook`,
      await tokenFor(outsider),
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /filings/:id/pdf', () => {
  it('renders the filed return for a reader', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter('6250000.00');

    const response = await request('GET', `/filings/${filed.id}/pdf`, accountantToken);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain(
      `MSP2_${MSP_CODE}_${String(filed.year)}Q${String(filed.quarter)}.pdf`,
    );
    expect(response.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    const text = pdfText(response);
    // Who filed it, which is the thing the workbook cannot carry.
    expect(text).toContain('Seed Accountant');
    expect(text).toContain(MSP_CODE);
    // And every form, named as BOT names it.
    for (const form of ['MSP2-01', 'MSP2-03', 'MSP2-05', 'MSP2-10']) {
      expect(text).toContain(form);
    }
  });

  it('prints the archived figure rather than recomputing it', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter('6250000.00');

    // The book moves after filing, exactly as in the archive suite.
    await request(
      'PUT',
      `/statements/MSP2-01/${String(filed.year)}/${String(filed.quarter)}`,
      accountantToken,
      { lines: [{ sno: CASH_IN_HAND, amount: '9999999.00' }] },
    );

    const text = pdfText(await request('GET', `/filings/${filed.id}/pdf`, accountantToken));

    expect(text).toContain('6250000.00');
    expect(text).not.toContain('9999999.00');
  });

  it('carries the warnings that stood when it was filed', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    // Two lines entered out of thirty-five, so the "a sheet of zeros balances
    // trivially" warning is on this filing.
    const filed = await fileBalancedQuarter();

    const text = pdfText(await request('GET', `/filings/${filed.id}/pdf`, accountantToken));

    expect(filed.findingCount).toBeGreaterThan(0);
    expect(text).toContain('Validation at the time of filing');
    expect(text).toContain('warning');
  });

  it('refuses a caller without report.read', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const response = await request('GET', `/filings/${filed.id}/pdf`, officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('does not render another institution’s filing', async () => {
    await setMspCode(accountant.institutionId, MSP_CODE);
    const filed = await fileBalancedQuarter();

    const outsider = await seedUser(harness.database, { roles: ['accountant'] });
    const response = await request('GET', `/filings/${filed.id}/pdf`, await tokenFor(outsider));

    expect(response.statusCode).toBe(404);
  });
});
