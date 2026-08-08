import { Money, Rate } from '@mfi/money';
import { generateSchedule, type InterestMethod } from '@mfi/domain';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Loan products.
 *
 * The previous schema had no product concept: rate, method and term were typed
 * afresh on every loan. Nothing stopped an officer entering 50% a month where
 * the institution offers 5%, and MSP2-04 reports the lowest and highest rate
 * per loan type — so the typo would be filed as a genuine product.
 */

const INSTITUTION_A = 'cccc0000-0000-7000-8000-000000000003';
const INSTITUTION_B = 'dddd0000-0000-7000-8000-000000000004';

let pool: pg.Pool;
let db: Database;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  const owned = [INSTITUTION_A, INSTITUTION_B];

  await db.withTransaction(async (client) => {
    await client.query('DELETE FROM loan_products WHERE institution_id = ANY($1::uuid[])', [owned]);
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);
    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      INSTITUTION_A,
      'Product Institution A',
      INSTITUTION_B,
      'Product Institution B',
    ]);
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);
  });
});

interface ProductOverrides {
  code?: string;
  botLoanType?: string;
  interestMethod?: string;
  minRate?: string;
  maxRate?: string;
  minTerm?: number;
  maxTerm?: number;
  minPrincipal?: string;
  maxPrincipal?: string;
}

async function insertProduct(overrides: ProductOverrides = {}): Promise<void> {
  await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
    await client.query(
      `INSERT INTO loan_products
         (institution_id, code, name, bot_loan_type, interest_method,
          min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
          min_principal, max_principal)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        INSTITUTION_A,
        overrides.code ?? 'BIZ-INDIV',
        'Business Individual Loan',
        overrides.botLoanType ?? 'business_individual_loans',
        overrides.interestMethod ?? 'reducing_balance',
        overrides.minRate ?? '0.0300',
        overrides.maxRate ?? '0.0800',
        overrides.minTerm ?? 3,
        overrides.maxTerm ?? 24,
        overrides.minPrincipal ?? '100000.00',
        overrides.maxPrincipal ?? '10000000.00',
      ],
    );
  });
}

describe('defining a product', () => {
  it('accepts a well-formed product', async () => {
    await expect(insertProduct()).resolves.toBeUndefined();
  });

  it('requires a BOT loan type that exists', async () => {
    // The type decides which MSP2-04 row the loan reports under, and which
    // provisioning schedule applies to it.
    await expect(insertProduct({ botLoanType: 'payday_advance' })).rejects.toThrow(
      /foreign key|loan_type/i,
    );
  });

  it('accepts every seeded BOT loan type', async () => {
    const types = await pool.query<{ code: string }>('SELECT code FROM reference.loan_types');

    for (const [index, type] of types.rows.entries()) {
      await expect(
        insertProduct({ code: `PROD-${String(index)}`, botLoanType: type.code }),
      ).resolves.toBeUndefined();
    }
  });

  it.each(['flat', 'reducing_balance'])('accepts the %s interest method', async (method) => {
    await expect(insertProduct({ interestMethod: method })).resolves.toBeUndefined();
  });

  it('refuses an interest method the engine cannot compute', async () => {
    await expect(insertProduct({ interestMethod: 'compound_daily' })).rejects.toThrow(
      /interest_method|violates check/i,
    );
  });

  it('keeps product codes unique within an institution', async () => {
    await insertProduct({ code: 'DUPLICATE' });

    await expect(insertProduct({ code: 'DUPLICATE' })).rejects.toThrow(/duplicate key/i);
  });

  it('lets two institutions use the same product code', async () => {
    await insertProduct({ code: 'SHARED' });

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_B }, async (client) => {
        await client.query(
          `INSERT INTO loan_products
             (institution_id, code, name, bot_loan_type, interest_method,
              min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
              min_principal, max_principal)
           VALUES ($1, 'SHARED', 'Their Product', 'agriculture_loans', 'flat',
                   '0.0200', '0.0400', 1, 12, '50000.00', '500000.00')`,
          [INSTITUTION_B],
        );
      }),
    ).resolves.toBeUndefined();
  });
});

describe('bounds that admit no loan are refused when defined', () => {
  // Catching an inverted range here means the product fails where it was
  // written, rather than every loan created from it failing somewhere else.
  it('refuses a rate floor above its ceiling', async () => {
    await expect(insertProduct({ minRate: '0.0900', maxRate: '0.0300' })).rejects.toThrow(
      /loan_products_rate_range/i,
    );
  });

  it('refuses a term floor above its ceiling', async () => {
    await expect(insertProduct({ minTerm: 24, maxTerm: 3 })).rejects.toThrow(
      /loan_products_term_range/i,
    );
  });

  it('refuses a principal floor above its ceiling', async () => {
    await expect(
      insertProduct({ minPrincipal: '1000000.00', maxPrincipal: '100000.00' }),
    ).rejects.toThrow(/loan_products_principal_range/i);
  });

  it('accepts a range with equal floor and ceiling, which is a fixed term', async () => {
    await expect(insertProduct({ minTerm: 12, maxTerm: 12 })).resolves.toBeUndefined();
  });

  it('refuses a term beyond what the engine will schedule', async () => {
    await expect(insertProduct({ maxTerm: 361 })).rejects.toThrow(
      /max_term_months|violates check/i,
    );
  });

  it('refuses a zero principal floor', async () => {
    await expect(insertProduct({ minPrincipal: '0.00' })).rejects.toThrow(
      /min_principal|violates check/i,
    );
  });

  it('refuses a negative rate', async () => {
    await expect(insertProduct({ minRate: '-0.0100' })).rejects.toThrow(
      /min_monthly_rate|violates check/i,
    );
  });
});

describe('stored terms drive the schedule engine', () => {
  it('produces a schedule from a product’s own bounds', async () => {
    // The link the product exists to make: what is stored is exactly what the
    // engine is handed, with no reinterpretation in between.
    await insertProduct({
      code: 'SCHEDULED',
      interestMethod: 'reducing_balance',
      minRate: '0.0500',
      maxRate: '0.0500',
      minTerm: 12,
      maxTerm: 12,
    });

    const product = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{
          interest_method: string;
          max_monthly_rate: string;
          max_term_months: number;
        }>(
          `SELECT interest_method, max_monthly_rate, max_term_months
             FROM loan_products WHERE code = 'SCHEDULED'`,
        );
        return result.rows[0];
      },
    );

    expect(product).toBeDefined();

    const schedule = generateSchedule({
      principal: Money.of('1000000.00'),
      monthlyRate: Rate.ofMonthlyFraction(product?.max_monthly_rate ?? '0'),
      termMonths: product?.max_term_months ?? 0,
      method: (product?.interest_method ?? 'flat') as InterestMethod,
      disbursementDate: new Date('2026-01-15T00:00:00.000Z'),
    });

    // The same figures the engine's own golden vectors assert, reached through
    // the database rather than from literals in a test.
    expect(schedule.instalments[0]?.totalDue.toDatabaseValue()).toBe('112825.41');
    expect(schedule.totalInterest.toDatabaseValue()).toBe('353904.94');
    expect(schedule.totalPrincipal.toDatabaseValue()).toBe('1000000.00');
  });

  it('stores rates at the precision Rate accepts, without loss', async () => {
    await insertProduct({ code: 'PRECISE', minRate: '0.0375', maxRate: '0.0375' });

    const stored = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ min_monthly_rate: string }>(
          `SELECT min_monthly_rate FROM loan_products WHERE code = 'PRECISE'`,
        );
        return result.rows[0]?.min_monthly_rate;
      },
    );

    expect(stored).toBe('0.0375');
    expect(Rate.ofMonthlyFraction(stored ?? '0').toDatabaseValue()).toBe('0.0375');
  });
});

describe('tenancy and lifecycle', () => {
  it('hides products from other institutions', async () => {
    await insertProduct({ code: 'PRIVATE' });

    const visible = await db.withTenantTransaction(
      { institutionId: INSTITUTION_B },
      async (client) => {
        const result = await client.query<{ code: string }>('SELECT code FROM loan_products');
        return result.rows;
      },
    );

    expect(visible).toEqual([]);
  });

  it('retires rather than deletes, since issued loans reference the terms', async () => {
    await insertProduct({ code: 'RETIRING' });

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(`DELETE FROM loan_products WHERE code = 'RETIRING'`);
      }),
    ).rejects.toThrow(/permission denied/i);

    const status = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        await client.query(`UPDATE loan_products SET status = 'retired' WHERE code = 'RETIRING'`);
        const result = await client.query<{ status: string }>(
          `SELECT status FROM loan_products WHERE code = 'RETIRING'`,
        );
        return result.rows[0]?.status;
      },
    );

    expect(status).toBe('retired');
  });

  it('audits a product definition and any change to its terms', async () => {
    // A rate that moved is exactly the kind of change a supervisor asks about.
    await insertProduct({ code: 'AUDITED' });
    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      await client.query(
        `UPDATE loan_products SET max_monthly_rate = '0.0900' WHERE code = 'AUDITED'`,
      );
    });

    const entries = await pool.query<{ operation: string; changed_columns: string[] | null }>(
      `SELECT operation, changed_columns FROM audit_logs
        WHERE institution_id = $1 AND table_name = 'loan_products'
        ORDER BY changed_at`,
      [INSTITUTION_A],
    );

    expect(entries.rows.map((row) => row.operation)).toEqual(['INSERT', 'UPDATE']);
    expect(entries.rows[1]?.changed_columns).toContain('max_monthly_rate');
  });
});
