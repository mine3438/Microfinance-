import { randomUUID } from 'node:crypto';

import {
  type ErrorResponse,
  type Loan,
  type LoanRestructuring,
  type LoanWithSchedule,
} from '@mfi/contracts';
import { hashPassword } from '@mfi/identity';
import { Money } from '@mfi/money';
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
 * Restructuring a loan into a successor.
 *
 * The approved rules are RESTRUCT-01…03 and RESTRUCT-05. Two properties carry
 * the weight here.
 *
 * The first is that nothing is forgiven: the new principal is the old loan's
 * remaining principal plus its unpaid interest plus its unpaid penalties, and
 * the new schedule charges interest on all of it. A restructuring that quietly
 * dropped the penalties would be a write-off wearing a different name.
 *
 * The second is that the old loan survives and stops being a debt. It keeps its
 * schedule and its payments, it cannot take another repayment, and it is not
 * marked `completed` — because nobody completed it.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let managerToken: string;
let adminToken: string;
let productId: string;
let clientId: string;

const PRINCIPAL = '1200000.00';
const TERM_MONTHS = 10;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  managerToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']),
  );
  adminToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']),
  );

  const reference = await harness.database.withTransaction(async (client) => {
    const district = await client.query<{ code: string }>(
      'SELECT code FROM reference.districts ORDER BY code LIMIT 1',
    );
    const sector = await client.query<{ code: string }>(
      'SELECT code FROM reference.sectors ORDER BY code LIMIT 1',
    );
    const loanType = await client.query<{ code: string }>(
      'SELECT code FROM reference.loan_types ORDER BY code LIMIT 1',
    );
    return {
      district: district.rows[0]!.code,
      sector: sector.rows[0]!.code,
      loanType: loanType.rows[0]!.code,
    };
  });

  productId = await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal)
         VALUES ($1, 'RST', 'Restructuring Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 9000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Grace Mwita',
      gender: 'female',
      dateOfBirth: '1985-04-04',
      phone: '0716222333',
      districtCode: reference.district,
      sectorCode: reference.sector,
    })
  ).json<{ id: string }>().id;

  await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'branch_manager', 50000000.00)
         ON CONFLICT (institution_id, role_code)
           DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [officer.institutionId],
      );
    },
  );
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
  method: 'GET' | 'POST' | 'PATCH',
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
 * A calendar date a whole number of months from today.
 *
 * Every date in this suite is derived rather than pinned. The rule under test —
 * "still within the originally agreed term" — is a statement about where today
 * falls relative to a loan's maturity, so a fixture with fixed dates stops
 * testing the rule the moment the calendar moves past it. That is exactly how
 * the first version of this file went green locally and red in CI.
 */
function monthsFromToday(months: number, dayOfMonth?: number): string {
  const now = new Date();
  const shifted = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + months, dayOfMonth ?? 15),
  );
  return shifted.toISOString().slice(0, 10);
}

/** Today, as the API dates things. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * A ten-month loan, disbursed `disbursedMonthsAgo` months ago.
 *
 * The default puts maturity four months ahead, so the loan is comfortably
 * inside its term whenever this runs. Passing a larger number produces a loan
 * whose term has already ended, which is what the eligibility tests need.
 */
async function activeLoan(disbursedMonthsAgo = 6): Promise<LoanWithSchedule> {
  const created = (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal: PRINCIPAL,
      monthlyRate: '0.0200',
      termMonths: TERM_MONTHS,
    })
  ).json<Loan>();

  await request('POST', `/loans/${created.id}/submit`, officerToken);
  await request('POST', `/loans/${created.id}/decision`, managerToken, { decision: 'approve' });
  const disbursed = await request('POST', `/loans/${created.id}/disbursement`, adminToken, {
    disbursementDate: monthsFromToday(-disbursedMonthsAgo, 10),
  });

  if (disbursed.statusCode !== 200) {
    throw new Error(`Could not disburse the fixture loan: ${disbursed.body}`);
  }
  return disbursed.json<LoanWithSchedule>();
}

const restructure = async (
  loanId: string,
  token: string = adminToken,
  body: Record<string, unknown> = {},
): Promise<InjectResponse> =>
  request('POST', `/loans/${loanId}/restructuring`, token, {
    reason: 'Borrower’s harvest failed; rescheduling over a fresh term.',
    effectiveOn: today(),
    ...body,
  });

describe('the restructured principal', () => {
  it('carries principal, unpaid interest and unpaid penalties, forgiving nothing', async () => {
    const loan = await activeLoan();

    const response = await restructure(loan.id);
    expect(response.statusCode).toBe(201);
    const record = response.json<LoanRestructuring>();

    // The parts are the whole, by construction and by database constraint.
    const parts = Money.sum([
      Money.fromDatabaseValue(record.principalCarried),
      Money.fromDatabaseValue(record.interestCapitalised),
      Money.fromDatabaseValue(record.penaltiesCapitalised),
    ]);
    expect(parts.toDatabaseValue()).toBe(record.newPrincipal);

    // Nothing was dropped on the way across.
    expect(record.principalCarried).toBe(PRINCIPAL);
    expect(Money.fromDatabaseValue(record.interestCapitalised).isPositive()).toBe(true);
    expect(
      Money.fromDatabaseValue(record.newPrincipal).lessThan(Money.fromDatabaseValue(PRINCIPAL)),
    ).toBe(false);
  });

  it('charges interest on the capitalised amount, not merely the old principal', async () => {
    const loan = await activeLoan();
    const record = (await restructure(loan.id)).json<LoanRestructuring>();

    const successor = (
      await request('GET', `/loans/${record.newLoanId}`, officerToken)
    ).json<Loan>();

    // The new loan's principal *is* the capitalised figure, so the schedule
    // generated from it charges interest on the interest and penalties that
    // were rolled in. Using only the old principal as the interest base would
    // quietly forgive the difference.
    expect(successor.principal).toBe(record.newPrincipal);
    expect(successor.outstandingBalance).toBe(record.newPrincipal);
  });
});

describe('the successor', () => {
  it('reuses the original rate and term, and starts fresh', async () => {
    const loan = await activeLoan();
    const record = (await restructure(loan.id)).json<LoanRestructuring>();

    const successor = (
      await request('GET', `/loans/${record.newLoanId}`, officerToken)
    ).json<Loan>();

    expect(successor.monthlyRate).toBe(loan.monthlyRate);
    expect(successor.termMonths).toBe(loan.termMonths);
    expect(successor.status).toBe('active');
    expect(successor.clientId).toBe(loan.clientId);
  });

  it('has a full fresh schedule of its own', async () => {
    const loan = await activeLoan();
    const record = (await restructure(loan.id)).json<LoanRestructuring>();

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM repayment_schedules WHERE loan_id = $1',
        [record.newLoanId],
      ),
    );

    // The term restarts, so the successor has its own ten instalments.
    expect(rows.rows[0]!.count).toBe('10');
  });

  it('starts classified Current rather than inheriting the old delinquency', async () => {
    const loan = await activeLoan();
    const record = (await restructure(loan.id)).json<LoanRestructuring>();

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{ overdue_class: string | null; days_overdue: number | null }>(
        'SELECT overdue_class, days_overdue FROM loans WHERE id = $1',
        [record.newLoanId],
      ),
    );

    // Nothing carries across. Classification from here is computed from the new
    // schedule, which has no instalment yet due.
    expect(rows.rows[0]!.overdue_class).toBeNull();
  });
});

describe('the old loan', () => {
  it('is kept, closed, and marked restructured rather than completed', async () => {
    const loan = await activeLoan();
    await restructure(loan.id);

    const old = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();

    // `completed` would mean repaid, and nobody repaid it.
    expect(old.status).toBe('restructured');
    expect(old.outstandingBalance).toBe('0.00');
  });

  it('keeps its schedule and its payment history', async () => {
    const loan = await activeLoan();
    await restructure(loan.id);

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM repayment_schedules WHERE loan_id = $1',
        [loan.id],
      ),
    );

    expect(rows.rows[0]!.count).toBe('10');
  });

  it('cannot take another ordinary repayment', async () => {
    const loan = await activeLoan();
    await restructure(loan.id);

    const response = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '10000.00',
    });

    // The debt moved. Paying the old loan would credit money against a facility
    // that no longer owes anything, and leave the successor untouched.
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('restructured');
  });

  it('links to its successor, so the pair stays interpretable', async () => {
    const loan = await activeLoan();
    const record = (await restructure(loan.id)).json<LoanRestructuring>();

    expect(record.oldLoanId).toBe(loan.id);
    expect(record.newLoanId).not.toBe(loan.id);
    expect(record.reason).toContain('harvest');
  });
});

describe('eligibility', () => {
  it('refuses a request after the original maturity month', async () => {
    // Disbursed eighteen months ago over ten months, so the agreed term ended
    // about eight months back. Asking today is outside it.
    const loan = await activeLoan(18);

    const response = await restructure(loan.id, adminToken, { effectiveOn: today() });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('original term');
  });

  it('allows a request inside the maturity month itself', async () => {
    const loan = await activeLoan(18);

    // Maturity is ten months after a disbursement eighteen months ago, so the
    // final instalment fell due eight months back. Month granularity, matching
    // settlement: any day of that month counts as within the term.
    const response = await restructure(loan.id, adminToken, {
      effectiveOn: monthsFromToday(-8, 28),
    });

    expect(response.statusCode).toBe(201);
  });

  it('refuses a future-dated restructuring', async () => {
    const loan = await activeLoan();

    expect((await restructure(loan.id, adminToken, { effectiveOn: '2099-01-01' })).statusCode).toBe(
      422,
    );
  });

  it('requires a reason', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/restructuring`, adminToken, {
      effectiveOn: today(),
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a loan that was never disbursed', async () => {
    const created = (
      await request('POST', '/loans', officerToken, {
        clientId,
        productId,
        principal: PRINCIPAL,
        monthlyRate: '0.0200',
        termMonths: 10,
      })
    ).json<Loan>();

    expect((await restructure(created.id)).statusCode).toBe(422);
  });
});

describe('authorisation and isolation', () => {
  it('refuses anyone who is not the Owner/Manager', async () => {
    const loan = await activeLoan();

    // A branch manager approves lending; restructuring changes what a borrower
    // owes without a payment behind it, which is the administrator's authority.
    expect((await restructure(loan.id, managerToken)).statusCode).toBe(403);
    expect((await restructure(loan.id, officerToken)).statusCode).toBe(403);
  });

  it('refuses a loan in another institution, and leaves it untouched', async () => {
    const loan = await activeLoan();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    expect((await restructure(loan.id, await tokenFor(stranger))).statusCode).toBe(404);

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();
    expect(after.status).toBe('active');
  });
});

describe('doing it twice', () => {
  it('refuses a second restructuring of the same loan', async () => {
    const loan = await activeLoan();
    await restructure(loan.id);

    const second = await restructure(loan.id);

    expect(second.statusCode).toBe(409);
  });

  it('lets at most one of two simultaneous requests succeed', async () => {
    const loan = await activeLoan();

    const [a, b] = await Promise.all([restructure(loan.id), restructure(loan.id)]);

    expect([a, b].filter((response) => response.statusCode === 201)).toHaveLength(1);

    const successors = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM loan_restructurings WHERE old_loan_id = $1',
        [loan.id],
      ),
    );

    // Never two successors, and never two live debts for one borrower.
    expect(successors.rows[0]!.count).toBe('1');
  });

  it('leaves the old loan intact when the restructuring is refused', async () => {
    const loan = await activeLoan();
    await restructure(loan.id, managerToken);

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();

    // A refusal is not a partial restructuring: the balance is still owed on
    // the loan that still owes it.
    expect(after.status).toBe('active');
    expect(after.outstandingBalance).toBe(PRINCIPAL);
  });
});
