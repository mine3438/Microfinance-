import { randomUUID } from 'node:crypto';

import {
  type ErrorResponse,
  type Loan,
  type LoanRecovery,
  type LoanWriteOff,
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
 * Writing a loan off, and recovering against one.
 *
 * Both rules are the institution's, approved and recorded in
 * `04-DECISION-REGISTER.md` as WRITEOFF-01 and RECOVERY-01. Nothing here infers
 * any part of them.
 *
 * The two properties most worth guarding are negative ones. A write-off must not
 * erase what was written off merely because the live balance became zero. And a
 * recovery must not behave like a repayment — not reinstate the loan, not
 * recreate principal, and not reach MSP2-02 through the repayment path, because
 * the same cash on two lines is the failure that makes a return unreconcilable.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let managerToken: string;
let adminToken: string;
let admin: SeededUser;
let productId: string;
let clientId: string;

const PRINCIPAL = '1000000.00';

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  managerToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']),
  );
  admin = await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']);
  adminToken = await tokenFor(admin);

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
         VALUES ($1, 'WOF', 'Write-off Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Joseph Mollel',
      gender: 'male',
      dateOfBirth: '1979-11-30',
      phone: '0716444555',
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

/** A loan carried to active, ready to be written off. */
async function activeLoan(): Promise<Loan> {
  const created = (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal: PRINCIPAL,
      monthlyRate: '0.0200',
      termMonths: 10,
    })
  ).json<Loan>();

  await request('POST', `/loans/${created.id}/submit`, officerToken);
  await request('POST', `/loans/${created.id}/decision`, managerToken, { decision: 'approve' });
  const disbursed = await request('POST', `/loans/${created.id}/disbursement`, adminToken, {
    disbursementDate: '2026-01-10',
  });

  if (disbursed.statusCode !== 200) {
    throw new Error(`Could not disburse the fixture loan: ${disbursed.body}`);
  }
  return created;
}

/** A loan already written off, for the recovery tests. */
async function writtenOffLoan(): Promise<Loan> {
  const loan = await activeLoan();
  const written = await request('POST', `/loans/${loan.id}/write-off`, adminToken, {
    reason: 'Borrower untraceable after eighteen months; no assets located.',
  });
  expect(written.statusCode).toBe(201);
  return loan;
}

describe('POST /loans/:id/write-off', () => {
  it('records what was written off, and who decided it', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/write-off`, adminToken, {
      reason: 'Business closed; no recoverable assets.',
    });

    expect(response.statusCode).toBe(201);
    const written = response.json<LoanWriteOff>();

    expect(written.totalWrittenOff).toBe(PRINCIPAL);
    expect(written.principalWrittenOff).toBe(PRINCIPAL);
    expect(written.penaltyWrittenOff).toBe('0.00');
    expect(written.approvedBy).toBe(admin.userId);
    expect(written.reason).toContain('Business closed');
  });

  it('zeroes the live balance and closes the loan', async () => {
    const loan = await activeLoan();
    await request('POST', `/loans/${loan.id}/write-off`, adminToken, {
      reason: 'Unrecoverable.',
    });

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();

    expect(after.status).toBe('written_off');
    expect(after.outstandingBalance).toBe('0.00');
  });

  it('keeps the amount written off even though the balance is now zero', async () => {
    // The property the whole table exists for. Without it, "how much did we
    // write off last quarter" has no answer, and MSP2-02's bad-debts line has
    // no source.
    const loan = await activeLoan();
    await request('POST', `/loans/${loan.id}/write-off`, adminToken, { reason: 'Unrecoverable.' });

    const written = (
      await request('GET', `/loans/${loan.id}/write-off`, officerToken)
    ).json<LoanWriteOff>();

    expect(Money.fromDatabaseValue(written.totalWrittenOff).isPositive()).toBe(true);
    expect(written.totalWrittenOff).toBe(PRINCIPAL);
  });

  it('refuses a caller who is not the Owner/Manager', async () => {
    const loan = await activeLoan();

    // `loan.write_off` is held by institution_admin alone. A branch manager
    // runs a branch and approves lending; disposing of an asset is not theirs.
    expect(
      (
        await request('POST', `/loans/${loan.id}/write-off`, managerToken, {
          reason: 'Unrecoverable.',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await request('POST', `/loans/${loan.id}/write-off`, officerToken, {
          reason: 'Unrecoverable.',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('requires a reason', async () => {
    const loan = await activeLoan();

    expect((await request('POST', `/loans/${loan.id}/write-off`, adminToken, {})).statusCode).toBe(
      400,
    );
    expect(
      (await request('POST', `/loans/${loan.id}/write-off`, adminToken, { reason: '   ' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses a second write-off of the same loan', async () => {
    const loan = await writtenOffLoan();

    const second = await request('POST', `/loans/${loan.id}/write-off`, adminToken, {
      reason: 'Again.',
    });

    expect(second.statusCode).toBe(409);
    expect(second.json<ErrorResponse>().error.message).toContain('already been written off');
  });

  it('refuses to write off an application that was never disbursed', async () => {
    const created = (
      await request('POST', '/loans', officerToken, {
        clientId,
        productId,
        principal: PRINCIPAL,
        monthlyRate: '0.0200',
        termMonths: 10,
      })
    ).json<Loan>();

    const response = await request('POST', `/loans/${created.id}/write-off`, adminToken, {
      reason: 'Unrecoverable.',
    });

    // Writing off an application is writing off money that was never advanced.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a loan belonging to another institution', async () => {
    const loan = await activeLoan();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await request(
      'POST',
      `/loans/${loan.id}/write-off`,
      await tokenFor(stranger),
      { reason: 'Unrecoverable.' },
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('a written-off loan stops behaving like a live one', () => {
  it('refuses an ordinary repayment', async () => {
    const loan = await writtenOffLoan();

    const response = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '10000.00',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('written_off');
  });

  it('accrues no further penalty', async () => {
    const loan = await writtenOffLoan();

    await request('POST', '/penalties/accrual', adminToken, { asAt: '2027-06-30' });

    const balances = await harness.database.withTransaction(async (client) =>
      client.query<{ penalty_balance: string; outstanding_balance: string }>(
        'SELECT penalty_balance, outstanding_balance FROM loans WHERE id = $1',
        [loan.id],
      ),
    );

    // The accrual charges an increment against a live balance and there is no
    // longer one. Asserted rather than assumed, because a penalty appearing on
    // a written-off loan would recreate a debt the institution has disposed of.
    expect(balances.rows[0]!.penalty_balance).toBe('0.00');
    expect(balances.rows[0]!.outstanding_balance).toBe('0.00');
  });
});

describe('POST /loans/:id/recoveries', () => {
  it('records money received after a write-off', async () => {
    const loan = await writtenOffLoan();

    const response = await request('POST', `/loans/${loan.id}/recoveries`, officerToken, {
      amount: '150000.00',
      recoveredOn: '2026-06-15',
      method: 'Cash at branch',
      reference: 'RCT-4471',
    });

    expect(response.statusCode).toBe(201);
    const recovery = response.json<LoanRecovery>();
    expect(recovery.amount).toBe('150000.00');
    expect(recovery.method).toBe('Cash at branch');
    expect(recovery.recordedBy).toBe(officer.userId);
  });

  it('leaves the loan written off with a zero balance', async () => {
    const loan = await writtenOffLoan();
    await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '150000.00' });

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();

    // The approved rule, stated three ways because each is a separate way of
    // getting it wrong: no reinstatement, no recreated principal, no reopened
    // schedule.
    expect(after.status).toBe('written_off');
    expect(after.outstandingBalance).toBe('0.00');
  });

  it('accepts partial and repeated recoveries', async () => {
    const loan = await writtenOffLoan();

    await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '100000.00' });
    await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '50000.00' });
    await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '25000.00' });

    const listed = (await request('GET', `/loans/${loan.id}/recoveries`, officerToken)).json<
      LoanRecovery[]
    >();

    expect(listed).toHaveLength(3);
    const total = Money.sum(listed.map((entry) => Money.fromDatabaseValue(entry.amount)));
    expect(total.toDatabaseValue()).toBe('175000.00');
  });

  it('does not create a payment, so the same cash cannot be counted twice', async () => {
    const loan = await writtenOffLoan();
    await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '150000.00' });

    const payments = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM payments WHERE loan_id = $1',
        [loan.id],
      ),
    );

    // The separation is structural rather than remembered: recoveries live in
    // their own table and reach MSP2-02 by their own line. A recovery that also
    // wrote a payment row would be reported as interest and principal *and* as
    // recovery income.
    expect(payments.rows[0]!.count).toBe('0');
  });

  it('refuses a recovery against a live loan', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/recoveries`, officerToken, {
      amount: '50000.00',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('written-off');
  });

  it('refuses a zero or negative amount', async () => {
    const loan = await writtenOffLoan();

    expect(
      (await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '0.00' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await request('POST', `/loans/${loan.id}/recoveries`, officerToken, { amount: '-100.00' }))
        .statusCode,
    ).toBe(400);
  });

  it('refuses a future-dated recovery', async () => {
    const loan = await writtenOffLoan();

    const response = await request('POST', `/loans/${loan.id}/recoveries`, officerToken, {
      amount: '1000.00',
      recoveredOn: '2099-01-01',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a loan belonging to another institution', async () => {
    const loan = await writtenOffLoan();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await request(
      'POST',
      `/loans/${loan.id}/recoveries`,
      await tokenFor(stranger),
      { amount: '1000.00' },
    );

    expect(response.statusCode).toBe(404);
  });
});
