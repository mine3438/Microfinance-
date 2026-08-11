import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * The finance schema, and the constraints that keep a filing honest.
 *
 * Every rule asserted here is enforced by the database rather than by
 * application code, and each is tested by trying to break it. The system being
 * replaced enforced expense categories in the browser only, so a direct API
 * call could put an arbitrary string into a field that flows onto a BOT return
 * (R12). A rule that lives only above the database is a rule a script walks
 * around.
 */

const INSTITUTION = '33330000-0000-7000-8000-00000000000f';

let pool: pg.Pool;
let db: Database;
let branchId: string;
let userId: string;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.withTransaction(async (client) => {
    for (const table of [
      'bank_account_balances',
      'bank_accounts',
      'finance_entries',
      'user_roles',
      'users',
      'code_sequences',
      'branches',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = $1`, [INSTITUTION]);
    }
    await client.query('DELETE FROM institutions WHERE id = $1', [INSTITUTION]);
    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2)', [
      INSTITUTION,
      'Finance Institution',
    ]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'Head Office', true) RETURNING id`,
      [INSTITUTION],
    );
    branchId = branch.rows[0]?.id ?? '';

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'finance@fin.test', 'Finance Officer', 'x', 'active') RETURNING id`,
      [INSTITUTION, branchId],
    );
    userId = user.rows[0]?.id ?? '';
  });
});

/** Record an entry, returning whatever the database said about it. */
async function recordEntry(
  direction: string,
  sno: number,
  amount = '100000.00',
  entryDate = '2026-02-15',
): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO finance_entries
         (institution_id, branch_id, direction, sno, amount, entry_date, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [INSTITUTION, branchId, direction, sno, amount, entryDate, userId],
    );
  });
}

describe('finance_entries', () => {
  it('accepts an expense against a line BOT takes expenses on', async () => {
    // Sno24 is "Managements' Salaries and Benefits".
    await expect(recordEntry('expense', 24)).resolves.toBeUndefined();
  });

  it('accepts income against an income line', async () => {
    // Sno2 is "Interest - Loans to Clients".
    await expect(recordEntry('income', 2)).resolves.toBeUndefined();
  });

  it('refuses an entry against a line BOT computes', async () => {
    // Sno23 is the non-interest expense subtotal. An entry there would be
    // double-counted against the sixteen lines that make it up.
    await expect(recordEntry('expense', 23)).rejects.toThrow(/finance_entries_line/);
  });

  it('refuses an expense recorded against an income line', async () => {
    await expect(recordEntry('expense', 2)).rejects.toThrow(/finance_entries_line/);
  });

  it('refuses income recorded against an expense line', async () => {
    await expect(recordEntry('income', 24)).rejects.toThrow(/finance_entries_line/);
  });

  it('refuses a line BOT does not publish', async () => {
    await expect(recordEntry('expense', 99)).rejects.toThrow(/finance_entries_line/);
  });

  it('refuses a nil or negative amount', async () => {
    // A zero-value expense is not a fact about money; it is an empty row that
    // makes a line look populated.
    await expect(recordEntry('expense', 24, '0.00')).rejects.toThrow(/amount/);
    await expect(recordEntry('expense', 24, '-500.00')).rejects.toThrow(/amount/);
  });

  it('records every change against the audit log', async () => {
    await recordEntry('expense', 24);

    const audited = await db.withTransaction(async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE institution_id = $1 AND table_name = 'finance_entries'`,
        [INSTITUTION],
      ),
    );

    // Entries are editable, unlike payments — reclassifying a cost between two
    // BOT lines is ordinary bookkeeping. What makes that safe is that the move
    // is recorded.
    expect(Number(audited.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });
});

/** Open an account, returning its id. */
async function openAccount(
  kind: string,
  options: {
    institutionCode?: string | null;
    counterpartyName?: string | null;
    agentBanking?: boolean;
    currency?: string;
  } = {},
): Promise<string> {
  return db.withTransaction(async (client) => {
    const row = await client.query<{ id: string }>(
      `INSERT INTO bank_accounts
         (institution_id, holding_kind, institution_code, counterparty_name,
          supports_agent_banking, currency_code)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        INSTITUTION,
        kind,
        options.institutionCode ?? null,
        options.counterpartyName ?? null,
        options.agentBanking ?? false,
        options.currency ?? 'TZS',
      ],
    );
    return row.rows[0]?.id ?? '';
  });
}

describe('bank_accounts', () => {
  it('accepts a bank chosen from BOT’s published list', async () => {
    await expect(
      openAccount('bank_tanzania', { institutionCode: 'crdb_bank_plc', agentBanking: true }),
    ).resolves.toMatch(/-/);
  });

  it('accepts a microfinance provider named in free text', async () => {
    // BOT publishes no list for section 2 or section 4, so those rows are
    // typed in. The check has to allow exactly that and nothing looser.
    await expect(
      openAccount('microfinance_service_provider', { counterpartyName: 'Faraja SACCOS' }),
    ).resolves.toMatch(/-/);
  });

  it('refuses a listed counterparty given as free text', async () => {
    await expect(openAccount('bank_tanzania', { counterpartyName: 'CRDB Bank' })).rejects.toThrow(
      /counterparty_is_named/,
    );
  });

  it('refuses an unlisted counterparty given a reference code', async () => {
    await expect(openAccount('bank_abroad', { institutionCode: 'crdb_bank_plc' })).rejects.toThrow(
      /counterparty_is_named/,
    );
  });

  it('refuses an MNO filed as a bank', async () => {
    // MPESA is on BOT's list, but as an MNO. Filing it under section 1 would
    // put a float balance on a banking row.
    await expect(openAccount('bank_tanzania', { institutionCode: 'mpesa' })).rejects.toThrow(
      /reference_kind_matches/,
    );
  });

  it('refuses agent banking for an institution BOT does not list for it', async () => {
    // The Bank of Tanzania is on the deposits list and not the agent-banking
    // one, so MSP2-08 has no row to put such a balance on.
    await expect(
      openAccount('bank_tanzania', { institutionCode: 'bank_of_tanzania', agentBanking: true }),
    ).rejects.toThrow(/agent_banking_matches_bot/);
  });

  it('refuses agent banking for a counterparty on no BOT list at all', async () => {
    await expect(
      openAccount('bank_abroad', { counterpartyName: 'Some Bank Ltd', agentBanking: true }),
    ).rejects.toThrow(/unlisted_has_no_agent_banking/);
  });
});

/**
 * Record a quarter-end balance.
 *
 * Reads the account's currency and agent-banking eligibility rather than
 * taking them as arguments, because the composite foreign keys require the
 * balance row to agree with its account — which is the whole point of them. A
 * test that wants to break that agreement overrides the value explicitly.
 */
async function recordBalance(accountId: string, values: Record<string, unknown>): Promise<void> {
  await db.withTransaction(async (client) => {
    const account = await client.query<{
      currency_code: string;
      supports_agent_banking: boolean;
    }>('SELECT currency_code, supports_agent_banking FROM bank_accounts WHERE id = $1', [
      accountId,
    ]);
    const held = account.rows[0];

    await client.query(
      `INSERT INTO bank_account_balances
         (institution_id, bank_account_id, year, quarter, currency_code, supports_agent_banking,
          deposit_balance, deposit_balance_tzs, borrowing_balance, borrowing_balance_tzs,
          agent_banking_balance, exchange_rate, rate_date, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        INSTITUTION,
        accountId,
        values['year'] ?? 2026,
        values['quarter'] ?? 1,
        values['currency'] ?? held?.currency_code ?? 'TZS',
        values['agentBanking'] ?? held?.supports_agent_banking ?? false,
        values['deposit'] ?? '0.00',
        values['depositTzs'] ?? '0.00',
        values['borrowing'] ?? '0.00',
        values['borrowingTzs'] ?? '0.00',
        values['agentBalance'] ?? '0.00',
        values['rate'] ?? null,
        values['rateDate'] ?? null,
        userId,
      ],
    );
  });
}

describe('bank_account_balances', () => {
  it('accepts a TZS balance stated at par', async () => {
    const account = await openAccount('bank_tanzania', {
      institutionCode: 'crdb_bank_plc',
      agentBanking: true,
    });

    await expect(
      recordBalance(account, { deposit: '4000000.00', depositTzs: '4000000.00' }),
    ).resolves.toBeUndefined();
  });

  it('refuses a TZS balance whose TZS column disagrees with itself', async () => {
    const account = await openAccount('bank_tanzania', {
      institutionCode: 'crdb_bank_plc',
      agentBanking: true,
    });

    await expect(
      recordBalance(account, { deposit: '4000000.00', depositTzs: '9000000.00' }),
    ).rejects.toThrow(/conversion_is_stated/);
  });

  it('refuses a foreign balance with no rate behind it', async () => {
    // Which rate BOT expects is unsettled (§11.6). What cannot be left open is
    // whether a filed TZS figure can be explained afterwards.
    const account = await openAccount('bank_abroad', {
      counterpartyName: 'Barclays UK',
      currency: 'USD',
    });

    await expect(
      recordBalance(account, {
        currency: 'USD',
        deposit: '1000.00',
        depositTzs: '2500000.00',
      }),
    ).rejects.toThrow(/conversion_is_stated/);
  });

  it('accepts a foreign balance with its rate and rate date', async () => {
    const account = await openAccount('bank_abroad', {
      counterpartyName: 'Barclays UK',
      currency: 'USD',
    });

    await expect(
      recordBalance(account, {
        currency: 'USD',
        deposit: '1000.00',
        depositTzs: '2500000.00',
        rate: '2500.000000',
        rateDate: '2026-03-31',
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses a currency that is not the account’s own', async () => {
    const account = await openAccount('bank_tanzania', {
      institutionCode: 'crdb_bank_plc',
      agentBanking: true,
    });

    await expect(
      recordBalance(account, {
        currency: 'USD',
        deposit: '1000.00',
        depositTzs: '2500000.00',
        rate: '2500.000000',
        rateDate: '2026-03-31',
      }),
    ).rejects.toThrow(/currency_matches_account/);
  });

  it('refuses an agent-banking figure on an account that does not support it', async () => {
    const account = await openAccount('bank_tanzania', { institutionCode: 'bank_of_tanzania' });

    await expect(recordBalance(account, { agentBalance: '5000.00' })).rejects.toThrow(
      /agent_banking/,
    );
  });

  it('accepts an agent-banking figure where BOT lists the bank', async () => {
    const account = await openAccount('bank_tanzania', {
      institutionCode: 'crdb_bank_plc',
      agentBanking: true,
    });

    await expect(recordBalance(account, { agentBalance: '5000.00' })).resolves.toBeUndefined();
  });

  it('refuses a second balance for the same account and quarter', async () => {
    // Two rows would make the total BOT reads depend on which one a query
    // happened to find.
    const account = await openAccount('bank_tanzania', {
      institutionCode: 'crdb_bank_plc',
      agentBanking: true,
    });
    await recordBalance(account, { deposit: '100.00', depositTzs: '100.00' });

    await expect(
      recordBalance(account, { deposit: '200.00', depositTzs: '200.00' }),
    ).rejects.toThrow(/one_per_quarter/);
  });
});
