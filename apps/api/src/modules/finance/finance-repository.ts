import {
  type BankAccount,
  type BankAccountBalance,
  type FinanceEntry,
  type FinanceEntryListQuery,
  type FinancialInstitution,
  type HoldingKind,
  type Msp2_02Line,
} from '@mfi/contracts';
import { type Database } from '@mfi/db';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';
import { conflict, notFound } from '../../http/errors.js';

/**
 * Finance persistence.
 *
 * Nothing here decides a classification. The database does, through a foreign
 * key that admits only MSP2-02 lines BOT accepts entry on, on the correct side
 * of the statement — so this layer's job is to pass a line number through and
 * let the schema refuse a bad one, not to re-implement the rule above it.
 */

interface EntryRow {
  id: string;
  direction: 'income' | 'expense';
  sno: number;
  line_label: string;
  amount: string;
  entry_date: Date;
  branch_id: string | null;
  branch_name: string | null;
  description: string | null;
  reference: string | null;
  recorded_by: string;
  created_at: Date;
  updated_at: Date;
}

interface AccountRow {
  id: string;
  holding_kind: HoldingKind;
  institution_code: string | null;
  counterparty_name: string | null;
  counterparty: string;
  supports_agent_banking: boolean;
  account_number: string | null;
  currency_code: string;
  status: 'active' | 'closed';
  created_at: Date;
}

interface BalanceRow {
  id: string;
  bank_account_id: string;
  counterparty: string;
  holding_kind: HoldingKind;
  year: number;
  quarter: number;
  currency_code: string;
  deposit_balance: string;
  borrowing_balance: string;
  deposit_balance_tzs: string;
  borrowing_balance_tzs: string;
  agent_banking_balance: string;
  exchange_rate: string | null;
  rate_date: Date | null;
  updated_at: Date;
}

/**
 * Complete projections, each a plain string.
 *
 * Written out rather than composed from fragments because the lint rule that
 * bans interpolated SQL cannot tell a constant apart from a caller's input, and
 * the right response to that is to give it nothing to flag rather than to
 * argue with it. Every parameter below travels as `$1`.
 *
 * `COALESCE(f.name, a.counterparty_name)` recurs because two of BOT's four
 * MSP2-07 sections come from a published list and two are typed in, so a row's
 * label is whichever of the two columns applies.
 */
const ENTRY_SELECT = `SELECT e.id, e.direction, e.sno, l.label AS line_label, e.amount, e.entry_date,
              e.branch_id, b.name AS branch_name, e.description, e.reference,
              e.recorded_by, e.created_at, e.updated_at
         FROM finance_entries e
         JOIN reference.form_lines l ON l.form_code = e.form_code AND l.sno = e.sno
         LEFT JOIN branches b ON b.id = e.branch_id`;

const ACCOUNT_SELECT = `SELECT a.id, a.holding_kind, a.institution_code, a.counterparty_name,
              COALESCE(f.name, a.counterparty_name) AS counterparty,
              a.supports_agent_banking, a.account_number, a.currency_code, a.status, a.created_at
         FROM bank_accounts a
         LEFT JOIN reference.financial_institutions f ON f.code = a.institution_code`;

const BALANCE_SELECT = `SELECT v.id, v.bank_account_id,
              COALESCE(f.name, a.counterparty_name) AS counterparty,
              a.holding_kind, v.year, v.quarter, v.currency_code,
              v.deposit_balance, v.borrowing_balance,
              v.deposit_balance_tzs, v.borrowing_balance_tzs, v.agent_banking_balance,
              v.exchange_rate, v.rate_date, v.updated_at
         FROM bank_account_balances v
         JOIN bank_accounts a ON a.id = v.bank_account_id
         LEFT JOIN reference.financial_institutions f ON f.code = a.institution_code`;

/** What the API needs to write an entry. */
export interface NewFinanceEntry {
  readonly direction: 'income' | 'expense';
  readonly sno: number;
  readonly amount: string;
  readonly entryDate: string;
  readonly branchId?: string | undefined;
  readonly description?: string | undefined;
  readonly reference?: string | undefined;
}

/** What the API needs to write a quarter-end balance. */
export interface NewBankBalance {
  readonly bankAccountId: string;
  readonly year: number;
  readonly quarter: number;
  readonly currencyCode: string;
  readonly supportsAgentBanking: boolean;
  readonly depositBalance: string;
  readonly borrowingBalance: string;
  readonly depositBalanceTzs: string;
  readonly borrowingBalanceTzs: string;
  readonly agentBankingBalance: string;
  readonly exchangeRate: string | null;
  readonly rateDate: string | null;
}

/**
 * A partial update.
 *
 * Written out rather than `Partial<NewFinanceEntry>` because
 * `exactOptionalPropertyTypes` distinguishes "absent" from "present and
 * undefined", and a caller spreading a validated request body produces the
 * second. The distinction is worth keeping everywhere else; here it would only
 * force every call site to strip keys it never set.
 */
export type FinanceEntryChanges = {
  readonly [K in keyof NewFinanceEntry]?: NewFinanceEntry[K] | undefined;
};

export interface NewBankAccount {
  readonly holdingKind: HoldingKind;
  readonly institutionCode: string | null;
  readonly counterpartyName: string | null;
  readonly accountNumber: string | null;
  readonly currencyCode: string;
}

export interface FinanceRepository {
  msp2_02Lines(institutionId: string, userId: string): Promise<Msp2_02Line[]>;
  financialInstitutions(institutionId: string, userId: string): Promise<FinancialInstitution[]>;

  listEntries(
    institutionId: string,
    userId: string,
    filters: FinanceEntryListQuery,
  ): Promise<PagedRows<FinanceEntry>>;
  findEntry(institutionId: string, userId: string, id: string): Promise<FinanceEntry | null>;
  createEntry(institutionId: string, userId: string, entry: NewFinanceEntry): Promise<FinanceEntry>;
  updateEntry(
    institutionId: string,
    userId: string,
    id: string,
    changes: FinanceEntryChanges,
  ): Promise<FinanceEntry>;
  deleteEntry(institutionId: string, userId: string, id: string): Promise<void>;

  listAccounts(institutionId: string, userId: string): Promise<BankAccount[]>;
  findAccount(institutionId: string, userId: string, id: string): Promise<BankAccount | null>;
  createAccount(
    institutionId: string,
    userId: string,
    account: NewBankAccount,
  ): Promise<BankAccount>;

  listBalances(
    institutionId: string,
    userId: string,
    year: number,
    quarter: number,
  ): Promise<BankAccountBalance[]>;
  recordBalance(
    institutionId: string,
    userId: string,
    balance: NewBankBalance,
  ): Promise<BankAccountBalance>;
}

export class PostgresFinanceRepository implements FinanceRepository {
  public constructor(private readonly database: Database) {}

  public async msp2_02Lines(institutionId: string, userId: string): Promise<Msp2_02Line[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        sno: number;
        label: string;
        is_computed: boolean;
        entry_direction: 'income' | 'expense' | null;
      }>(
        `SELECT sno, label, is_computed, entry_direction
           FROM reference.form_lines WHERE form_code = 'MSP2-02' ORDER BY sno`,
      );

      return rows.rows.map((row) => ({
        sno: row.sno,
        label: row.label,
        isComputed: row.is_computed,
        entryDirection: row.entry_direction,
      }));
    });
  }

  public async financialInstitutions(
    institutionId: string,
    userId: string,
  ): Promise<FinancialInstitution[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<{
        code: string;
        name: string;
        kind: 'bank' | 'mno';
        in_deposits_list: boolean;
        in_agent_banking_list: boolean;
      }>(
        `SELECT code, name, kind, in_deposits_list, in_agent_banking_list
           FROM reference.financial_institutions ORDER BY sort_order`,
      );

      return rows.rows.map((row) => ({
        code: row.code,
        name: row.name,
        kind: row.kind,
        inDepositsList: row.in_deposits_list,
        inAgentBankingList: row.in_agent_banking_list,
      }));
    });
  }

  public async listEntries(
    institutionId: string,
    userId: string,
    filters: FinanceEntryListQuery,
  ): Promise<PagedRows<FinanceEntry>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      const bind = (value: unknown): string => {
        parameters.push(value);
        return `$${String(parameters.length)}`;
      };

      if (filters.direction !== undefined) {
        conditions.push(`e.direction = ${bind(filters.direction)}`);
      }
      if (filters.sno !== undefined) {
        conditions.push(`e.sno = ${bind(filters.sno)}`);
      }
      if (filters.from !== undefined) {
        conditions.push(`e.entry_date >= ${bind(filters.from)}`);
      }
      if (filters.to !== undefined) {
        conditions.push(`e.entry_date <= ${bind(filters.to)}`);
      }
      if (filters.cursor !== undefined) {
        conditions.push(`e.id < ${bind(decodeCursor(filters.cursor))}`);
      }

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

      const rows = await client.query<EntryRow>(
        `${ENTRY_SELECT} ${where} ORDER BY e.id DESC LIMIT ${bind(filters.limit + 1)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toEntry), nextCursor: page.nextCursor };
    });
  }

  public async findEntry(
    institutionId: string,
    userId: string,
    id: string,
  ): Promise<FinanceEntry | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<EntryRow>(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toEntry(row);
    });
  }

  public async createEntry(
    institutionId: string,
    userId: string,
    entry: NewFinanceEntry,
  ): Promise<FinanceEntry> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO finance_entries
           (institution_id, branch_id, direction, sno, amount, entry_date,
            description, reference, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
        [
          institutionId,
          entry.branchId ?? null,
          entry.direction,
          entry.sno,
          entry.amount,
          entry.entryDate,
          entry.description ?? null,
          entry.reference ?? null,
          userId,
        ],
      );

      return readEntry(client, inserted.rows[0]?.id ?? '');
    });
  }

  public async updateEntry(
    institutionId: string,
    userId: string,
    id: string,
    changes: FinanceEntryChanges,
  ): Promise<FinanceEntry> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const assignments: string[] = [];
      const parameters: unknown[] = [];

      // Column names come from this fixed map, never from the request. A caller
      // cannot name a column that is not listed here, so `institution_id` and
      // `recorded_by` are unreachable by construction rather than by a filter
      // someone has to remember to update.
      //
      // `direction` and `sno` are both listed because they resolve against one
      // composite foreign key: changing either without the other would check
      // the new value against the old half of the pair.
      const columns: Record<keyof FinanceEntryChanges, string> = {
        direction: 'direction',
        sno: 'sno',
        amount: 'amount',
        entryDate: 'entry_date',
        branchId: 'branch_id',
        description: 'description',
        reference: 'reference',
      };

      for (const [key, column] of Object.entries(columns) as [
        keyof FinanceEntryChanges,
        string,
      ][]) {
        const value = changes[key];
        if (value !== undefined) {
          parameters.push(value);
          assignments.push(`${column} = $${String(parameters.length)}`);
        }
      }

      if (assignments.length === 0) {
        return readEntry(client, id);
      }

      parameters.push(id);
      // Identifier interpolation, and the one kind this codebase permits. Every
      // fragment in `assignments` was built from the fixed `columns` map above,
      // so the text between the placeholders is a compile-time constant and no
      // caller input reaches it. The values remain parameterised.
      // eslint-disable-next-line no-restricted-syntax -- column names from a fixed map, never from input
      const statement = `UPDATE finance_entries SET ${assignments.join(', ')} WHERE id = $${String(parameters.length)} RETURNING id`;
      const updated = await client.query<{ id: string }>(statement, parameters);

      if (updated.rows.length === 0) {
        throw notFound('That entry does not exist.');
      }

      return readEntry(client, id);
    });
  }

  public async deleteEntry(institutionId: string, userId: string, id: string): Promise<void> {
    await this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const deleted = await client.query('DELETE FROM finance_entries WHERE id = $1', [id]);
      if (deleted.rowCount === 0) {
        throw notFound('That entry does not exist.');
      }
    });
  }

  public async listAccounts(institutionId: string, userId: string): Promise<BankAccount[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<AccountRow>(
        `${ACCOUNT_SELECT} ORDER BY a.holding_kind, COALESCE(f.name, a.counterparty_name)`,
      );
      return rows.rows.map(toAccount);
    });
  }

  public async findAccount(
    institutionId: string,
    userId: string,
    id: string,
  ): Promise<BankAccount | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toAccount(row);
    });
  }

  public async createAccount(
    institutionId: string,
    userId: string,
    account: NewBankAccount,
  ): Promise<BankAccount> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Agent-banking eligibility is BOT's fact, not the caller's. Read from
      // the reference table so the composite foreign key on the way in can
      // only ever agree with it.
      const eligible =
        account.institutionCode === null
          ? false
          : ((
              await client.query<{ in_agent_banking_list: boolean }>(
                'SELECT in_agent_banking_list FROM reference.financial_institutions WHERE code = $1',
                [account.institutionCode],
              )
            ).rows[0]?.in_agent_banking_list ?? false);

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bank_accounts
           (institution_id, holding_kind, institution_code, counterparty_name,
            supports_agent_banking, account_number, currency_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id`,
        [
          institutionId,
          account.holdingKind,
          account.institutionCode,
          account.counterpartyName,
          eligible,
          account.accountNumber,
          account.currencyCode,
        ],
      );

      const rows = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [
        inserted.rows[0]?.id ?? '',
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw conflict('The account could not be read back after being created.');
      }
      return toAccount(row);
    });
  }

  public async listBalances(
    institutionId: string,
    userId: string,
    year: number,
    quarter: number,
  ): Promise<BankAccountBalance[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<BalanceRow>(
        `${BALANCE_SELECT} WHERE v.year = $1 AND v.quarter = $2
          ORDER BY a.holding_kind, COALESCE(f.name, a.counterparty_name)`,
        [year, quarter],
      );
      return rows.rows.map(toBalance);
    });
  }

  public async recordBalance(
    institutionId: string,
    userId: string,
    balance: NewBankBalance,
  ): Promise<BankAccountBalance> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      // Upsert, because a quarter-end figure is restated as statements arrive
      // and the unique key makes a second insert an error rather than an
      // update. Overwriting is the intent: there is one balance per quarter.
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO bank_account_balances
           (institution_id, bank_account_id, year, quarter, currency_code, supports_agent_banking,
            deposit_balance, borrowing_balance, deposit_balance_tzs, borrowing_balance_tzs,
            agent_banking_balance, exchange_rate, rate_date, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (bank_account_id, year, quarter) DO UPDATE SET
           currency_code = EXCLUDED.currency_code,
           supports_agent_banking = EXCLUDED.supports_agent_banking,
           deposit_balance = EXCLUDED.deposit_balance,
           borrowing_balance = EXCLUDED.borrowing_balance,
           deposit_balance_tzs = EXCLUDED.deposit_balance_tzs,
           borrowing_balance_tzs = EXCLUDED.borrowing_balance_tzs,
           agent_banking_balance = EXCLUDED.agent_banking_balance,
           exchange_rate = EXCLUDED.exchange_rate,
           rate_date = EXCLUDED.rate_date,
           recorded_by = EXCLUDED.recorded_by
         RETURNING id`,
        [
          institutionId,
          balance.bankAccountId,
          balance.year,
          balance.quarter,
          balance.currencyCode,
          balance.supportsAgentBanking,
          balance.depositBalance,
          balance.borrowingBalance,
          balance.depositBalanceTzs,
          balance.borrowingBalanceTzs,
          balance.agentBankingBalance,
          balance.exchangeRate,
          balance.rateDate,
          userId,
        ],
      );

      const rows = await client.query<BalanceRow>(`${BALANCE_SELECT} WHERE v.id = $1`, [
        inserted.rows[0]?.id ?? '',
      ]);
      const row = rows.rows[0];
      if (row === undefined) {
        throw conflict('The balance could not be read back after being recorded.');
      }
      return toBalance(row);
    });
  }
}

/** Just enough of the transaction client for the read-back below. */
interface EntryReader {
  query(text: string, values?: unknown[]): Promise<{ rows: EntryRow[]; rowCount: number | null }>;
}

async function readEntry(client: EntryReader, id: string): Promise<FinanceEntry> {
  const rows = await client.query(`${ENTRY_SELECT} WHERE e.id = $1`, [id]);

  const row = rows.rows[0];
  if (row === undefined) {
    throw notFound('That entry does not exist.');
  }
  return toEntry(row);
}

/** `date` columns arrive as a local-midnight Date; only the calendar part matters. */
function dateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toEntry(row: EntryRow): FinanceEntry {
  return {
    id: row.id,
    direction: row.direction,
    sno: row.sno,
    lineLabel: row.line_label,
    amount: row.amount,
    entryDate: dateOnly(row.entry_date),
    branchId: row.branch_id,
    branchName: row.branch_name,
    description: row.description,
    reference: row.reference,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toAccount(row: AccountRow): BankAccount {
  return {
    id: row.id,
    holdingKind: row.holding_kind,
    institutionCode: row.institution_code,
    counterpartyName: row.counterparty_name,
    counterparty: row.counterparty,
    supportsAgentBanking: row.supports_agent_banking,
    accountNumber: row.account_number,
    currencyCode: row.currency_code,
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

function toBalance(row: BalanceRow): BankAccountBalance {
  return {
    id: row.id,
    bankAccountId: row.bank_account_id,
    counterparty: row.counterparty,
    holdingKind: row.holding_kind,
    year: row.year,
    quarter: row.quarter,
    currencyCode: row.currency_code,
    depositBalance: row.deposit_balance,
    borrowingBalance: row.borrowing_balance,
    depositBalanceTzs: row.deposit_balance_tzs,
    borrowingBalanceTzs: row.borrowing_balance_tzs,
    agentBankingBalance: row.agent_banking_balance,
    exchangeRate: row.exchange_rate,
    rateDate: row.rate_date === null ? null : dateOnly(row.rate_date),
    updatedAt: row.updated_at.toISOString(),
  };
}
