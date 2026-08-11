import { randomUUID } from 'node:crypto';

import {
  type ErrorResponse,
  type FiledReturn,
  type FiledReturnDetail,
  type Msp2_01,
} from '@mfi/contracts';
import { hashPassword } from '@mfi/identity';
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
 * Filing a return, and reading one back years later.
 *
 * Two properties carry this suite. A return BOT's own validator would reject
 * cannot be filed — spending a submission window to learn what this system
 * already knew is the failure the validation engine exists to prevent. And what
 * is archived is the document, not the inputs: recompiling the same quarter
 * after the loan book has moved produces a different answer, and an institution
 * asked to explain a figure needs the one it sent.
 */

let harness: Harness;
let accountant: SeededUser;
let accountantToken: string;
let officerToken: string;

/** Sno2 is cash in hand; Sno52 is paid-up ordinary share capital. */
const CASH_IN_HAND = 2;
const SHARE_CAPITAL = 52;

beforeAll(async () => {
  harness = await startHarness();

  const officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  accountant = await seedUserIn(officer.institutionId, officer.branchId, ['accountant']);
  accountantToken = await tokenFor(accountant);

  // Classifications must be fresh for a return to compile at all.
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
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

/**
 * A period of its own per test.
 *
 * The year moves as well as the quarter: a year holds four of them, and reusing
 * one would let an earlier test's balanced sheet make a later test's filing
 * succeed when it was meant to be refused.
 */
let used = 0;
const freshPeriod = (): { year: number; quarter: number } => {
  used += 1;
  return { year: 2020 + Math.floor((used - 1) / 4), quarter: ((used - 1) % 4) + 1 };
};

/**
 * Balance the sheet for a quarter.
 *
 * Nothing is lent in this suite, so total assets are whatever cash is entered
 * and the capital line has to match it. Without this every filing would fail
 * rule 1 — which is itself worth one test, but not all of them.
 */
async function balancedQuarter(amount = '5000000.00'): Promise<{ year: number; quarter: number }> {
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

  return period;
}

const file = async (
  period: { year: number; quarter: number },
  token = accountantToken,
): Promise<InjectResponse> =>
  request(
    'POST',
    `/reports/msp2/${String(period.year)}/${String(period.quarter)}/filing`,
    token,
    {},
  );

describe('POST /reports/msp2/:year/:quarter/filing', () => {
  it('archives the compiled return', async () => {
    const period = await balancedQuarter();
    const response = await file(period);

    expect(response.statusCode).toBe(201);

    const filed = response.json<FiledReturnDetail>();
    expect(filed.year).toBe(period.year);
    expect(filed.quarter).toBe(period.quarter);
    expect(filed.filedByName).toBe('Seed Accountant');
    // Nine forms, named as BOT spells them rather than as the wire shape does.
    expect(filed.formCodes).toContain('MSP2-01');
    expect(filed.formCodes).toContain('MSP2-10');
    expect(filed.formCodes).toHaveLength(9);
  });

  it('refuses a return BOT’s own validator would reject', async () => {
    // Cash with no capital behind it: assets exceed liabilities and capital, so
    // rule 1 blocks. An *empty* sheet would balance at zero against zero, which
    // is why that case is a warning about unfilled lines rather than this.
    const period = freshPeriod();
    await request(
      'PUT',
      `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
      accountantToken,
      { lines: [{ sno: CASH_IN_HAND, amount: '5000000.00' }] },
    );

    const response = await file(period);
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(422);
    expect(body.error.message).toContain('would be rejected at submission');
    // Every blocking finding, named by the form it is about, so an operator
    // knows where to look rather than only that something is wrong.
    expect(body.error.details?.some((detail) => detail.path[0] === 'MSP2-01')).toBe(true);
  });

  it('refuses a caller without report.generate', async () => {
    const response = await file(await balancedQuarter(), officerToken);

    expect(response.statusCode).toBe(403);
  });
});

describe('GET /filings/:id', () => {
  it('serves the document as filed, not a recompilation', async () => {
    const period = await balancedQuarter('7500000.00');
    const filed = (await file(period)).json<FiledReturnDetail>();

    // The book moves after the filing. This is the whole reason the document
    // is stored rather than recomputed on demand.
    await request(
      'PUT',
      `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
      accountantToken,
      { lines: [{ sno: CASH_IN_HAND, amount: '9999999.00' }] },
    );

    const readBack = (
      await request('GET', `/filings/${filed.id}`, accountantToken)
    ).json<FiledReturnDetail>();

    const cash = (form: Msp2_01): string | undefined =>
      form.rows.find((row) => row.sno === CASH_IN_HAND)?.amount;

    expect(cash(readBack.document.msp2_01)).toBe('7500000.00');
    expect(cash(readBack.document.msp2_01)).toBe(cash(filed.document.msp2_01));
  });

  it('keeps every figure as a string inside the archived document', async () => {
    const filed = (await file(await balancedQuarter())).json<FiledReturnDetail>();

    const raw = (await request('GET', `/filings/${filed.id}`, accountantToken)).body;

    // A filing that cannot be reproduced to the cent is not a filing record.
    expect(raw).not.toMatch(/"totalOutstanding":\s*-?\d/);
    expect(raw).toMatch(/"totalOutstanding":\s*"/);
  });

  it('is readable by a role that may not file', async () => {
    const filed = (await file(await balancedQuarter())).json<FiledReturnDetail>();

    const auditor = await seedUserIn(accountant.institutionId, accountant.branchId, ['auditor']);
    const response = await request('GET', `/filings/${filed.id}`, await tokenFor(auditor));

    // `report.read` is a different authority from `report.generate`.
    expect(response.statusCode).toBe(200);
  });

  it('does not serve another institution’s filing', async () => {
    const filed = (await file(await balancedQuarter())).json<FiledReturnDetail>();

    const outsider = await seedUser(harness.database, { roles: ['accountant'] });
    const response = await request('GET', `/filings/${filed.id}`, await tokenFor(outsider));

    expect(response.statusCode).toBe(404);
  });
});

describe('PATCH /filings/:id', () => {
  it('records BOT’s acknowledgement against a filing', async () => {
    const filed = (await file(await balancedQuarter())).json<FiledReturnDetail>();

    const updated = await request('PATCH', `/filings/${filed.id}`, accountantToken, {
      submissionReference: 'BOT/MSP2/2026/Q1/0042',
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<FiledReturn>().submissionReference).toBe('BOT/MSP2/2026/Q1/0042');
  });
});

describe('GET /filings', () => {
  it('lists what has been filed, newest first', async () => {
    await file(await balancedQuarter());

    const filings = (await request('GET', '/filings', accountantToken)).json<FiledReturn[]>();

    expect(filings.length).toBeGreaterThan(0);
    const times = filings.map((filing) => Date.parse(filing.filedAt));
    expect([...times].sort((left, right) => right - left)).toEqual(times);
  });
});
