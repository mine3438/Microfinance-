import { randomUUID } from 'node:crypto';

import { type ErrorResponse, type Msp2_01, type Msp2_05 } from '@mfi/contracts';
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
 * Preparing MSP2-01 and MSP2-05.
 *
 * The property this suite is built around: a line this system answers cannot be
 * overwritten. Not "should not" — the database has no row that would hold a
 * second opinion about the loan book, so the attempt is refused rather than
 * accepted and quietly ignored.
 */

let harness: Harness;
let accountant: SeededUser;
let accountantToken: string;
let officerToken: string;

/** Sno2 is "Cash in Hand", which the institution types in. */
const CASH_IN_HAND = 2;
/** Sno18 is "Loans to Clients", which comes from the loan book. */
const LOANS_TO_CLIENTS = 18;
/** Sno33 is Total Assets, which BOT's own template computes. */
const TOTAL_ASSETS = 33;
/** Sno52 is paid-up ordinary share capital. */
const SHARE_CAPITAL = 52;

beforeAll(async () => {
  harness = await startHarness();

  const officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  accountant = await seedUserIn(officer.institutionId, officer.branchId, ['accountant']);
  accountantToken = await tokenFor(accountant);
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
       VALUES ($1, $2, $3, 'Seed Staff', $4, 'active') RETURNING id`,
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
  method: 'GET' | 'PUT',
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

/** A quarter of its own per test, so one suite's figures never meet another's. */
let nextQuarter = 0;
const freshPeriod = (): { year: number; quarter: number } => {
  nextQuarter += 1;
  return { year: 2020 + Math.floor(nextQuarter / 4), quarter: (nextQuarter % 4) + 1 };
};

const save = async (
  lines: { sno: number; amount: string }[],
  period = freshPeriod(),
  token = accountantToken,
): Promise<InjectResponse> =>
  request('PUT', `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`, token, {
    lines,
  });

const amountAt = (form: Msp2_01, sno: number): string | undefined =>
  form.rows.find((row) => row.sno === sno)?.amount;

describe('GET /statements/MSP2-01/:year/:quarter', () => {
  it('returns every line with where its figure came from', async () => {
    const period = freshPeriod();
    const form = (
      await request(
        'GET',
        `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
        accountantToken,
      )
    ).json<{ msp2_01: Msp2_01 }>().msp2_01;

    // 61 lines less the heading BOT's own Total Liabilities formula ignores.
    expect(form.rows).toHaveLength(60);
    expect(form.rows.find((row) => row.sno === LOANS_TO_CLIENTS)?.source).toBe('derived');
    expect(form.rows.find((row) => row.sno === TOTAL_ASSETS)?.source).toBe('computed');
    expect(form.rows.find((row) => row.sno === CASH_IN_HAND)?.source).toBe('entered');
  });

  it('lists the lines nobody has filled in yet', async () => {
    const period = freshPeriod();
    const form = (
      await request(
        'GET',
        `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
        accountantToken,
      )
    ).json<{ msp2_01: Msp2_01 }>().msp2_01;

    expect(form.missingEntries).toHaveLength(35);
  });

  it('is not blocked by stale classifications, unlike a filing', async () => {
    // The freshness gate exists to stop a *return* resting on stale figures.
    // Typing last quarter's rent into a balance sheet is not filing, and this
    // institution has never had classifications run at all.
    const period = freshPeriod();
    const response = await request(
      'GET',
      `/statements/MSP2-01/${String(period.year)}/${String(period.quarter)}`,
      accountantToken,
    );

    expect(response.statusCode).toBe(200);
  });

  it('refuses a caller without expense.read', async () => {
    const response = await request('GET', '/statements/MSP2-01/2026/1', officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('refuses a form this system does not prepare', async () => {
    const response = await request('GET', '/statements/MSP2-03/2026/1', accountantToken);

    expect(response.statusCode).toBe(400);
  });
});

describe('PUT /statements/MSP2-01/:year/:quarter', () => {
  it('saves a figure and returns the totals it moved', async () => {
    const response = await save([{ sno: CASH_IN_HAND, amount: '1500000.00' }]);
    const form = response.json<{ msp2_01: Msp2_01 }>().msp2_01;

    expect(response.statusCode).toBe(200);
    expect(amountAt(form, CASH_IN_HAND)).toBe('1500000.00');
    // Sno1 is cash plus bank balances; Sno33 rolls every subtotal up.
    expect(amountAt(form, 1)).toBe('1500000.00');
    expect(amountAt(form, TOTAL_ASSETS)).toBe('1500000.00');
  });

  it('refuses a figure against a line this system derives', async () => {
    const response = await save([{ sno: LOANS_TO_CLIENTS, amount: '9999999.00' }]);

    // Named, not a bare constraint failure: the message says which line and
    // why a second answer would be wrong.
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toMatch(/derives it from figures/);
  });

  it('refuses a figure against a line BOT computes', async () => {
    const response = await save([{ sno: TOTAL_ASSETS, amount: '9999999.00' }]);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toMatch(/computes it from the lines/);
  });

  it('replaces a figure rather than recording a second one', async () => {
    const period = freshPeriod();

    await save([{ sno: CASH_IN_HAND, amount: '1000000.00' }], period);
    const form = (await save([{ sno: CASH_IN_HAND, amount: '2500000.00' }], period)).json<{
      msp2_01: Msp2_01;
    }>().msp2_01;

    expect(amountAt(form, CASH_IN_HAND)).toBe('2500000.00');
    expect(amountAt(form, TOTAL_ASSETS)).toBe('2500000.00');
  });

  it('accepts a negative figure, because retained earnings can be one', async () => {
    const form = (
      await save([
        { sno: SHARE_CAPITAL, amount: '10000000.00' },
        { sno: 58, amount: '-2500000.00' },
      ])
    ).json<{ msp2_01: Msp2_01 }>().msp2_01;

    // Sno51 is total capital.
    expect(amountAt(form, 51)).toBe('7500000.00');
  });

  it('refuses the same line twice in one request', async () => {
    const response = await save([
      { sno: CASH_IN_HAND, amount: '1000.00' },
      { sno: CASH_IN_HAND, amount: '2000.00' },
    ]);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toContain('more than once');
  });

  it('refuses an amount sent as a JSON number', async () => {
    const response = await save([{ sno: CASH_IN_HAND, amount: 1500000 } as never]);

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('binary');
  });

  it('refuses a caller without expense.manage', async () => {
    const response = await save(
      [{ sno: CASH_IN_HAND, amount: '1000.00' }],
      freshPeriod(),
      officerToken,
    );

    expect(response.statusCode).toBe(403);
  });

  it('keeps quarters apart', async () => {
    const first = freshPeriod();
    const second = freshPeriod();

    await save([{ sno: CASH_IN_HAND, amount: '1000000.00' }], first);
    const form = (
      await request(
        'GET',
        `/statements/MSP2-01/${String(second.year)}/${String(second.quarter)}`,
        accountantToken,
      )
    ).json<{ msp2_01: Msp2_01 }>().msp2_01;

    expect(amountAt(form, CASH_IN_HAND)).toBe('0.00');
  });
});

describe('MSP2-05', () => {
  it('restates the balance sheet and measures BOT’s 5% floor', async () => {
    const period = freshPeriod();

    // 200,000 of cash against 10,000,000 of total assets is 2%, below the floor.
    await save(
      [
        { sno: CASH_IN_HAND, amount: '200000.00' },
        { sno: 24, amount: '9800000.00' },
      ],
      period,
    );

    const form = (
      await request(
        'GET',
        `/statements/MSP2-05/${String(period.year)}/${String(period.quarter)}`,
        accountantToken,
      )
    ).json<{ msp2_05: Msp2_05 }>().msp2_05;

    expect(form.totalAssets).toBe('10000000.00');
    expect(form.availableLiquidAssets).toBe('200000.00');
    expect(form.requiredMinimum).toBe('500000.00');
    expect(form.excess).toBe('-300000.00');
    expect(form.liquidAssetRatio).toBe('2.0000');
    // A breach is a supervisory matter, and finding it at submission is too
    // late to act on.
    expect(form.meetsRequirement).toBe(false);
  });

  it('adds the securities lines an institution types in', async () => {
    const period = freshPeriod();

    await save([{ sno: CASH_IN_HAND, amount: '1000000.00' }], period);
    const response = await request(
      'PUT',
      `/statements/MSP2-05/${String(period.year)}/${String(period.quarter)}`,
      accountantToken,
      { lines: [{ sno: 6, amount: '4000000.00' }] },
    );

    const form = response.json<{ msp2_05: Msp2_05 }>().msp2_05;
    expect(form.availableLiquidAssets).toBe('5000000.00');
  });

  it('refuses a figure against a line that restates MSP2-01', async () => {
    const period = freshPeriod();

    const response = await request(
      'PUT',
      `/statements/MSP2-05/${String(period.year)}/${String(period.quarter)}`,
      accountantToken,
      { lines: [{ sno: 2, amount: '9999.00' }] },
    );

    expect(response.statusCode).toBe(400);
  });
});
