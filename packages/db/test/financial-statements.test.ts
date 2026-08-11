import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * The quarterly statement dataset, and what it refuses to hold.
 *
 * "Locked" is the whole point of this table, and it is expressed by having
 * nowhere to write: a line this system derives has no `accepts_statement_entry`
 * flag, so the composite key cannot resolve and the row is rejected. The
 * institution cannot supply a second answer to a question the loan book already
 * answers, because there is no column that would hold it.
 */

const INSTITUTION = '33330000-0000-7000-8000-000000000010';

let pool: pg.Pool;
let db: Database;
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
    for (const table of ['financial_statement_lines', 'users', 'code_sequences', 'branches']) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = $1`, [INSTITUTION]);
    }
    await client.query('DELETE FROM institutions WHERE id = $1', [INSTITUTION]);
    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2)', [
      INSTITUTION,
      'Statements Institution',
    ]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'Head Office', true) RETURNING id`,
      [INSTITUTION],
    );

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'statements@fin.test', 'Accountant', 'x', 'active') RETURNING id`,
      [INSTITUTION, branch.rows[0]?.id ?? ''],
    );
    userId = user.rows[0]?.id ?? '';
  });
});

async function enterLine(
  formCode: string,
  sno: number,
  amount = '1000000.00',
  quarter = 1,
): Promise<void> {
  await db.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO financial_statement_lines
         (institution_id, form_code, sno, year, quarter, amount, updated_by)
       VALUES ($1, $2, $3, 2026, $4, $5, $6)`,
      [INSTITUTION, formCode, sno, quarter, amount, userId],
    );
  });
}

describe('reference.form_lines', () => {
  it('marks exactly the lines an institution fills in', async () => {
    const counts = await db.withTransaction(async (client) =>
      client.query<{ form_code: string; entered: string; computed: string; total: string }>(
        `SELECT form_code,
                count(*) FILTER (WHERE accepts_statement_entry)::text AS entered,
                count(*) FILTER (WHERE is_computed)::text AS computed,
                count(*)::text AS total
           FROM reference.form_lines
          GROUP BY form_code ORDER BY form_code`,
      ),
    );

    const byForm = new Map(counts.rows.map((row) => [row.form_code, row]));

    // 61 lines: 14 BOT computes, 11 this system derives, one heading, 35 typed.
    expect(byForm.get('MSP2-01')).toMatchObject({ total: '61', computed: '14', entered: '35' });
    // 13 lines: 5 computed, 4 restating MSP2-01, 4 typed.
    expect(byForm.get('MSP2-05')).toMatchObject({ total: '13', computed: '5', entered: '4' });
  });

  it('never marks a computed line as one that accepts a figure', async () => {
    const bad = await db.withTransaction(async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM reference.form_lines
          WHERE is_computed AND accepts_statement_entry IS NOT NULL`,
      ),
    );

    expect(bad.rows[0]?.count).toBe('0');
  });
});

describe('financial_statement_lines', () => {
  it('accepts a figure against a line the institution fills in', async () => {
    // Sno2 is "Cash in Hand".
    await expect(enterLine('MSP2-01', 2)).resolves.toBeUndefined();
  });

  it('refuses a figure against a line this system derives', async () => {
    // Sno18 is "Loans to Clients", which comes from the loan book. A figure
    // here would be a second answer that could disagree on a filed return.
    await expect(enterLine('MSP2-01', 18)).rejects.toThrow(/financial_statement_lines_line/);
  });

  it('refuses a figure against a line BOT computes', async () => {
    // Sno33 is Total Assets.
    await expect(enterLine('MSP2-01', 33)).rejects.toThrow(/financial_statement_lines_line/);
  });

  it('refuses a figure against the heading BOT’s own total does not read', async () => {
    // Sno34, "8. LIABILITIES", has a cell on the template that Sno50 does not
    // sum. Accepting it would let a liability vanish from a filed balance
    // sheet.
    await expect(enterLine('MSP2-01', 34)).rejects.toThrow(/financial_statement_lines_line/);
  });

  it('refuses a figure against an MSP2-05 line that restates MSP2-01', async () => {
    await expect(enterLine('MSP2-05', 2)).rejects.toThrow(/financial_statement_lines_line/);
  });

  it('accepts the MSP2-05 securities lines, which are typed in', async () => {
    await expect(enterLine('MSP2-05', 6)).resolves.toBeUndefined();
  });

  it('accepts a negative figure, because retained earnings can be one', async () => {
    await expect(enterLine('MSP2-01', 58, '-2500000.00')).resolves.toBeUndefined();
  });

  it('refuses a second figure for the same line and quarter', async () => {
    await enterLine('MSP2-01', 2);

    await expect(enterLine('MSP2-01', 2, '999.00')).rejects.toThrow(/one_per_quarter/);
  });

  it('keeps quarters apart', async () => {
    await enterLine('MSP2-01', 2, '1000000.00', 1);

    await expect(enterLine('MSP2-01', 2, '2000000.00', 2)).resolves.toBeUndefined();
  });

  it('records every change against the audit log', async () => {
    await enterLine('MSP2-01', 2);

    const audited = await db.withTransaction(async (client) =>
      client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM audit_logs
          WHERE institution_id = $1 AND table_name = 'financial_statement_lines'`,
        [INSTITUTION],
      ),
    );

    expect(Number(audited.rows[0]?.count ?? '0')).toBeGreaterThan(0);
  });
});
