import { allocatePayment, amountApplied, balanceAfter, generateSchedule } from '@mfi/domain';
import { Money, Rate } from '@mfi/money';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Payments and reversals.
 *
 * The previous schema made payments immutable and never built the correcting
 * mechanism, so fixing a mis-keyed payment meant editing the database by hand —
 * which destroys the audit property the immutability was protecting (R9).
 * Immutability is kept here; a correction is a linked negating row, so both the
 * mistake and its correction stay visible.
 */

const INSTITUTION = '11110000-0000-7000-8000-00000000000a';
const OTHER_INSTITUTION = '22220000-0000-7000-8000-00000000000b';

let pool: pg.Pool;
let db: Database;
let loanId: string;
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
      'payments',
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
      'Repayment Institution',
      OTHER_INSTITUTION,
      'Other Institution',
    ]);

    const branch = await client.query<{ id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'Head Office', true) RETURNING id`,
      [INSTITUTION],
    );
    const branchId = branch.rows[0]?.id ?? '';

    const users = await client.query<{ id: string; email: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, 'officer@pay.test', 'Officer', 'x', 'active'),
              ($1, $2, 'manager@pay.test', 'Manager', 'x', 'active')
       RETURNING id, email`,
      [INSTITUTION, branchId],
    );
    officerId = users.rows.find((row) => row.email === 'officer@pay.test')?.id ?? '';
    managerId = users.rows.find((row) => row.email === 'manager@pay.test')?.id ?? '';

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

    const loan = await client.query<{ id: string }>(
      `INSERT INTO loans
         (institution_id, branch_id, client_id, product_id, principal, monthly_rate,
          interest_method, term_months, status, submitted_by, submitted_at,
          decided_by, decided_at, disbursed_by, disbursement_date, outstanding_balance)
       VALUES ($1, $2, $3, $4, '1000000.00', '0.0500', 'reducing_balance', 12,
               'active', $5, now(), $6, now(), $6, '2026-01-15', '1000000.00')
       RETURNING id`,
      [INSTITUTION, branchId, borrower.rows[0]?.id, product.rows[0]?.id, officerId, managerId],
    );
    loanId = loan.rows[0]?.id ?? '';

    await client.query('DELETE FROM domain_events WHERE institution_id = ANY($1::uuid[])', [owned]);
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);
  });
});

interface RecordedPayment {
  readonly id: string;
}

/**
 * Record a payment the way the application will: the domain computes the split
 * and the balance, and only the results are written.
 */
async function recordPayment(
  amount: string,
  interestDue: string,
  balanceBefore: string,
): Promise<RecordedPayment> {
  const allocation = allocatePayment({
    amountPaid: Money.of(amount),
    outstanding: { interest: Money.of(interestDue), principal: Money.of(balanceBefore) },
  });
  const after = balanceAfter(Money.of(balanceBefore), allocation);

  return db.withTenantTransaction(
    { institutionId: INSTITUTION, userId: officerId },
    async (client) => {
      const result = await client.query<{ id: string }>(
        `INSERT INTO payments
           (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
            unallocated_amount, balance_before, balance_after, date_paid, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '2026-02-15', $9)
         RETURNING id`,
        [
          INSTITUTION,
          loanId,
          allocation.amountPaid.toDatabaseValue(),
          amountApplied(allocation, 'interest').toDatabaseValue(),
          amountApplied(allocation, 'principal').toDatabaseValue(),
          allocation.unallocated.toDatabaseValue(),
          balanceBefore,
          after.toDatabaseValue(),
          officerId,
        ],
      );
      return { id: result.rows[0]?.id ?? '' };
    },
  );
}

describe('recording a payment', () => {
  it('stores the split the domain computed', async () => {
    await recordPayment('112825.41', '50000.00', '1000000.00');

    const stored = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{
          interest_portion: string;
          principal_portion: string;
          balance_after: string;
        }>(
          `SELECT interest_portion, principal_portion, balance_after FROM payments
            WHERE loan_id = $1`,
          [loanId],
        );
        return result.rows[0];
      },
    );

    expect(stored?.interest_portion).toBe('50000.00');
    expect(stored?.principal_portion).toBe('62825.41');
    expect(stored?.balance_after).toBe('937174.59');
  });

  it('refuses a split that does not sum to the amount', async () => {
    // Every shilling accounted for. A split that loses money leaves a balance
    // nobody can reconcile.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by)
           VALUES ($1, $2, '1000.00', '100.00', '100.00', '1000000.00', '999900.00', '2026-02-15', $3)`,
          [INSTITUTION, loanId, officerId],
        );
      }),
    ).rejects.toThrow(/payments_allocation_is_complete/);
  });

  it('refuses a balance that did not move by the principal applied', async () => {
    // Interest is a charge the payment settles; paying it does not reduce what
    // was borrowed.
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by)
           VALUES ($1, $2, '1000.00', '400.00', '600.00', '1000000.00', '999000.00', '2026-02-15', $3)`,
          [INSTITUTION, loanId, officerId],
        );
      }),
    ).rejects.toThrow(/payments_balance_moves_by_principal/);
  });

  it('refuses a zero payment', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, balance_before, balance_after,
              date_paid, recorded_by)
           VALUES ($1, $2, '0.00', '1000000.00', '1000000.00', '2026-02-15', $3)`,
          [INSTITUTION, loanId, officerId],
        );
      }),
    ).rejects.toThrow(/amount_paid|violates check/i);
  });

  it('records an overpayment as unallocated rather than absorbing it', async () => {
    await recordPayment('200000.00', '5372.64', '107452.79');

    const stored = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ unallocated_amount: string; balance_after: string }>(
          `SELECT unallocated_amount, balance_after FROM payments WHERE loan_id = $1`,
          [loanId],
        );
        return result.rows[0];
      },
    );

    expect(stored?.unallocated_amount).toBe('87174.57');
    expect(stored?.balance_after).toBe('0.00');
  });
});

describe('payments are immutable', () => {
  it('cannot be amended', async () => {
    // Evidence that can be edited is not evidence.
    await recordPayment('112825.41', '50000.00', '1000000.00');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(`UPDATE payments SET amount_paid = '1.00' WHERE loan_id = $1`, [loanId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('cannot be deleted', async () => {
    await recordPayment('112825.41', '50000.00', '1000000.00');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query('DELETE FROM payments WHERE loan_id = $1', [loanId]);
      }),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe('reversing a payment', () => {
  /** Undo a payment the way the application will: a linked negating row. */
  const reverse = async (
    paymentId: string,
    reason = 'Keyed against the wrong loan',
  ): Promise<void> => {
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: managerId },
      async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, penalty_portion, fee_portion,
              interest_portion, principal_portion, unallocated_amount,
              balance_before, balance_after, date_paid, recorded_by,
              reverses_payment_id, reversal_reason)
           SELECT institution_id, loan_id, -amount_paid, -penalty_portion, -fee_portion,
                  -interest_portion, -principal_portion, -unallocated_amount,
                  balance_after, balance_before, CURRENT_DATE, $2, id, $3
             FROM payments WHERE id = $1`,
          [paymentId, managerId, reason],
        );
      },
    );
  };

  it('records a correction without touching the original', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');
    await reverse(payment.id);

    const rows = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ amount_paid: string; reversal_reason: string | null }>(
        `SELECT amount_paid, reversal_reason FROM payments WHERE loan_id = $1 ORDER BY created_at`,
        [loanId],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(2);
    expect(rows[0]?.amount_paid).toBe('112825.41');
    expect(rows[1]?.amount_paid).toBe('-112825.41');
    expect(rows[1]?.reversal_reason).toBe('Keyed against the wrong loan');
  });

  it('leaves the loan net of the reversal at nothing paid', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');
    await reverse(payment.id);

    const net = await db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
      const result = await client.query<{ net: string }>(
        `SELECT COALESCE(SUM(amount_paid), 0)::text AS net FROM payments WHERE loan_id = $1`,
        [loanId],
      );
      return result.rows[0]?.net;
    });

    expect(net).toBe('0.00');
  });

  it('requires a reason', async () => {
    // A correction with no explanation is not a record anyone can act on.
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by, reverses_payment_id)
           VALUES ($1, $2, '-112825.41', '-50000.00', '-62825.41',
                   '937174.59', '1000000.00', CURRENT_DATE, $3, $4)`,
          [INSTITUTION, loanId, managerId, payment.id],
        );
      }),
    ).rejects.toThrow(/payments_sign_matches_kind/);
  });

  it('refuses a partial reversal', async () => {
    // A reversal that undoes some of a payment leaves the balance depending on
    // which rows a reader happens to sum.
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by,
              reverses_payment_id, reversal_reason)
           VALUES ($1, $2, '-50000.00', '-50000.00', '0.00',
                   '937174.59', '937174.59', CURRENT_DATE, $3, $4, 'partial')`,
          [INSTITUTION, loanId, managerId, payment.id],
        );
      }),
    ).rejects.toThrow(/negate its original exactly/);
  });

  it('refuses to reverse the same payment twice', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');
    await reverse(payment.id);

    await expect(reverse(payment.id, 'again')).rejects.toThrow(/duplicate key/i);
  });

  it('refuses to reverse a reversal', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');
    await reverse(payment.id);

    const reversalId = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{ id: string }>(
          'SELECT id FROM payments WHERE reverses_payment_id IS NOT NULL AND loan_id = $1',
          [loanId],
        );
        return result.rows[0]?.id ?? '';
      },
    );

    await expect(reverse(reversalId)).rejects.toThrow(/itself a reversal/);
  });

  it('refuses a positive amount on a reversal', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION }, async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by,
              reverses_payment_id, reversal_reason)
           VALUES ($1, $2, '112825.41', '50000.00', '62825.41',
                   '937174.59', '874349.18', CURRENT_DATE, $3, $4, 'wrong sign')`,
          [INSTITUTION, loanId, managerId, payment.id],
        );
      }),
      // Two guards catch this — the CHECK constraint on sign, and the trigger
      // requiring exact negation. The trigger runs BEFORE INSERT so its message
      // is the one that surfaces; either refusal is correct.
    ).rejects.toThrow(/negate its original exactly|payments_sign_matches_kind/);
  });
});

describe('the domain-event seam', () => {
  it('emits an event for a payment received', async () => {
    await recordPayment('112825.41', '50000.00', '1000000.00');

    const events = await pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM domain_events WHERE institution_id = $1`,
      [INSTITUTION],
    );

    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.event_type).toBe('payment.received');
    expect(events.rows[0]?.payload).toMatchObject({
      amount_paid: '112825.41',
      interest_portion: '50000.00',
      principal_portion: '62825.41',
    });
  });

  it('emits a distinct event for a reversal', async () => {
    const payment = await recordPayment('112825.41', '50000.00', '1000000.00');
    await db.withTenantTransaction(
      { institutionId: INSTITUTION, userId: managerId },
      async (client) => {
        await client.query(
          `INSERT INTO payments
             (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
              balance_before, balance_after, date_paid, recorded_by,
              reverses_payment_id, reversal_reason)
           SELECT institution_id, loan_id, -amount_paid, -interest_portion, -principal_portion,
                  balance_after, balance_before, CURRENT_DATE, $2, id, 'corrected'
             FROM payments WHERE id = $1`,
          [payment.id, managerId],
        );
      },
    );

    const events = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM domain_events WHERE institution_id = $1 ORDER BY occurred_at`,
      [INSTITUTION],
    );

    expect(events.rows.map((row) => row.event_type)).toEqual([
      'payment.received',
      'payment.reversed',
    ]);
  });
});

describe('a whole loan repaid', () => {
  it('closes at exactly zero across every instalment', async () => {
    // The property the entire financial stack exists to hold, exercised end to
    // end: the schedule engine produces the instalments, the allocator splits
    // each payment, the database stores them, and the loan finishes owing
    // nothing — not a shilling short, not a shilling over.
    const schedule = generateSchedule({
      principal: Money.of('1000000.00'),
      monthlyRate: Rate.ofMonthlyFraction('0.05'),
      termMonths: 12,
      method: 'reducing_balance',
      disbursementDate: new Date('2026-01-15T00:00:00.000Z'),
    });

    let balance = Money.of('1000000.00');

    for (const instalment of schedule.instalments) {
      const allocation = allocatePayment({
        amountPaid: instalment.totalDue,
        outstanding: { interest: instalment.interestDue, principal: balance },
      });
      const after = balanceAfter(balance, allocation);

      await db.withTenantTransaction(
        { institutionId: INSTITUTION, userId: officerId },
        async (client) => {
          await client.query(
            `INSERT INTO payments
               (institution_id, loan_id, amount_paid, interest_portion, principal_portion,
                unallocated_amount, balance_before, balance_after, date_paid, recorded_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              INSTITUTION,
              loanId,
              allocation.amountPaid.toDatabaseValue(),
              amountApplied(allocation, 'interest').toDatabaseValue(),
              amountApplied(allocation, 'principal').toDatabaseValue(),
              allocation.unallocated.toDatabaseValue(),
              balance.toDatabaseValue(),
              after.toDatabaseValue(),
              instalment.dueDate.toISOString().slice(0, 10),
              officerId,
            ],
          );
        },
      );

      balance = after;
    }

    const totals = await db.withTenantTransaction(
      { institutionId: INSTITUTION },
      async (client) => {
        const result = await client.query<{
          principal_repaid: string;
          interest_collected: string;
          final_balance: string;
        }>(
          `SELECT SUM(principal_portion)::text AS principal_repaid,
                  SUM(interest_portion)::text  AS interest_collected,
                  MIN(balance_after)::text     AS final_balance
             FROM payments WHERE loan_id = $1`,
          [loanId],
        );
        return result.rows[0];
      },
    );

    expect(balance.isZero()).toBe(true);
    expect(totals?.principal_repaid).toBe('1000000.00');
    expect(totals?.interest_collected).toBe('353904.94');
    expect(totals?.final_balance).toBe('0.00');
  });
});

describe('tenant isolation', () => {
  it('hides payments from other institutions', async () => {
    await recordPayment('112825.41', '50000.00', '1000000.00');

    const visible = await db.withTenantTransaction(
      { institutionId: OTHER_INSTITUTION },
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM payments');
        return result.rows;
      },
    );

    expect(visible).toEqual([]);
  });
});
