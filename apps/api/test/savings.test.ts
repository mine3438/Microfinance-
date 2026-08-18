import { randomUUID } from 'node:crypto';

import {
  type Client,
  type CompiledReturn,
  type ErrorResponse,
  type SavingsAccount,
  type SavingsProduct,
  type SavingsTransaction,
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
 * Savings, and the three BOT forms that were reporting nil without it.
 *
 * Two things carry this suite. A savings balance cannot go negative — not a
 * product rule but an accounting one, since a negative balance is an overdraft
 * — and **compulsory savings reaches the return as at the quarter end**, which
 * is what makes restating a past quarter give the figure that quarter had
 * rather than the figure the account has today.
 *
 * Nothing here tests interest, minimum balances or withdrawal limits, because
 * §13.4 has not settled any of them and none of them exist.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let adminToken: string;
let accountantToken: string;
/**
 * `savings.manage` belongs to the branch manager, not the loan officer.
 *
 * The seeded catalogue's decision, kept rather than widened here: taking money
 * over a counter is a different authority from arranging a loan, and changing
 * who holds it is an institution's call.
 */
let managerToken: string;
let clientId: string;
let compulsory: SavingsProduct;
let voluntary: SavingsProduct;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  adminToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']),
  );
  accountantToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['accountant']),
  );
  managerToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']),
  );

  await harness.database.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_health (institution_id, classifications_updated_at)
       VALUES ($1, now())
       ON CONFLICT (institution_id)
       DO UPDATE SET classifications_updated_at = EXCLUDED.classifications_updated_at`,
      [officer.institutionId],
    );
  });

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Rehema Mushi',
      gender: 'female',
      dateOfBirth: '1990-04-12',
      phone: '+255712345678',
      districtCode: 'tz_arusha__karatu',
      sectorCode: 'agriculture',
      branchId: officer.branchId,
    })
  ).json<Client>().id;

  compulsory = (
    await request('POST', '/savings/products', adminToken, {
      code: 'compulsory',
      name: 'Compulsory Savings',
      isCompulsory: true,
    })
  ).json<SavingsProduct>();

  voluntary = (
    await request('POST', '/savings/products', adminToken, {
      code: 'voluntary',
      name: 'Voluntary Savings',
      isCompulsory: false,
    })
  ).json<SavingsProduct>();
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

async function openAccount(productId: string, openedOn = '2026-01-05'): Promise<SavingsAccount> {
  const response = await request('POST', '/savings/accounts', managerToken, {
    clientId,
    branchId: officer.branchId,
    productId,
    openedOn,
  });
  return response.json<SavingsAccount>();
}

const deposit = async (
  accountId: string,
  amount: string,
  transactionDate: string,
): Promise<InjectResponse> =>
  request('POST', `/savings/accounts/${accountId}/transactions`, managerToken, {
    direction: 'deposit',
    amount,
    transactionDate,
  });

const withdraw = async (
  accountId: string,
  amount: string,
  transactionDate: string,
): Promise<InjectResponse> =>
  request('POST', `/savings/accounts/${accountId}/transactions`, managerToken, {
    direction: 'withdrawal',
    amount,
    transactionDate,
  });

describe('POST /savings/products', () => {
  it('records whether a product is BOT compulsory savings', () => {
    // Not a naming convention: the flag decides whether balances appear on
    // three BOT forms or on none.
    expect(compulsory.isCompulsory).toBe(true);
    expect(voluntary.isCompulsory).toBe(false);
  });

  it('refuses a caller without settings.manage', async () => {
    const response = await request('POST', '/savings/products', officerToken, {
      code: 'another',
      name: 'Another Product',
      isCompulsory: false,
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('savings entries', () => {
  it('moves the balance and records what each entry left behind', async () => {
    const account = await openAccount(voluntary.id);

    await deposit(account.id, '150000.00', '2026-02-01');
    const second = await deposit(account.id, '75000.50', '2026-02-14');

    expect(second.statusCode).toBe(201);
    expect(second.json<SavingsTransaction>().balanceAfter).toBe('225000.50');

    const reread = await request('GET', `/savings/accounts/${account.id}`, officerToken);
    expect(reread.json<SavingsAccount>().balance).toBe('225000.50');
  });

  it('keeps the cent across entries a double would not', async () => {
    const account = await openAccount(voluntary.id);

    for (const amount of ['0.10', '0.20', '0.30']) {
      await deposit(account.id, amount, '2026-02-01');
    }

    const reread = await request('GET', `/savings/accounts/${account.id}`, officerToken);
    expect(reread.json<SavingsAccount>().balance).toBe('0.60');
  });

  it('refuses a withdrawal that would overdraw the account', async () => {
    const account = await openAccount(voluntary.id);
    await deposit(account.id, '20000.00', '2026-02-01');

    const response = await withdraw(account.id, '20000.01', '2026-02-02');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('overdrawn');
  });

  it('allows a withdrawal that empties the account exactly', async () => {
    const account = await openAccount(voluntary.id);
    await deposit(account.id, '20000.00', '2026-02-01');

    const response = await withdraw(account.id, '20000.00', '2026-02-02');

    expect(response.statusCode).toBe(201);
    expect(response.json<SavingsTransaction>().balanceAfter).toBe('0.00');
  });

  it('refuses an entry dated before the account existed', async () => {
    const account = await openAccount(voluntary.id, '2026-03-01');

    const response = await deposit(account.id, '1000.00', '2026-02-28');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('opened on 2026-03-01');
  });

  it('refuses an entry dated in the future', async () => {
    const account = await openAccount(voluntary.id);

    const response = await deposit(account.id, '1000.00', '2099-01-01');

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('future');
  });

  it('corrects a mistake by reversing it, leaving both on the statement', async () => {
    const account = await openAccount(voluntary.id);
    const wrong = (await deposit(account.id, '999999.00', '2026-02-01')).json<SavingsTransaction>();

    const reversal = await request(
      `POST`,
      `/savings/transactions/${wrong.id}/reversal`,
      managerToken,
      { reversedOn: '2026-02-03', narrative: 'Keyed against the wrong account.' },
    );

    expect(reversal.statusCode).toBe(201);
    expect(reversal.json<SavingsTransaction>().direction).toBe('withdrawal');
    expect(reversal.json<SavingsTransaction>().balanceAfter).toBe('0.00');

    const statement = (
      await request('GET', `/savings/accounts/${account.id}/transactions`, officerToken)
    ).json<SavingsTransaction[]>();
    // Both entries, not one edited entry.
    expect(statement).toHaveLength(2);
  });

  it('refuses to reverse the same entry twice', async () => {
    const account = await openAccount(voluntary.id);
    const entry = (await deposit(account.id, '5000.00', '2026-02-01')).json<SavingsTransaction>();
    const body = { reversedOn: '2026-02-02', narrative: 'Duplicate.' };

    await request('POST', `/savings/transactions/${entry.id}/reversal`, managerToken, body);
    const second = await request(
      'POST',
      `/savings/transactions/${entry.id}/reversal`,
      managerToken,
      body,
    );

    expect(second.statusCode).toBe(409);
  });
});

describe('compulsory savings on the return', () => {
  it('reaches MSP2-10 by the saver’s district and MSP2-01 by rule 16', async () => {
    const account = await openAccount(compulsory.id);
    await deposit(account.id, '400000.00', '2026-02-10');

    const compiled = (
      await request('GET', '/reports/msp2/2026/1', accountantToken)
    ).json<CompiledReturn>();

    const karatu = compiled.msp2_10.districts.find(
      (row) => row.districtCode === 'tz_arusha__karatu',
    );
    expect(karatu?.compulsorySavings).toBe('400000.00');
    expect(compiled.msp2_10.grandTotal.compulsorySavings).toBe('400000.00');

    // Sno46 is derived from MSP2-10's grand total, which is what makes BOT's
    // rule 16 hold by construction rather than by agreement.
    const sno46 = compiled.msp2_01.rows.find((row) => row.sno === 46);
    expect(sno46?.amount).toBe('400000.00');
    expect(sno46?.source).toBe('derived');
  });

  it('reports the balance as at the quarter end, not as at today', async () => {
    const account = await openAccount(compulsory.id);
    await deposit(account.id, '100000.00', '2026-05-02');

    // The deposit lands in Q2, so Q1 must not see it — restating a filed
    // quarter has to give the figure that quarter had.
    const first = (
      await request('GET', '/reports/msp2/2026/1', accountantToken)
    ).json<CompiledReturn>();
    const second = (
      await request('GET', '/reports/msp2/2026/2', accountantToken)
    ).json<CompiledReturn>();

    // Compared as exact decimals, not by parsing the strings into doubles —
    // the same rule the figures themselves are held to.
    const moved = Money.of(second.msp2_10.grandTotal.compulsorySavings).minus(
      Money.of(first.msp2_10.grandTotal.compulsorySavings),
    );
    expect(moved.toString()).toBe('100000.00');
  });

  it('leaves voluntary savings off the return entirely', async () => {
    const compile = async (): Promise<string> => {
      const response = await request('GET', '/reports/msp2/2026/2', accountantToken);
      return response.json<CompiledReturn>().msp2_10.grandTotal.compulsorySavings;
    };

    const before = await compile();

    const account = await openAccount(voluntary.id, '2026-05-01');
    await deposit(account.id, '850000.00', '2026-05-20');

    const after = await compile();

    // BOT asks for compulsory savings specifically. Voluntary balances are a
    // liability the institution has, but not this line of the form.
    expect(after).toBe(before);
  });
});

describe('compulsory savings as security', () => {
  /**
   * A sanctioning limit for the branch manager.
   *
   * `approval_thresholds` is seeded empty on purpose — §13.3's figures belong to
   * the institution and inventing a default would be inventing a lending policy
   * — and the absence of a row means no authority rather than unlimited
   * authority. So a suite that needs a loan approved has to state a limit.
   */
  async function allowApprovalsUpTo(amount: string): Promise<void> {
    await harness.database.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'branch_manager', $2)
         ON CONFLICT (institution_id, role_code)
         DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [officer.institutionId, amount],
      );
    });
  }

  /** A disbursed loan for the seeded client, so MSP2-03 has something to net. */
  async function disbursedLoan(principal: string): Promise<string> {
    await allowApprovalsUpTo('10000000.00');

    const productId = await harness.database.withTransaction(async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal)
         VALUES ($1, $2, 'Savings Suite Product', 'agriculture_loans', 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [officer.institutionId, `SAV${randomUUID().slice(0, 5)}`],
      );
      return row.rows[0]!.id;
    });

    const loan = (
      await request('POST', '/loans', officerToken, {
        clientId,
        productId,
        principal,
        monthlyRate: '0.0200',
        termMonths: 6,
      })
    ).json<{ id: string }>();

    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });
    await request('POST', `/loans/${loan.id}/disbursement`, adminToken, {
      disbursementDate: '2026-02-02',
    });

    return loan.id;
  }

  it('refuses to secure more than the borrower actually holds', async () => {
    const account = await openAccount(compulsory.id, '2026-02-01');
    await deposit(account.id, '30000.00', '2026-02-01');
    const loanId = await disbursedLoan('500000.00');

    const response = await request('PUT', `/loans/${loanId}/collateral`, officerToken, {
      compulsorySavingsSecured: '5000000.00',
    });

    // A cross-row invariant, so a database trigger rather than a check in a use
    // case: two loans claiming the same shilling would make MSP2-03 deduct it
    // twice, and a read-then-write check would race.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('deducts the security from the sector’s provision on MSP2-03', async () => {
    const account = await openAccount(compulsory.id, '2026-02-01');
    await deposit(account.id, '900000.00', '2026-02-01');
    const loanId = await disbursedLoan('600000.00');

    const secured = await request('PUT', `/loans/${loanId}/collateral`, officerToken, {
      compulsorySavingsSecured: '20000.00',
    });
    expect(secured.statusCode).toBe(200);

    const compiled = (
      await request('GET', '/reports/msp2/2026/1', accountantToken)
    ).json<CompiledReturn>();

    const agriculture = compiled.msp2_03.rows.find((row) => row.sectorCode === 'agriculture');
    expect(agriculture?.collateral).toBe('20000.00');
    // Net provision is the gross less the security, floored at zero — the
    // deduction BOT's form asks for, which was nil before §24.1 settled where
    // compulsory savings attaches.
    expect(Money.of(agriculture?.netProvision ?? '0').toString()).toBe(
      Money.max(
        Money.of(agriculture?.grossProvision ?? '0').minus(Money.of('20000.00')),
        Money.zero(),
      ).toString(),
    );
  });
});

describe('GET /savings/accounts', () => {
  it('does not serve another institution’s accounts', async () => {
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });

    const response = await request('GET', '/savings/accounts', await tokenFor(outsider));

    expect(response.json<{ items: SavingsAccount[] }>().items).toHaveLength(0);
  });
});

describe('PATCH /savings/products/:id', () => {
  /** A product of this test's own, so closing it disturbs no other suite. */
  const freshProduct = async (code: string): Promise<SavingsProduct> =>
    (
      await request('POST', '/savings/products', adminToken, {
        code,
        name: `Product ${code}`,
        isCompulsory: false,
      })
    ).json<SavingsProduct>();

  it('closes a product to new accounts', async () => {
    const product = await freshProduct(`close-${Date.now().toString(36)}`);

    const closed = await request('PATCH', `/savings/products/${product.id}`, adminToken, {
      status: 'closed',
    });

    expect(closed.statusCode).toBe(200);
    expect(closed.json<SavingsProduct>().status).toBe('closed');
  });

  it('refuses an account against a closed product — the server, not the browser', async () => {
    // This rule lived only in the web client's product filter until now. A
    // caller not using that browser simply did not have it.
    const product = await freshProduct(`refuse-${Date.now().toString(36)}`);
    await request('PATCH', `/savings/products/${product.id}`, adminToken, { status: 'closed' });

    const response = await request('POST', '/savings/accounts', managerToken, {
      clientId,
      branchId: officer.branchId,
      productId: product.id,
      openedOn: '2026-01-05',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('closed to new accounts');
  });

  it('leaves accounts already open against it untouched', async () => {
    // Their balances still report on MSP2-01 Sno46 and MSP2-10. Making real
    // money vanish from a return because a product was withdrawn would be a
    // misstatement, not a tidy-up.
    const product = await freshProduct(`keep-${Date.now().toString(36)}`);
    const opened = await openAccount(product.id);
    await deposit(opened.id, '75000.00', '2026-01-10');

    await request('PATCH', `/savings/products/${product.id}`, adminToken, { status: 'closed' });

    const after = await request('GET', `/savings/accounts/${opened.id}`, managerToken);
    expect(after.statusCode).toBe(200);
    expect(after.json<SavingsAccount>().balance).toBe('75000.00');
    expect(after.json<SavingsAccount>().status).toBe('active');
  });

  it('reopens a product that was closed by mistake', async () => {
    const product = await freshProduct(`reopen-${Date.now().toString(36)}`);
    await request('PATCH', `/savings/products/${product.id}`, adminToken, { status: 'closed' });

    const reopened = await request('PATCH', `/savings/products/${product.id}`, adminToken, {
      status: 'active',
    });

    expect(reopened.json<SavingsProduct>().status).toBe('active');

    const account = await request('POST', '/savings/accounts', managerToken, {
      clientId,
      branchId: officer.branchId,
      productId: product.id,
      openedOn: '2026-01-05',
    });
    expect(account.statusCode).toBe(201);
  });

  it('refuses a caller without settings.manage', async () => {
    const response = await request('PATCH', `/savings/products/${voluntary.id}`, officerToken, {
      status: 'closed',
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses a status the column does not have', async () => {
    const response = await request('PATCH', `/savings/products/${voluntary.id}`, adminToken, {
      status: 'dormant',
    });

    expect(response.statusCode).toBe(400);
  });
});
