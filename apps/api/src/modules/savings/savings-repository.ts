import {
  type CreateSavingsProductRequest,
  type OpenSavingsAccountRequest,
  type RecordSavingsEntryRequest,
  type SavingsAccount,
  type SavingsAccountListQuery,
  type SavingsAccountStatus,
  type SavingsDirection,
  type SavingsProduct,
  type SavingsTransaction,
} from '@mfi/contracts';
import { type Database, type TransactionClient } from '@mfi/db';
import { applyEntry } from '@mfi/domain';
import { Money } from '@mfi/money';

import { decodeCursor, toPage, type PagedRows } from '../../http/cursor.js';
import { conflict, notFound, ruleViolation } from '../../http/errors.js';

/**
 * Savings persistence.
 *
 * The one thing this layer has to get right is that a balance and its ledger
 * cannot disagree. Both are written in the same transaction, and the account
 * row is locked before its balance is read — so two tellers taking money out of
 * the same account at the same moment serialise rather than both seeing the
 * balance that existed before either of them.
 *
 * The overdraft rule itself lives in the domain (`applyEntry`), and the column
 * carries a `CHECK (balance >= 0)` besides. Three layers for one rule is not
 * duplication here: the domain states it, the lock makes the check meaningful
 * under concurrency, and the constraint is what holds if a future path forgets
 * both.
 */

interface ProductRow {
  id: string;
  code: string;
  name: string;
  is_compulsory: boolean;
  status: 'active' | 'closed';
}

interface AccountRow {
  id: string;
  account_code: string;
  client_id: string;
  client_name: string;
  branch_id: string;
  branch_name: string;
  product_id: string;
  product_name: string;
  is_compulsory: boolean;
  status: SavingsAccountStatus;
  opened_on: Date;
  closed_on: Date | null;
  balance: string;
  created_at: Date;
  updated_at: Date;
}

interface TransactionRow {
  id: string;
  savings_account_id: string;
  direction: SavingsDirection;
  amount: string;
  balance_after: string;
  transaction_date: Date;
  narrative: string | null;
  reference: string | null;
  reverses_id: string | null;
  recorded_by: string;
  created_at: Date;
}

const PRODUCT_SELECT = `SELECT id, code, name, is_compulsory, status
         FROM savings_products`;

const ACCOUNT_SELECT = `SELECT a.id, a.account_code, a.client_id, cl.full_name AS client_name,
              a.branch_id, b.name AS branch_name, a.product_id, p.name AS product_name,
              p.is_compulsory, a.status, a.opened_on, a.closed_on, a.balance,
              a.created_at, a.updated_at
         FROM savings_accounts a
         JOIN clients cl ON cl.id = a.client_id
         JOIN branches b ON b.id = a.branch_id
         JOIN savings_products p ON p.id = a.product_id`;

const TRANSACTION_SELECT = `SELECT id, savings_account_id, direction, amount, balance_after,
              transaction_date, narrative, reference, reverses_id, recorded_by, created_at
         FROM savings_transactions`;

export interface SavingsRepository {
  listProducts(institutionId: string, userId: string): Promise<SavingsProduct[]>;
  createProduct(
    institutionId: string,
    userId: string,
    request: CreateSavingsProductRequest,
  ): Promise<SavingsProduct>;
  setProductStatus(
    institutionId: string,
    userId: string,
    productId: string,
    status: 'active' | 'closed',
  ): Promise<SavingsProduct | null>;
  /** A product's status, so the use case can refuse a closed one by name. */
  findProduct(
    institutionId: string,
    userId: string,
    productId: string,
  ): Promise<SavingsProduct | null>;
  listAccounts(
    institutionId: string,
    userId: string,
    filters: SavingsAccountListQuery,
  ): Promise<PagedRows<SavingsAccount>>;
  findAccount(institutionId: string, userId: string, id: string): Promise<SavingsAccount | null>;
  openAccount(
    institutionId: string,
    userId: string,
    request: OpenSavingsAccountRequest,
  ): Promise<SavingsAccount>;
  listTransactions(
    institutionId: string,
    userId: string,
    accountId: string,
  ): Promise<SavingsTransaction[]>;
  recordEntry(
    institutionId: string,
    userId: string,
    accountId: string,
    request: RecordSavingsEntryRequest,
  ): Promise<SavingsTransaction>;
  reverseEntry(
    institutionId: string,
    userId: string,
    transactionId: string,
    reversedOn: string,
    narrative: string,
  ): Promise<SavingsTransaction>;
}

export class PostgresSavingsRepository implements SavingsRepository {
  public constructor(private readonly database: Database) {}

  public async listProducts(institutionId: string, userId: string): Promise<SavingsProduct[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ProductRow>(`${PRODUCT_SELECT} ORDER BY name`);
      return rows.rows.map(toProduct);
    });
  }

  public async createProduct(
    institutionId: string,
    userId: string,
    request: CreateSavingsProductRequest,
  ): Promise<SavingsProduct> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const inserted = await client.query<ProductRow>(
        `INSERT INTO savings_products (institution_id, code, name, is_compulsory)
         VALUES ($1, $2, $3, $4)
         RETURNING id, code, name, is_compulsory, status`,
        [institutionId, request.code, request.name, request.isCompulsory],
      );
      const row = inserted.rows[0];
      if (row === undefined) {
        throw notFound('The savings product could not be read back after being created.');
      }
      return toProduct(row);
    });
  }

  /**
   * Close a product to new accounts, or reopen it.
   *
   * Accounts already open against it are untouched. Their balances still report
   * on MSP2-01 Sno46 and MSP2-10, and making real money vanish from a return
   * because a product was withdrawn would be a misstatement, not a tidy-up.
   */
  public async setProductStatus(
    institutionId: string,
    userId: string,
    productId: string,
    status: 'active' | 'closed',
  ): Promise<SavingsProduct | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const updated = await client.query<ProductRow>(
        `UPDATE savings_products
            SET status = $2
          WHERE id = $1
        RETURNING id, code, name, is_compulsory, status`,
        [productId, status],
      );
      const row = updated.rows[0];
      return row === undefined ? null : toProduct(row);
    });
  }

  public async findProduct(
    institutionId: string,
    userId: string,
    productId: string,
  ): Promise<SavingsProduct | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<ProductRow>(`${PRODUCT_SELECT} WHERE id = $1`, [productId]);
      const row = rows.rows[0];
      return row === undefined ? null : toProduct(row);
    });
  }

  public async listAccounts(
    institutionId: string,
    userId: string,
    filters: SavingsAccountListQuery,
  ): Promise<PagedRows<SavingsAccount>> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const conditions: string[] = [];
      const parameters: unknown[] = [];

      const bind = (value: unknown): string => {
        parameters.push(value);
        return `$${String(parameters.length)}`;
      };

      if (filters.clientId !== undefined) {
        conditions.push(`a.client_id = ${bind(filters.clientId)}`);
      }
      if (filters.productId !== undefined) {
        conditions.push(`a.product_id = ${bind(filters.productId)}`);
      }
      if (filters.status !== undefined) {
        conditions.push(`a.status = ${bind(filters.status)}`);
      }
      if (filters.cursor !== undefined) {
        conditions.push(`a.id < ${bind(decodeCursor(filters.cursor))}`);
      }

      const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

      const rows = await client.query<AccountRow>(
        `${ACCOUNT_SELECT} ${where} ORDER BY a.id DESC LIMIT ${bind(filters.limit + 1)}`,
        parameters,
      );

      const page = toPage(rows.rows, filters.limit);
      return { items: page.items.map(toAccount), nextCursor: page.nextCursor };
    });
  }

  public async findAccount(
    institutionId: string,
    userId: string,
    id: string,
  ): Promise<SavingsAccount | null> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [id]);
      const row = rows.rows[0];
      return row === undefined ? null : toAccount(row);
    });
  }

  public async openAccount(
    institutionId: string,
    userId: string,
    request: OpenSavingsAccountRequest,
  ): Promise<SavingsAccount> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const code = await client.query<{ code: string }>(
        `SELECT allocate_entity_code($1, 'savings', 'SAV',
                extract(year FROM $2::date)::integer) AS code`,
        [institutionId, request.openedOn],
      );

      const inserted = await client.query<{ id: string }>(
        `INSERT INTO savings_accounts
           (institution_id, branch_id, client_id, product_id, account_code, opened_on)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          institutionId,
          request.branchId,
          request.clientId,
          request.productId,
          code.rows[0]?.code ?? '',
          request.openedOn,
        ],
      );

      return this.readAccount(client, inserted.rows[0]?.id ?? '');
    });
  }

  public async listTransactions(
    institutionId: string,
    userId: string,
    accountId: string,
  ): Promise<SavingsTransaction[]> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const rows = await client.query<TransactionRow>(
        `${TRANSACTION_SELECT} WHERE savings_account_id = $1
          ORDER BY transaction_date DESC, id DESC`,
        [accountId],
      );
      return rows.rows.map(toTransaction);
    });
  }

  public async recordEntry(
    institutionId: string,
    userId: string,
    accountId: string,
    request: RecordSavingsEntryRequest,
  ): Promise<SavingsTransaction> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) =>
      this.append(client, {
        institutionId,
        userId,
        accountId,
        direction: request.direction,
        amount: Money.of(request.amount),
        transactionDate: request.transactionDate,
        narrative: request.narrative ?? null,
        reference: request.reference ?? null,
        reversesId: null,
      }),
    );
  }

  public async reverseEntry(
    institutionId: string,
    userId: string,
    transactionId: string,
    reversedOn: string,
    narrative: string,
  ): Promise<SavingsTransaction> {
    return this.database.withTenantTransaction({ institutionId, userId }, async (client) => {
      const original = await client.query<TransactionRow>(`${TRANSACTION_SELECT} WHERE id = $1`, [
        transactionId,
      ]);
      const row = original.rows[0];
      if (row === undefined) {
        throw notFound('That savings entry does not exist.');
      }

      const already = await client.query<{ id: string }>(
        'SELECT id FROM savings_transactions WHERE reverses_id = $1',
        [transactionId],
      );
      if (already.rows.length > 0) {
        throw conflict('That entry has already been reversed.');
      }

      return this.append(client, {
        institutionId,
        userId,
        accountId: row.savings_account_id,
        // The opposite direction, which is what makes the pair cancel.
        direction: row.direction === 'deposit' ? 'withdrawal' : 'deposit',
        amount: Money.fromDatabaseValue(row.amount),
        transactionDate: reversedOn,
        narrative,
        reference: row.reference,
        reversesId: transactionId,
      });
    });
  }

  /**
   * Write one entry, and move the balance with it.
   *
   * `FOR UPDATE` before the balance is read, so a concurrent withdrawal waits
   * rather than reading a balance that is about to change. Without the lock,
   * two withdrawals of the whole balance would both see it and both succeed —
   * and the column's CHECK would catch only the second one to reach the write,
   * which is a race whose outcome depends on scheduling.
   */
  private async append(
    client: TransactionClient,
    entry: {
      institutionId: string;
      userId: string;
      accountId: string;
      direction: SavingsDirection;
      amount: Money;
      transactionDate: string;
      narrative: string | null;
      reference: string | null;
      reversesId: string | null;
    },
  ): Promise<SavingsTransaction> {
    const locked = await client.query<{ balance: string; status: SavingsAccountStatus }>(
      'SELECT balance, status FROM savings_accounts WHERE id = $1 FOR UPDATE',
      [entry.accountId],
    );
    const account = locked.rows[0];
    if (account === undefined) {
      throw notFound('That savings account does not exist.');
    }
    if (account.status === 'closed') {
      throw conflict('That savings account is closed.');
    }

    // The domain decides whether this is allowed; this layer only persists the
    // answer. A `DomainValidationError` from here surfaces as a 422 naming the
    // balance, rather than as a constraint violation naming a column.
    const balanceAfter = applyEntry(Money.fromDatabaseValue(account.balance), {
      direction: entry.direction,
      amount: entry.amount,
      transactionDate: entry.transactionDate,
    });

    const inserted = await client.query<TransactionRow>(
      `INSERT INTO savings_transactions
         (institution_id, savings_account_id, direction, amount, balance_after,
          transaction_date, narrative, reference, reverses_id, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, savings_account_id, direction, amount, balance_after,
                 transaction_date, narrative, reference, reverses_id, recorded_by, created_at`,
      [
        entry.institutionId,
        entry.accountId,
        entry.direction,
        entry.amount.toDatabaseValue(),
        balanceAfter.toDatabaseValue(),
        entry.transactionDate,
        entry.narrative,
        entry.reference,
        entry.reversesId,
        entry.userId,
      ],
    );

    await client.query('UPDATE savings_accounts SET balance = $2 WHERE id = $1', [
      entry.accountId,
      balanceAfter.toDatabaseValue(),
    ]);

    const row = inserted.rows[0];
    if (row === undefined) {
      throw ruleViolation('The savings entry could not be recorded.');
    }
    return toTransaction(row);
  }

  private async readAccount(client: TransactionClient, id: string): Promise<SavingsAccount> {
    const rows = await client.query<AccountRow>(`${ACCOUNT_SELECT} WHERE a.id = $1`, [id]);
    const row = rows.rows[0];
    if (row === undefined) {
      throw notFound('That savings account does not exist.');
    }
    return toAccount(row);
  }
}

function dateOnly(value: Date): string {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function toProduct(row: ProductRow): SavingsProduct {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isCompulsory: row.is_compulsory,
    status: row.status,
  };
}

function toAccount(row: AccountRow): SavingsAccount {
  return {
    id: row.id,
    accountCode: row.account_code,
    clientId: row.client_id,
    clientName: row.client_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    productId: row.product_id,
    productName: row.product_name,
    isCompulsory: row.is_compulsory,
    status: row.status,
    openedOn: dateOnly(row.opened_on),
    closedOn: row.closed_on === null ? null : dateOnly(row.closed_on),
    balance: row.balance,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toTransaction(row: TransactionRow): SavingsTransaction {
  return {
    id: row.id,
    savingsAccountId: row.savings_account_id,
    direction: row.direction,
    amount: row.amount,
    balanceAfter: row.balance_after,
    transactionDate: dateOnly(row.transaction_date),
    narrative: row.narrative,
    reference: row.reference,
    reversesId: row.reverses_id,
    recordedBy: row.recorded_by,
    createdAt: row.created_at.toISOString(),
  };
}
