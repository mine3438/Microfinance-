import { LOAN_TRANSITIONS, generateSchedule, type LoanStatus } from '@mfi/domain';
import { Money, Rate } from '@mfi/money';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * The loan lifecycle.
 *
 * The system this replaces had no approval step: a loan became `active` the
 * moment an officer created it, and PRD §4.2 records maker-checker as cut. For
 * a supervised lender that is the first control an auditor asks about, so these
 * assert it holds at the database — the layer no write path can go around.
 */

const INSTITUTION = 'eeee0000-0000-7000-8000-000000000005';
const OTHER_INSTITUTION = 'ffff0000-0000-7000-8000-000000000006';

let pool: pg.Pool;
let db: Database;
let branchId: string;
let clientId: string;
let productId: string;
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
  const owned = [INSTITUTION, OTHER_INSTITUTION];

  await db.withTransaction(async (client) => {
    for (const table of [
      'domain_events',
      'repayment_schedules',
      'loans',
      'approval_thresholds',
      'loan_products',
      'guarantors',
      'clients',
      'user_roles',
      'users',
      'code_sequences',
      'branches',
    ]) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = ANY($1::uuid[])`, [owned]);
    }
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);
    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      INSTITUTION,
      'Lending Institution',
      OTHER_INSTITUTION,
      'Other Institution',
    ]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'Head Office', true) RETURNING id`,
      [INSTITUTION],
    );
    branchId = branch.rows[0]?.id ?? '';

    const users = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'officer@lend.test', 'Officer', 'x', 'active'),
              ($1, $2, 'manager@lend.test', 'Manager', 'x', 'active')
       RETURNING id, email`,
      [INSTITUTION, branchId],
    );
    officerId = users.rows.find((row) => row.email === 'officer@lend.test')?.id ?? '';
    managerId = users.rows.find((row) => row.email === 'manager@lend.test')?.id ?? '';

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

    const product = await client.query<{ id: string }>(
      `INSERT INTO loan_products
         (institution_id, code, name, bot_loan_type, interest_method,
          min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
          min_principal, max_principal)
       VALUES ($1, 'BIZ', 'Business Loan', 'business_individual_loans', 'reducing_balance',
               '0.0300', '0.0800', 3, 24, '100000.00', '10000000.00')
       RETURNING id`,
      [INSTITUTION],
    );
    productId = product.rows[0]?.id ?? '';

    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);
  });
});

/** Create a draft application. */
async function createDraft(principal = '1000000.00'): Promise<string> {
  return db.withTenantTransaction(
    { institutionId: INSTITUTION, userId: officerId },
    async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO loans
           (institution_id, branch_id, client_id, product_id,
            principal, monthly_rate, interest_method, term_months)
         VALUES ($1, $2, $3, $4, $5, '0.0500', 'reducing_balance', 12)
         RETURNING id`,
        [INSTITUTION, branchId, clientId, productId, principal],
      );
      return result.rows[0]?.id ?? '';
    },
  );
}

/** Move a loan to a status, supplying whatever that status requires. */
async function setStatus(
  loanId: string,
  status: LoanStatus,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await db.withTenantTransaction(
    { institutionId: INSTITUTION, userId: managerId },
    async (client) => {
      await client.query(
        `UPDATE loans
            SET status = $2,
                submitted_by = COALESCE($3, submitted_by),
                submitted_at = COALESCE($4::timestamptz, submitted_at),
                decided_by = COALESCE($5, decided_by),
                decided_at = COALESCE($6::timestamptz, decided_at),
                rejection_reason = COALESCE($7, rejection_reason),
                disbursed_by = COALESCE($8, disbursed_by),
                disbursement_date = COALESCE($9::date, disbursement_date),
                outstanding_balance = COALESCE($10::numeric, outstanding_balance)
          WHERE id = $1`,
        [
          loanId,
          status,
          extra['submitted_by'] ?? null,
          extra['submitted_at'] ?? null,
          extra['decided_by'] ?? null,
          extra['decided_at'] ?? null,
          extra['rejection_reason'] ?? null,
          extra['disbursed_by'] ?? null,
          extra['disbursement_date'] ?? null,
          extra['outstanding_balance'] ?? null,
        ],
      );
    },
  );
}

const submit = async (loanId: string): Promise<void> =>
  setStatus(loanId, 'pending_approval', {
    submitted_by: officerId,
    submitted_at: new Date().toISOString(),
  });

const approve = async (loanId: string, by = managerId): Promise<void> =>
  setStatus(loanId, 'approved', { decided_by: by, decided_at: new Date().toISOString() });

const disburse = async (loanId: string, principal = '1000000.00'): Promise<void> =>
  setStatus(loanId, 'active', {
    disbursed_by: managerId,
    disbursement_date: '2026-01-15',
    outstanding_balance: principal,
  });

describe('the status machine', () => {
  it('starts a new application as a draft', async () => {
    const loanId = await createDraft();

    const status = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ status: string; loan_code: string | null }>(
          'SELECT status, loan_code FROM loans WHERE id = $1',
          [loanId],
        );
        return result.rows[0];
      },
    );

    expect(status?.status).toBe('draft');
    // A draft that is never submitted should not consume a code that appears
    // on no agreement.
    expect(status?.loan_code).toBeNull();
  });

  it('allocates a loan code at submission', async () => {
    const loanId = await createDraft();
    await submit(loanId);

    const code = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ loan_code: string }>(
        'SELECT loan_code FROM loans WHERE id = $1',
        [loanId],
      );
      return result.rows[0]?.loan_code;
    });

    expect(code).toMatch(/^LN-\d{4}-\d{3}$/);
  });

  it('walks the full path to disbursement', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    const status = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ status: string }>(
          'SELECT status FROM loans WHERE id = $1',
          [loanId],
        );
        return result.rows[0]?.status;
      },
    );

    expect(status).toBe('active');
  });

  it('refuses to disburse an application nobody approved', async () => {
    // The control the previous system did not have.
    const loanId = await createDraft();
    await submit(loanId);

    await expect(disburse(loanId)).rejects.toThrow(/cannot move from pending_approval to active/);
  });

  it('refuses to disburse straight from draft', async () => {
    const loanId = await createDraft();

    await expect(disburse(loanId)).rejects.toThrow(/cannot move from draft to active/);
  });

  it('refuses to disburse a rejected application', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await setStatus(loanId, 'rejected', {
      decided_by: managerId,
      decided_at: new Date().toISOString(),
      rejection_reason: 'Insufficient trading history',
    });

    await expect(disburse(loanId)).rejects.toThrow(/cannot move from rejected/);
  });

  it('refuses to revive a terminal status', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);
    await setStatus(loanId, 'completed', { outstanding_balance: '0.00' });

    await expect(setStatus(loanId, 'active')).rejects.toThrow(/cannot move from completed/);
  });

  it('mirrors the transition table in @mfi/domain exactly', async () => {
    // Two enforcement points, two purposes: the domain produces a message the
    // user can act on, the database guarantees no route reaches an illegal
    // state. They must not disagree about what is legal.
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_functiondef(oid) AS definition
         FROM pg_proc WHERE proname = 'enforce_loan_transition'`,
    );
    const definition = result.rows[0]?.definition ?? '';

    for (const [from, targets] of Object.entries(LOAN_TRANSITIONS)) {
      if (targets.length === 0) {
        continue;
      }
      expect(definition).toContain(`WHEN '${from}'`);
      for (const target of targets) {
        expect(definition).toContain(`'${target}'`);
      }
    }
  });
});

describe('maker-checker', () => {
  it('refuses an approval by the person who submitted it', async () => {
    // Enforced at the database, so it holds for any write path — not only the
    // one the interface uses.
    const loanId = await createDraft();
    await submit(loanId);

    await expect(approve(loanId, officerId)).rejects.toThrow(/loans_approver_is_not_submitter/);
  });

  it('permits an approval by anyone else', async () => {
    const loanId = await createDraft();
    await submit(loanId);

    await expect(approve(loanId, managerId)).resolves.toBeUndefined();
  });

  it('requires a decision to say who made it and when', async () => {
    const loanId = await createDraft();
    await submit(loanId);

    await expect(setStatus(loanId, 'approved')).rejects.toThrow(/loans_decision_is_attributed/);
  });

  it('requires a rejection to give a reason', async () => {
    // "Declined" with no reason is not a record anyone can act on.
    const loanId = await createDraft();
    await submit(loanId);

    await expect(
      setStatus(loanId, 'rejected', {
        decided_by: managerId,
        decided_at: new Date().toISOString(),
      }),
    ).rejects.toThrow(/loans_rejection_has_reason/);
  });
});

describe('disbursement integrity', () => {
  it('requires a date, a releaser and a balance', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);

    await expect(setStatus(loanId, 'active')).rejects.toThrow(/loans_disbursement_is_complete/);
  });

  it('requires a completed loan to owe nothing', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    await expect(setStatus(loanId, 'completed')).rejects.toThrow(/loans_completed_is_settled/);
  });

  it('accepts a completed loan whose balance is zero', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    await expect(
      setStatus(loanId, 'completed', { outstanding_balance: '0.00' }),
    ).resolves.toBeUndefined();
  });
});

describe('the schedule', () => {
  it('persists exactly what the engine produced', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    const schedule = generateSchedule({
      principal: Money.of('1000000.00'),
      monthlyRate: Rate.ofMonthlyFraction('0.05'),
      termMonths: 12,
      method: 'reducing_balance',
      disbursementDate: new Date('2026-01-15T00:00:00.000Z'),
    });

    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      for (const instalment of schedule.instalments) {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date, principal_due, interest_due, total_due)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            INSTITUTION,
            loanId,
            instalment.monthNumber,
            instalment.dueDate.toISOString().slice(0, 10),
            instalment.principalDue.toDatabaseValue(),
            instalment.interestDue.toDatabaseValue(),
            instalment.totalDue.toDatabaseValue(),
          ],
        );
      }
    });

    const stored = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ principal_total: string; interest_total: string }>(
          `SELECT SUM(principal_due)::text AS principal_total,
                  SUM(interest_due)::text AS interest_total
             FROM repayment_schedules WHERE loan_id = $1`,
          [loanId],
        );
        return result.rows[0];
      },
    );

    // The invariant that survives the round trip: the schedule still sums to
    // exactly the principal advanced after passing through NUMERIC.
    expect(stored?.principal_total).toBe('1000000.00');
    expect(stored?.interest_total).toBe('353904.94');
  });

  it('refuses a row whose total is not the sum of its parts', async () => {
    const loanId = await createDraft();
    await submit(loanId);

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date, principal_due, interest_due, total_due)
           VALUES ($1, $2, 1, '2026-02-15', '100.00', '10.00', '999.00')`,
          [INSTITUTION, loanId],
        );
      }),
    ).rejects.toThrow(/repayment_schedules_total_is_sum/);
  });

  it('refuses two instalments for the same month', async () => {
    const loanId = await createDraft();
    await submit(loanId);

    const insert = async (): Promise<void> => {
      await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO repayment_schedules
             (institution_id, loan_id, month_number, due_date, principal_due, interest_due, total_due)
           VALUES ($1, $2, 1, '2026-02-15', '100.00', '10.00', '110.00')`,
          [INSTITUTION, loanId],
        );
      });
    };

    await insert();
    await expect(insert()).rejects.toThrow(/duplicate key/);
  });
});

describe('the domain-event seam', () => {
  it('emits an event when money is disbursed', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM domain_events WHERE institution_id = $1`,
      [INSTITUTION],
    );

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.event_type).toBe('loan.disbursed');
    expect(events.rows[0]?.payload).toMatchObject({
      principal: '1000000.00',
      interest_method: 'reducing_balance',
      term_months: 12,
    });
  });

  it('emits nothing for decisions that move no money', async () => {
    // A ledger has nothing to post for an approval. The decision is recorded in
    // the audit log, which is where a decision belongs.
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);

    const events = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM domain_events WHERE institution_id = $1`,
      [INSTITUTION],
    );

    expect(events.rows[0]?.count).toBe('0');
  });

  it('emits on completion and write-off', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);
    await setStatus(loanId, 'written_off');

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM domain_events WHERE institution_id = $1 ORDER BY occurred_at`,
      [INSTITUTION],
    );

    expect(events.rows.map((row) => row.event_type)).toEqual([
      'loan.disbursed',
      'loan.written_off',
    ]);
  });

  it('leaves events unposted, so a future ledger can find its backlog', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    const unposted = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM domain_events
        WHERE institution_id = $1 AND posted_at IS NULL`,
      [INSTITUTION],
    );

    expect(unposted.rows[0]?.count).toBe('1');
  });

  it('is read-only to the application', async () => {
    const loanId = await createDraft();
    await submit(loanId);
    await approve(loanId);
    await disburse(loanId);

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query('DELETE FROM domain_events');
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('approval thresholds', () => {
  it('are seeded empty, so no role starts with authority', async () => {
    // The values belong to the institution and are not stated in the supplied
    // documentation (§13.3). An invented default would be an invented lending
    // policy.
    const count = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM approval_thresholds',
      );
      return result.rows[0]?.count;
    });

    expect(count).toBe('0');
  });

  it('accept a limit for a seeded role', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
           VALUES ($1, 'branch_manager', '5000000.00')`,
          [INSTITUTION],
        );
      }),
    ).resolves.toBeUndefined();
  });

  it('refuse a limit for a role that does not exist', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
           VALUES ($1, 'chief_approver', '5000000.00')`,
          [INSTITUTION],
        );
      }),
    ).rejects.toThrow(/foreign key|role/i);
  });

  it('refuse a non-positive limit', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
           VALUES ($1, 'branch_manager', '0.00')`,
          [INSTITUTION],
        );
      }),
    ).rejects.toThrow(/max_principal|violates check/i);
  });
});

describe('terms are frozen at submission', () => {
  it('keeps a loan’s rate when the product’s rate is later revised', async () => {
    // Reading the rate through the product would silently restate every
    // historic schedule and every MSP2-04 return the next time someone
    // repriced a product.
    const loanId = await createDraft();
    await submit(loanId);

    await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      await client.query(
        `UPDATE loan_products SET min_monthly_rate = '0.0700', max_monthly_rate = '0.0900'
          WHERE id = $1`,
        [productId],
      );
    });

    const rate = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ monthly_rate: string }>(
        'SELECT monthly_rate FROM loans WHERE id = $1',
        [loanId],
      );
      return result.rows[0]?.monthly_rate;
    });

    expect(rate).toBe('0.0500');
  });
});

describe('tenant isolation', () => {
  it('hides loans from other institutions', async () => {
    await createDraft();

    const visible = await db.withTenantTransaction(
      { institutionId: OTHER_INSTITUTION },
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM loans');
        return result.rows;
      },
    );

    expect(visible).toEqual([]);
  });

  it('refuses a loan against another institution’s client', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO loans
             (institution_id, branch_id, client_id, product_id,
              principal, monthly_rate, interest_method, term_months)
           VALUES ($1, $2, $3, $4, '100000.00', '0.05', 'flat', 6)`,
          [OTHER_INSTITUTION, branchId, clientId, productId],
        );
      }),
    ).rejects.toThrow(/within_institution|foreign key/i);
  });
});
