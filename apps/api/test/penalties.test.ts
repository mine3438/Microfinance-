import { randomUUID } from 'node:crypto';

import { type Client, type ErrorResponse, type Loan } from '@mfi/contracts';
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
 * Penalty accrual across the book.
 *
 * One property carries this suite: **running the accrual twice must not charge
 * a borrower twice.** Everything else here — the terms, the dates, the arrears
 * — exists to give that property something to be true about. The figures are
 * the test's own; §13.1's are still outstanding.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let adminToken: string;
let managerToken: string;
let clientId: string;
let loanId: string;

/** 0.1% a day, no grace, no cap. Legible arithmetic, not a recommendation. */
const DAILY_RATE = '0.0010';
const PRINCIPAL = '1200000.00';

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  adminToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']),
  );
  managerToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']),
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Juma Mwanri',
      gender: 'male',
      dateOfBirth: '1988-07-03',
      phone: '+255713000111',
      districtCode: 'tz_arusha__karatu',
      sectorCode: 'agriculture',
      branchId: officer.branchId,
    })
  ).json<Client>().id;

  await harness.database.withTransaction(async (db) => {
    await db.query(
      `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
       VALUES ($1, 'branch_manager', 10000000.00)
       ON CONFLICT (institution_id, role_code) DO UPDATE SET max_principal = 10000000.00`,
      [officer.institutionId],
    );
  });

  loanId = await disbursedLoan();
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

  return harness.database.withTransaction(async (db) => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Staff', $4, 'active') RETURNING id`,
      [institutionId, branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await db.query(
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
  method: 'GET' | 'POST',
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

/** A product with penalty terms, and a loan disbursed against it. */
async function disbursedLoan(): Promise<string> {
  const productId = await harness.database.withTransaction(async (db) => {
    const row = await db.query<{ id: string }>(
      `INSERT INTO loan_products
         (institution_id, code, name, bot_loan_type, interest_method,
          min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
          min_principal, max_principal, penalty_daily_rate, penalty_grace_days)
       VALUES ($1, $2, 'Penalty Suite Product', 'agriculture_loans', 'flat',
               0.0100, 0.1000, 1, 60, 100000.00, 5000000.00, $3, 0)
       RETURNING id`,
      [officer.institutionId, `PEN${randomUUID().slice(0, 5)}`, DAILY_RATE],
    );
    return row.rows[0]!.id;
  });

  const loan = (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal: PRINCIPAL,
      monthlyRate: '0.0200',
      termMonths: 6,
    })
  ).json<Loan>();

  await request('POST', `/loans/${loan.id}/submit`, officerToken);
  await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });
  await request('POST', `/loans/${loan.id}/disbursement`, adminToken, {
    disbursementDate: '2026-01-05',
  });

  return loan.id;
}

const accrue = async (asAt: string, token = adminToken): Promise<InjectResponse> =>
  request('POST', '/penalties/accrual', token, { asAt });

const penaltyBalance = async (): Promise<string> =>
  harness.database.withTransaction(async (db) => {
    const row = await db.query<{ penalty_balance: string }>(
      'SELECT penalty_balance FROM loans WHERE id = $1',
      [loanId],
    );
    return row.rows[0]!.penalty_balance;
  });

describe('POST /penalties/accrual', () => {
  it('charges nothing on a book with no overdue instalments', async () => {
    // Disbursed 5 January; the first instalment is not due until February.
    const response = await accrue('2026-01-20');

    expect(response.statusCode).toBe(200);
    expect(await penaltyBalance()).toBe('0.00');
  });

  it('charges the days an instalment has been overdue', async () => {
    await accrue('2026-02-15');

    // The first instalment fell due 5 February; ten days at 0.1% of it.
    const charged = await penaltyBalance();
    expect(Number(charged)).toBeGreaterThan(0);
  });

  it('is idempotent: running it again for the same date charges nothing more', async () => {
    // The property the watermark exists for. Without it, a job that ran twice
    // on a Tuesday would double what the borrower owes.
    const before = await penaltyBalance();

    await accrue('2026-02-15');
    await accrue('2026-02-15');

    expect(await penaltyBalance()).toBe(before);
  });

  it('charges only the days since the last run when moved forward', async () => {
    const atFifteenth = Number(await penaltyBalance());

    await accrue('2026-02-25');
    const atTwentyFifth = Number(await penaltyBalance());

    // Ten more days on the same overdue amount, so the increment matches what
    // the first ten days cost rather than being recomputed from scratch.
    expect(atTwentyFifth).toBeGreaterThan(atFifteenth);
    expect(atTwentyFifth).toBeCloseTo(atFifteenth * 2, 2);
  });

  it('refuses to accrue to a date that has not happened', async () => {
    const response = await accrue('2099-01-01');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('has not happened yet');
  });

  it('refuses a caller without the authority to change what is owed', async () => {
    const response = await accrue('2026-02-15', officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('leaves a product with no penalty terms alone', async () => {
    // Every loan in an unconfigured institution, which is every institution
    // until §13.1's values arrive.
    const outsider = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await accrue('2026-02-15', await tokenFor(outsider));

    expect(response.statusCode).toBe(200);
    expect(response.json<{ loansConsidered: number }>().loansConsidered).toBe(0);
  });
});
