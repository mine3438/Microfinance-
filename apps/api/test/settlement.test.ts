import { randomUUID } from 'node:crypto';

import {
  type ErrorResponse,
  type Loan,
  type LoanWithSchedule,
  type SettlementQuote,
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
 * Settling a loan before maturity.
 *
 * The arithmetic is proved in `packages/domain` — month granularity, no
 * discount, penalties payable, interest already paid credited. What this suite
 * proves is that the arithmetic actually governs the money: that the loan
 * closes for the quoted figure, that future interest is never charged, and that
 * the operation cannot be reached twice.
 *
 * The one that matters most is the comparison against an ordinary repayment. A
 * settlement and a large payment of the same amount split differently on
 * purpose, because the allocator owes itself the whole remaining scheduled
 * interest and the settlement rule does not.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let managerToken: string;
let adminToken: string;
let productId: string;
let clientId: string;

const PRINCIPAL = '1200000.00';
const DISBURSED_ON = '2026-01-10';

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
         VALUES ($1, 'SET', 'Settlement Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Rehema Paul',
      gender: 'female',
      dateOfBirth: '1987-09-09',
      phone: '0716888999',
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

/** A ten-month loan, disbursed, ready to settle. */
async function activeLoan(): Promise<LoanWithSchedule> {
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
    disbursementDate: DISBURSED_ON,
  });

  if (disbursed.statusCode !== 200) {
    throw new Error(`Could not disburse the fixture loan: ${disbursed.body}`);
  }
  return disbursed.json<LoanWithSchedule>();
}

const quoteOn = async (loanId: string, date: string): Promise<SettlementQuote> =>
  (
    await request('GET', `/loans/${loanId}/settlement/quote?settlementDate=${date}`, officerToken)
  ).json<SettlementQuote>();

describe('the settlement quote', () => {
  it('is the same on the first, middle and last day of a month', async () => {
    const loan = await activeLoan();

    const first = await quoteOn(loan.id, '2026-08-01');
    const middle = await quoteOn(loan.id, '2026-08-10');
    const last = await quoteOn(loan.id, '2026-08-31');

    // The approved rule end to end: month granularity, never prorated by day.
    expect(middle.total).toBe(first.total);
    expect(last.total).toBe(first.total);
    expect(first.chargedThrough).toBe('2026-08-31');
  });

  it('charges less the earlier it is settled, and reports what is not charged', async () => {
    const loan = await activeLoan();

    const july = await quoteOn(loan.id, '2026-07-15');
    const august = await quoteOn(loan.id, '2026-08-15');

    expect(
      Money.fromDatabaseValue(july.total).lessThan(Money.fromDatabaseValue(august.total)),
    ).toBe(true);
    // Settling a month earlier leaves a month more uncharged.
    expect(
      Money.fromDatabaseValue(august.interestNotCharged).lessThan(
        Money.fromDatabaseValue(july.interestNotCharged),
      ),
    ).toBe(true);
  });

  it('is exactly principal plus interest plus penalty', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');

    const parts = Money.sum([
      Money.fromDatabaseValue(quote.principal),
      Money.fromDatabaseValue(quote.interest),
      Money.fromDatabaseValue(quote.penalty),
    ]);

    // No discount, and nothing else folded in — in particular not the
    // TZS 5,000 application fee, which never became a loan balance.
    expect(parts.toDatabaseValue()).toBe(quote.total);
    expect(quote.principal).toBe(PRINCIPAL);
  });

  it('refuses a quote for a loan that was never disbursed', async () => {
    const created = (
      await request('POST', '/loans', officerToken, {
        clientId,
        productId,
        principal: PRINCIPAL,
        monthlyRate: '0.0200',
        termMonths: 10,
      })
    ).json<Loan>();

    expect(
      (await request('GET', `/loans/${created.id}/settlement/quote`, officerToken)).statusCode,
    ).toBe(422);
  });

  it('refuses a loan in another institution', async () => {
    const loan = await activeLoan();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    expect(
      (await request('GET', `/loans/${loan.id}/settlement/quote`, await tokenFor(stranger)))
        .statusCode,
    ).toBe(404);
  });
});

describe('settling', () => {
  it('closes the loan for exactly the quoted figure', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');

    const settled = await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: quote.total,
      settlementDate: '2026-08-10',
    });

    expect(settled.statusCode).toBe(201);

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();
    expect(after.status).toBe('completed');
    expect(after.outstandingBalance).toBe('0.00');
  });

  it('records the settlement as a payment, so the interest is reported', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: quote.total,
      settlementDate: '2026-08-10',
    });

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{
        amount_paid: string;
        interest_portion: string;
        principal_portion: string;
        fee_portion: string;
      }>(
        `SELECT amount_paid, interest_portion, principal_portion, fee_portion
           FROM payments WHERE loan_id = $1`,
        [loan.id],
      ),
    );

    // MSP2-02 sums interest income from `payments.interest_portion`. A
    // settlement recorded anywhere else would take the money and report none of
    // it as interest.
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.amount_paid).toBe(quote.total);
    expect(rows.rows[0]!.interest_portion).toBe(quote.interest);
    expect(rows.rows[0]!.principal_portion).toBe(quote.principal);
    // The application fee is not part of a settlement.
    expect(rows.rows[0]!.fee_portion).toBe('0.00');
  });

  it('charges less than an ordinary repayment of the whole schedule would', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');

    const schedule = loan.schedule;
    if (schedule === null) {
      throw new Error('A disbursed loan must have a schedule.');
    }

    const scheduledTotal = Money.fromDatabaseValue(schedule.totalRepayable);

    // This is the whole reason settlement is its own operation. Paying the
    // scheduled total would hand over every month's interest; settling in
    // August charges August and stops.
    expect(Money.fromDatabaseValue(quote.total).lessThan(scheduledTotal)).toBe(true);
    expect(Money.fromDatabaseValue(quote.interestNotCharged).isPositive()).toBe(true);
  });

  it('leaves the schedule in place as history', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: quote.total,
      settlementDate: '2026-08-10',
    });

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM repayment_schedules WHERE loan_id = $1',
        [loan.id],
      ),
    );

    // Instalments after the settlement month keep their interest as history.
    // Nothing pays them and nothing deletes them.
    expect(rows.rows[0]!.count).toBe('10');
  });

  it('refuses an amount that does not match the quote', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    const short = Money.fromDatabaseValue(quote.total).minus(Money.of('1')).toDatabaseValue();

    const response = await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: short,
      settlementDate: '2026-08-10',
    });

    // A miscount at the counter becomes a message rather than a loan closed
    // with a shortfall nobody notices.
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain(quote.total);
  });

  it('refuses a second settlement of the same loan', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: quote.total,
      settlementDate: '2026-08-10',
    });

    const second = await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: quote.total,
      settlementDate: '2026-08-10',
    });

    expect(second.statusCode).toBe(409);
  });

  it('lets at most one of two simultaneous settlements succeed', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    const body = { amountPaid: quote.total, settlementDate: '2026-08-10' };

    const [a, b] = await Promise.all([
      request('POST', `/loans/${loan.id}/settlement`, officerToken, body),
      request('POST', `/loans/${loan.id}/settlement`, officerToken, body),
    ]);

    // The closing UPDATE is conditional on the loan still being active, so the
    // two contend on the write.
    expect([a, b].filter((response) => response.statusCode === 201)).toHaveLength(1);

    const payments = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM payments WHERE loan_id = $1',
        [loan.id],
      ),
    );
    expect(payments.rows[0]!.count).toBe('1');
  });

  it('refuses a future-dated settlement', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/settlement`, officerToken, {
      amountPaid: '1.00',
      settlementDate: '2099-01-01',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller who cannot take money', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    const auditor = await seedUserIn(officer.institutionId, officer.branchId, ['auditor']);

    expect(
      (
        await request('POST', `/loans/${loan.id}/settlement`, await tokenFor(auditor), {
          amountPaid: quote.total,
          settlementDate: '2026-08-10',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('refuses settling another institution’s loan', async () => {
    const loan = await activeLoan();
    const quote = await quoteOn(loan.id, '2026-08-10');
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await request(
      'POST',
      `/loans/${loan.id}/settlement`,
      await tokenFor(stranger),
      { amountPaid: quote.total, settlementDate: '2026-08-10' },
    );

    expect(response.statusCode).toBe(404);

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();
    expect(after.status).toBe('active');
  });
});
