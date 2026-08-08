import {
  assessReportingReadiness,
  classifyByDaysOverdue,
  type ProvisioningBand,
} from '@mfi/domain';
import { Percentage } from '@mfi/money';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Overdue classification and the freshness record.
 *
 * The worst defect in the system being replaced: its classification job was
 * scheduled by a `pg_cron` line left commented out, so unless somebody enabled
 * the extension by hand, no loan's classification ever changed after creation.
 * A loan forty days overdue kept reporting "Current" to the dashboard and to
 * the Bank of Tanzania (R5). Nothing crashed — the numbers were simply untrue.
 */

const INSTITUTION = '33330000-0000-7000-8000-00000000000c';

let pool: pg.Pool;
let db: Database;
let branchId: string;
let clientId: string;
let standardProductId: string;
let housingProductId: string;
let officerId: string;
let managerId: string;

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
      'payments',
      'domain_events',
      'repayment_schedules',
      'loans',
      'system_health',
      'approval_thresholds',
      'loan_products',
      'guarantors',
      'clients',
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
      'Classification Institution',
    ]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'Head Office', true) RETURNING id`,
      [INSTITUTION],
    );
    branchId = branch.rows[0]?.id ?? '';

    // Two users, because maker-checker forbids the submitter from also being
    // the approver — a constraint the fixture has to respect rather than work
    // around.
    const staff = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'officer@class.test', 'Officer', 'x', 'active'),
              ($1, $2, 'manager@class.test', 'Manager', 'x', 'active')
       RETURNING id, email`,
      [INSTITUTION, branchId],
    );
    officerId = staff.rows.find((row) => row.email === 'officer@class.test')?.id ?? '';
    managerId = staff.rows.find((row) => row.email === 'manager@class.test')?.id ?? '';

    const reference = await client.query<{ district: string; sector: string }>(
      `SELECT (SELECT code FROM reference.districts ORDER BY sort_order LIMIT 1) AS district,
              (SELECT code FROM reference.sectors ORDER BY sno LIMIT 1) AS sector`,
    );
    const borrower = await client.query<{ id: string }>(
      `INSERT INTO clients
         (institution_id, branch_id, full_name, gender, date_of_birth, phone, district_code, sector_code)
       VALUES ($1, $2, 'Borrower', 'female', '1990-06-01', '+255712345678', $3, $4)
       RETURNING id`,
      [INSTITUTION, branchId, reference.rows[0]?.district, reference.rows[0]?.sector],
    );
    clientId = borrower.rows[0]?.id ?? '';

    const products = await client.query<{ id: string; code: string }>(
      `INSERT INTO loan_products
         (institution_id, code, name, bot_loan_type, interest_method,
          min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
          min_principal, max_principal)
       VALUES ($1, 'BIZ', 'Business', 'business_individual_loans', 'reducing_balance',
               '0.0300', '0.0800', 3, 24, '100000.00', '10000000.00'),
              ($1, 'HOME', 'Housing', 'housing_microfinance_loans', 'reducing_balance',
               '0.0100', '0.0300', 12, 240, '100000.00', '50000000.00')
       RETURNING id, code`,
      [INSTITUTION],
    );
    standardProductId = products.rows.find((row) => row.code === 'BIZ')?.id ?? '';
    housingProductId = products.rows.find((row) => row.code === 'HOME')?.id ?? '';
  });
});

/** An active loan with one instalment overdue by `daysOverdue`. */
async function activeLoanOverdueBy(daysOverdue: number, productId: string): Promise<string> {
  return db.withTenantTransaction(
    { institutionId: INSTITUTION, userId: officerId },
    async (client) => {
      const loan = await client.query<{ id: string }>(
        `INSERT INTO loans
           (institution_id, branch_id, client_id, product_id, principal, monthly_rate,
            interest_method, term_months, status, submitted_by, submitted_at,
            decided_by, decided_at, disbursed_by, disbursement_date, outstanding_balance)
         VALUES ($1, $2, $3, $4, '1000000.00', '0.0200', 'reducing_balance', 12,
                 'active', $5, now(), $6, now(), $6, CURRENT_DATE - 400, '1000000.00')
         RETURNING id`,
        [INSTITUTION, branchId, clientId, productId, officerId, managerId],
      );
      const loanId = loan.rows[0]?.id ?? '';

      if (daysOverdue > 0) {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date, principal_due, interest_due, total_due)
           VALUES ($1, $2, 1, CURRENT_DATE - $3::integer, '80000.00', '20000.00', '100000.00')`,
          [INSTITUTION, loanId, daysOverdue],
        );
      }

      return loanId;
    },
  );
}

const classify = async (): Promise<number> =>
  db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
    const result = await client.query<{ unclassifiable: number }>(
      'SELECT update_overdue_classifications($1) AS unclassifiable',
      [INSTITUTION],
    );
    return result.rows[0]?.unclassifiable ?? -1;
  });

const loanState = async (
  loanId: string,
): Promise<{ days_overdue: number | null; overdue_class: string | null } | undefined> =>
  db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
    const result = await client.query<{
      days_overdue: number | null;
      overdue_class: string | null;
    }>('SELECT days_overdue, overdue_class FROM loans WHERE id = $1', [loanId]);
    return result.rows[0];
  });

describe('classifying against BOT’s standard schedule', () => {
  it.each([
    [0, 'current'],
    [3, 'current'],
    [5, 'current'],
    [6, 'esm'],
    [30, 'esm'],
    [31, 'substandard'],
    [60, 'substandard'],
    [61, 'doubtful'],
    [90, 'doubtful'],
    [91, 'loss'],
    [400, 'loss'],
  ])('places a loan %i days overdue in %s', async (days, expected) => {
    const loanId = await activeLoanOverdueBy(days, standardProductId);

    await classify();

    const state = await loanState(loanId);
    expect(state?.days_overdue).toBe(days);
    expect(state?.overdue_class).toBe(expected);
  });

  it('agrees with the domain classifier', async () => {
    // Two implementations, deliberately: the domain produces a result an
    // operator can act on, the database function does the bulk update. They
    // must not disagree about where a loan sits.
    const bands = await pool.query<{
      classification: string;
      min_days_overdue: number;
      max_days_overdue: number | null;
      provision_rate: string;
    }>(
      `SELECT classification, min_days_overdue, max_days_overdue, provision_rate
         FROM reference.provisioning_bands WHERE schedule_code = 'standard'
        ORDER BY min_days_overdue`,
    );
    const domainBands: ProvisioningBand[] = bands.rows.map((row) => ({
      classification: row.classification as ProvisioningBand['classification'],
      minDaysOverdue: row.min_days_overdue,
      maxDaysOverdue: row.max_days_overdue,
      provisionRate: Percentage.fromFraction(row.provision_rate),
    }));

    for (const days of [0, 5, 6, 30, 31, 60, 61, 90, 91, 365]) {
      const loanId = await activeLoanOverdueBy(days, standardProductId);
      await classify();

      const stored = await loanState(loanId);
      const domain = classifyByDaysOverdue(days, domainBands);

      expect(domain.classified).toBe(true);
      if (domain.classified) {
        expect(stored?.overdue_class).toBe(domain.classification);
      }
    }
  });

  it('measures from the oldest arrear, not the newest', async () => {
    // A borrower who misses January and pays February is still three months
    // late on January. Classifying on the newest missed instalment would reset
    // the clock every time a partial payment arrived.
    const loanId = await activeLoanOverdueBy(120, standardProductId);
    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      await client.query(
        `INSERT INTO repayment_schedules
           (institution_id, loan_id, month_number, due_date, principal_due, interest_due, total_due)
         VALUES ($1, $2, 2, CURRENT_DATE - 10, '80000.00', '20000.00', '100000.00')`,
        [INSTITUTION, loanId],
      );
    });

    await classify();

    expect((await loanState(loanId))?.days_overdue).toBe(120);
    expect((await loanState(loanId))?.overdue_class).toBe('loss');
  });

  it('ignores instalments already paid', async () => {
    const loanId = await activeLoanOverdueBy(120, standardProductId);
    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      await client.query('UPDATE repayment_schedules SET is_paid = true WHERE loan_id = $1', [
        loanId,
      ]);
    });

    await classify();

    expect((await loanState(loanId))?.days_overdue).toBe(0);
    expect((await loanState(loanId))?.overdue_class).toBe('current');
  });
});

describe('the housing schedule gap', () => {
  it('classifies a housing loan past 91 days', async () => {
    const loanId = await activeLoanOverdueBy(100, housingProductId);

    await classify();

    // 25%, where any other loan at 100 days would be at 100%.
    expect((await loanState(loanId))?.overdue_class).toBe('substandard');
  });

  it.each([0, 40, 90])(
    'leaves a housing loan %i days overdue unclassified rather than guessing',
    async (days) => {
      // BOT's housing schedule begins at 91 days and defines nothing below it
      // (§11.5). Defaulting these into `current` would understate provisions
      // and file a wrong MSP2-03; leaving them NULL and counting them puts the
      // gap in front of an operator.
      const loanId = await activeLoanOverdueBy(days, housingProductId);

      const unclassifiable = await classify();

      expect((await loanState(loanId))?.overdue_class).toBeNull();
      expect(unclassifiable).toBe(1);
    },
  );

  it('records the count on the institution’s health row', async () => {
    await activeLoanOverdueBy(40, housingProductId);
    await activeLoanOverdueBy(10, standardProductId);

    await classify();

    const health = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ unclassifiable_loan_count: number }>(
          'SELECT unclassifiable_loan_count FROM system_health WHERE institution_id = $1',
          [INSTITUTION],
        );
        return result.rows[0];
      },
    );

    expect(health?.unclassifiable_loan_count).toBe(1);
  });
});

describe('freshness gating', () => {
  it('reports an institution that has never been classified as not fresh', async () => {
    const fresh = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ fresh: boolean }>(
        'SELECT classifications_are_fresh($1) AS fresh',
        [INSTITUTION],
      );
      return result.rows[0]?.fresh;
    });

    expect(fresh).toBe(false);
  });

  it('reports fresh immediately after a run', async () => {
    await activeLoanOverdueBy(10, standardProductId);
    await classify();

    const fresh = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ fresh: boolean }>(
        'SELECT classifications_are_fresh($1) AS fresh',
        [INSTITUTION],
      );
      return result.rows[0]?.fresh;
    });

    expect(fresh).toBe(true);
  });

  it('reports stale once the run is older than the limit', async () => {
    // The R5 failure, made detectable: the job stopping is now something the
    // system notices rather than something nobody finds out about until a
    // return is queried.
    await activeLoanOverdueBy(10, standardProductId);
    await classify();

    await db.withTransaction(async (client) => {
      await client.query(
        `UPDATE system_health SET classifications_updated_at = now() - interval '48 hours'
          WHERE institution_id = $1`,
        [INSTITUTION],
      );
    });

    const fresh = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ fresh: boolean }>(
        'SELECT classifications_are_fresh($1) AS fresh',
        [INSTITUTION],
      );
      return result.rows[0]?.fresh;
    });

    expect(fresh).toBe(false);
  });

  it('reports not fresh while any loan is unclassifiable, however recent the run', async () => {
    await activeLoanOverdueBy(40, housingProductId);
    await classify();

    const fresh = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ fresh: boolean }>(
        'SELECT classifications_are_fresh($1) AS fresh',
        [INSTITUTION],
      );
      return result.rows[0]?.fresh;
    });

    expect(fresh).toBe(false);
  });

  it('agrees with the domain readiness assessment', async () => {
    await activeLoanOverdueBy(40, housingProductId);
    await classify();

    const health = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{
          classifications_updated_at: Date | null;
          unclassifiable_loan_count: number;
        }>(
          `SELECT classifications_updated_at, unclassifiable_loan_count
             FROM system_health WHERE institution_id = $1`,
          [INSTITUTION],
        );
        return result.rows[0];
      },
    );

    const readiness = assessReportingReadiness({
      classificationsUpdatedAt: health?.classifications_updated_at ?? null,
      unclassifiableLoanCount: health?.unclassifiable_loan_count ?? 0,
      now: new Date(),
    });

    expect(readiness.ready).toBe(false);
    if (!readiness.ready) {
      expect(readiness.problems.map((entry) => entry.problem)).toContain('unclassifiable_loans');
    }
  });
});

describe('the health record', () => {
  it('is read-only to the application', async () => {
    await activeLoanOverdueBy(10, standardProductId);
    await classify();

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `UPDATE system_health SET classifications_updated_at = now() WHERE institution_id = $1`,
          [INSTITUTION],
        );
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('only counts active loans', async () => {
    // A draft or rejected application has no arrears to classify.
    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      await client.query(
        `INSERT INTO loans
           (institution_id, branch_id, client_id, product_id, principal, monthly_rate,
            interest_method, term_months, status)
         VALUES ($1, $2, $3, $4, '500000.00', '0.0200', 'reducing_balance', 6, 'draft')`,
        [INSTITUTION, branchId, clientId, standardProductId],
      );
    });

    await classify();

    const drafts = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ classified_at: Date | null }>(
          `SELECT classified_at FROM loans WHERE status = 'draft'`,
        );
        return result.rows[0];
      },
    );

    expect(drafts?.classified_at).toBeNull();
  });
});
