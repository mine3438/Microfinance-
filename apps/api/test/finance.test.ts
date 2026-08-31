import { randomUUID } from 'node:crypto';

import {
  type BankAccount,
  type BankAccountBalance,
  type ErrorResponse,
  type FinanceEntry,
  type FinancialInstitution,
  type Msp2_02Line,
  type Page,
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
 * Income, expenditure, and the balances an institution holds elsewhere.
 *
 * The property worth most here is that a category cannot be invented. BOT's
 * MSP2-02 has forty-two numbered lines, and the ones it computes take no
 * entries at all — so the tests below try to record against a subtotal, on the
 * wrong side of the statement, and against a line that does not exist, and
 * expect each to be refused with a message naming the field.
 */

let harness: Harness;
let accountant: SeededUser;
let accountantToken: string;
let officer: SeededUser;
let officerToken: string;

/** Sno24 is "Managements' Salaries and Benefits". */
const SALARIES = 24;
/** Sno2 is "Interest - Loans to Clients". */
const INTEREST_INCOME = 2;
/** Sno23 is the non-interest expense subtotal, which BOT computes. */
const EXPENSE_SUBTOTAL = 23;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  accountant = await seedUserIn(officer.institutionId, ['accountant']);
  accountantToken = await tokenFor(accountant);
});

afterAll(async () => {
  await harness.close();
});

async function seedUserIn(institutionId: string, roles: readonly string[]): Promise<SeededUser> {
  const email = `staff.${randomUUID().slice(0, 8)}@seed.test`;
  const passwordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

  return harness.database.withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Staff', $4, 'active') RETURNING id`,
      [institutionId, officer.branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await client.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, userId, role],
      );
    }
    return {
      institutionId,
      branchId: officer.branchId,
      userId,
      email,
      password: DEFAULT_TEST_PASSWORD,
    };
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

const recordEntry = async (
  body: Record<string, unknown>,
  token = accountantToken,
): Promise<InjectResponse> => request('POST', '/finance/entries', token, body);

describe('GET /reference/msp2-02-lines', () => {
  it('serves BOT’s taxonomy so no client has to keep a copy', async () => {
    const lines = (await request('GET', '/reference/msp2-02-lines', accountantToken)).json<
      Msp2_02Line[]
    >();

    expect(lines).toHaveLength(42);

    // Every entered line names a side, and every computed one names none. A
    // client builds its category list from exactly this.
    const computed = lines.filter((line) => line.isComputed);
    expect(computed).toHaveLength(7);
    expect(computed.every((line) => line.entryDirection === null)).toBe(true);
    expect(
      lines.filter((line) => !line.isComputed).every((line) => line.entryDirection !== null),
    ).toBe(true);
  });
});

describe('POST /finance/entries', () => {
  it('records an expense against the BOT line it reports on', async () => {
    const response = await recordEntry({
      direction: 'expense',
      sno: SALARIES,
      amount: '2400000.00',
      entryDate: '2026-02-15',
      description: 'February payroll',
    });

    expect(response.statusCode).toBe(201);

    const entry = response.json<FinanceEntry>();
    expect(entry.sno).toBe(SALARIES);
    // The line's own label travels with the entry, so a list is readable
    // without a second call and without a second copy of the taxonomy.
    expect(entry.lineLabel).toContain('Salaries');
  });

  it('refuses an entry against a line BOT computes, naming the field', async () => {
    const response = await recordEntry({
      direction: 'expense',
      sno: EXPENSE_SUBTOTAL,
      amount: '100000.00',
      entryDate: '2026-02-15',
    });
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(400);
    expect(body.error.details?.[0]?.path).toEqual(['sno']);
    // A foreign-key violation would say only that a key did not match. This
    // says what the line is and what to do instead.
    expect(body.error.message).toContain('counted twice');
  });

  it('refuses an expense recorded against an income line', async () => {
    const response = await recordEntry({
      direction: 'expense',
      sno: INTEREST_INCOME,
      amount: '100000.00',
      entryDate: '2026-02-15',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.path).toEqual(['sno']);
  });

  it('refuses a line BOT does not publish', async () => {
    const response = await recordEntry({
      direction: 'expense',
      sno: 99,
      amount: '100000.00',
      entryDate: '2026-02-15',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toContain('does not publish');
  });

  it('refuses an amount sent as a JSON number', async () => {
    // The refusal explains itself: by the time a number reaches JSON the
    // precision is already gone and is not detectable.
    const response = await recordEntry({
      direction: 'expense',
      sno: SALARIES,
      amount: 2400000,
      entryDate: '2026-02-15',
    });

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('binary');
  });

  it('refuses a caller without expense.manage', async () => {
    const response = await recordEntry(
      { direction: 'expense', sno: SALARIES, amount: '1000.00', entryDate: '2026-02-15' },
      officerToken,
    );

    expect(response.statusCode).toBe(403);
  });
});

describe('PATCH /finance/entries/:id', () => {
  it('reclassifies an entry onto another line of the same side', async () => {
    const entry = (
      await recordEntry({
        direction: 'expense',
        sno: SALARIES,
        amount: '500000.00',
        entryDate: '2026-01-20',
      })
    ).json<FinanceEntry>();

    // Sno36 is "License Fees". Moving a cost between two BOT lines is ordinary
    // bookkeeping, which is why entries are editable where payments are not.
    const amended = await request('PATCH', `/finance/entries/${entry.id}`, accountantToken, {
      sno: 36,
    });

    expect(amended.statusCode).toBe(200);
    expect(amended.json<FinanceEntry>().sno).toBe(36);
  });

  it('checks the line and direction as the pair they will become', async () => {
    const entry = (
      await recordEntry({
        direction: 'expense',
        sno: SALARIES,
        amount: '500000.00',
        entryDate: '2026-01-20',
      })
    ).json<FinanceEntry>();

    // Only the line is being changed, to an income line. Checked against the
    // direction the row already has rather than against whichever half of the
    // pair happened to be sent.
    const amended = await request('PATCH', `/finance/entries/${entry.id}`, accountantToken, {
      sno: INTEREST_INCOME,
    });

    expect(amended.statusCode).toBe(400);
  });

  it('refuses a change that names no field', async () => {
    const entry = (
      await recordEntry({
        direction: 'expense',
        sno: SALARIES,
        amount: '500000.00',
        entryDate: '2026-01-20',
      })
    ).json<FinanceEntry>();

    const amended = await request('PATCH', `/finance/entries/${entry.id}`, accountantToken, {});

    expect(amended.statusCode).toBe(400);
  });
});

describe('GET /finance/entries', () => {
  it('filters by direction and by date range', async () => {
    await recordEntry({
      direction: 'income',
      sno: INTEREST_INCOME,
      amount: '750000.00',
      entryDate: '2026-06-15',
    });

    const page = (
      await request(
        'GET',
        '/finance/entries?direction=income&from=2026-06-01&to=2026-06-30',
        accountantToken,
      )
    ).json<Page<FinanceEntry>>();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((entry) => entry.direction === 'income')).toBe(true);
    expect(page.items.every((entry) => entry.entryDate >= '2026-06-01')).toBe(true);
  });

  it('refuses a range that ends before it starts', async () => {
    const response = await request(
      'GET',
      '/finance/entries?from=2026-06-30&to=2026-06-01',
      accountantToken,
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /finance/bank-accounts', () => {
  const openAccount = async (body: Record<string, unknown>): Promise<InjectResponse> =>
    request('POST', '/finance/bank-accounts', accountantToken, body);

  it('opens an account against a bank BOT publishes', async () => {
    const response = await openAccount({
      holdingKind: 'bank_tanzania',
      institutionCode: 'crdb_bank_plc',
    });

    expect(response.statusCode).toBe(201);

    const account = response.json<BankAccount>();
    expect(account.counterparty).toBe('CRDB BANK PLC');
    // Eligibility follows BOT's list, not the caller: it is never sent.
    expect(account.supportsAgentBanking).toBe(true);
  });

  it('names a counterparty BOT publishes no list for', async () => {
    const response = await openAccount({
      holdingKind: 'microfinance_service_provider',
      counterpartyName: 'Faraja SACCOS',
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<BankAccount>().supportsAgentBanking).toBe(false);
  });

  it('refuses a listed section given a typed-in name', async () => {
    const response = await openAccount({
      holdingKind: 'bank_tanzania',
      counterpartyName: 'CRDB Bank',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.path).toEqual(['institutionCode']);
  });

  it('refuses an MNO filed under the banking section', async () => {
    // MPESA is on BOT's list, as an MNO. Filing it under section 1 would put a
    // float balance on a banking row.
    const response = await openAccount({ holdingKind: 'bank_tanzania', institutionCode: 'mpesa' });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toContain('different section');
  });
});

describe('PUT /finance/bank-accounts/:id/balances', () => {
  const openAccount = async (body: Record<string, unknown>): Promise<BankAccount> =>
    (await request('POST', '/finance/bank-accounts', accountantToken, body)).json<BankAccount>();

  it('records a shilling balance at par', async () => {
    const account = await openAccount({
      holdingKind: 'bank_tanzania',
      institutionCode: 'nbc_limited',
    });

    const response = await request(
      'PUT',
      `/finance/bank-accounts/${account.id}/balances`,
      accountantToken,
      { year: 2026, quarter: 1, depositBalance: '4000000.00' },
    );

    expect(response.statusCode).toBe(200);

    const balance = response.json<BankAccountBalance>();
    expect(balance.depositBalanceTzs).toBe('4000000.00');
    expect(balance.exchangeRate).toBeNull();
  });

  it('converts a foreign balance to shillings on the server, exactly', async () => {
    const account = await openAccount({
      holdingKind: 'bank_abroad',
      counterpartyName: 'Barclays UK',
      currencyCode: 'USD',
    });

    const balance = (
      await request('PUT', `/finance/bank-accounts/${account.id}/balances`, accountantToken, {
        year: 2026,
        quarter: 1,
        depositBalance: '1234.56',
        exchangeRate: '2537.891234',
        rateDate: '2026-03-31',
      })
    ).json<BankAccountBalance>();

    // 1234.56 × 2537.891234 = 3,133,179.001847…, which rounds to
    // 3,133,179.00. Computed in exact decimal arithmetic on the server; the
    // browser never sees the multiplication at all.
    expect(balance.depositBalanceTzs).toBe('3133179.00');
    expect(balance.rateDate).toBe('2026-03-31');
  });

  it('refuses a foreign balance with no rate behind it', async () => {
    const account = await openAccount({
      holdingKind: 'bank_abroad',
      counterpartyName: 'Standard Bank SA',
      currencyCode: 'ZAR',
    });

    const response = await request(
      'PUT',
      `/finance/bank-accounts/${account.id}/balances`,
      accountantToken,
      { year: 2026, quarter: 1, depositBalance: '5000.00' },
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.message).toContain('rate');
  });

  it('refuses a rate on an account already held in shillings', async () => {
    const account = await openAccount({
      holdingKind: 'mno',
      institutionCode: 'mpesa',
    });

    const response = await request(
      'PUT',
      `/finance/bank-accounts/${account.id}/balances`,
      accountantToken,
      {
        year: 2026,
        quarter: 1,
        depositBalance: '100000.00',
        exchangeRate: '2500',
        rateDate: '2026-03-31',
      },
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses an agent-banking figure BOT has no row for', async () => {
    const account = await openAccount({
      holdingKind: 'bank_tanzania',
      institutionCode: 'bank_of_tanzania',
    });

    const response = await request(
      'PUT',
      `/finance/bank-accounts/${account.id}/balances`,
      accountantToken,
      { year: 2026, quarter: 1, agentBankingBalance: '5000.00' },
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('agent banking');
  });

  it('restates a quarter rather than recording a second figure for it', async () => {
    const account = await openAccount({
      holdingKind: 'bank_tanzania',
      institutionCode: 'azania_bank_limited',
    });

    await request('PUT', `/finance/bank-accounts/${account.id}/balances`, accountantToken, {
      year: 2026,
      quarter: 2,
      depositBalance: '1000000.00',
    });
    await request('PUT', `/finance/bank-accounts/${account.id}/balances`, accountantToken, {
      year: 2026,
      quarter: 2,
      depositBalance: '1750000.00',
    });

    const balances = (
      await request('GET', '/finance/bank-balances?year=2026&quarter=2', accountantToken)
    ).json<BankAccountBalance[]>();

    const mine = balances.filter((balance) => balance.bankAccountId === account.id);
    // One figure per account per quarter. Two would make the total BOT reads
    // depend on which row a query happened to find.
    expect(mine).toHaveLength(1);
    expect(mine[0]?.depositBalance).toBe('1750000.00');
  });
});

describe('GET /reference/financial-institutions', () => {
  it('serves both of BOT’s lists with the flag that distinguishes them', async () => {
    const institutions = (
      await request('GET', '/reference/financial-institutions', accountantToken)
    ).json<FinancialInstitution[]>();

    expect(institutions).toHaveLength(61);
    expect(institutions.filter((entry) => entry.kind === 'mno')).toHaveLength(6);
    // The Bank of Tanzania takes deposits and offers no agent banking, which is
    // the distinction MSP2-08 turns on.
    const bot = institutions.find((entry) => entry.code === 'bank_of_tanzania');
    expect(bot?.inAgentBankingList).toBe(false);
  });
});
