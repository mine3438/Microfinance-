import { randomUUID } from 'node:crypto';

import {
  APPLICATION_FEE_AMOUNT,
  type ApplicationFee,
  type ErrorResponse,
  type Loan,
  type Payment,
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
 * The TZS 5,000 application/form fee.
 *
 * The approved rules are FEE-01…03 in `04-DECISION-REGISTER.md`. What most of
 * this suite guards is the list of things the fee must *not* do: it is not
 * added to principal, not deducted from disbursement, earns no interest, never
 * enters the repayment schedule, and never reaches the repayment allocator —
 * whose fee bucket keeps its fixed position and still allocates nil.
 *
 * Those are the assertions that would fail quietly if somebody later decided
 * the fee "obviously" belongs on the loan.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let managerToken: string;
let adminToken: string;
let productId: string;
let clientId: string;

const PRINCIPAL = '1000000.00';

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  managerToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['branch_manager']),
  );
  adminToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']),
  );

  const reference = await harness.database.withTransaction(async (client) => {
    const district = await client.query<{ code: string }>(
      'SELECT code FROM reference.districts ORDER BY code LIMIT 1',
    );
    const sector = await client.query<{ code: string }>(
      'SELECT code FROM reference.sectors ORDER BY code LIMIT 1',
    );
    const loanType = await client.query<{ code: string }>(
      'SELECT code FROM reference.loan_types ORDER BY code LIMIT 1',
    );
    return {
      district: district.rows[0]!.code,
      sector: sector.rows[0]!.code,
      loanType: loanType.rows[0]!.code,
    };
  });

  productId = await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal)
         VALUES ($1, 'FEE', 'Application Fee Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Neema Joseph',
      gender: 'female',
      dateOfBirth: '1988-02-11',
      phone: '0716555777',
      districtCode: reference.district,
      sectorCode: reference.sector,
    })
  ).json<{ id: string }>().id;

  await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'branch_manager', 50000000.00)
         ON CONFLICT (institution_id, role_code)
           DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [officer.institutionId],
      );
    },
  );
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
  method: 'GET' | 'POST' | 'PATCH',
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

/** A fresh application, sitting as a draft. */
async function application(): Promise<Loan> {
  return (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal: PRINCIPAL,
      monthlyRate: '0.0200',
      termMonths: 10,
    })
  ).json<Loan>();
}

/**
 * Every application fee ever collected against one application, summed.
 *
 * Summed with Money rather than Number: these assertions exist to prove an
 * invariant about money, and a float sum could agree with a broken one.
 */
async function collectionsFor(loanId: string): Promise<Money> {
  const rows = await harness.database.withTransaction(async (client) =>
    client.query<{ amount: string }>(
      'SELECT amount FROM loan_application_fees WHERE loan_id = $1',
      [loanId],
    ),
  );
  return Money.sum(rows.rows.map((row) => Money.fromDatabaseValue(row.amount)));
}

/** Every application fee actually handed back, summed. */
async function refundsFor(loanId: string): Promise<Money> {
  const rows = await harness.database.withTransaction(async (client) =>
    client.query<{ amount: string }>(
      'SELECT amount FROM loan_application_fees WHERE loan_id = $1 AND refunded_at IS NOT NULL',
      [loanId],
    ),
  );
  return Money.sum(rows.rows.map((row) => Money.fromDatabaseValue(row.amount)));
}

describe('collecting the fee', () => {
  it('records TZS 5,000 without being told the amount', async () => {
    const loan = await application();

    const response = await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {
      method: 'Cash',
      reference: 'FRM-9912',
    });

    expect(response.statusCode).toBe(201);
    const fee = response.json<ApplicationFee>();

    // The charge is fixed policy. A request that could state it would let a
    // counter typo become the fee.
    expect(fee.amount).toBe(APPLICATION_FEE_AMOUNT);
    expect(fee.amount).toBe('5000.00');
    expect(fee.state).toBe('collected');
    expect(fee.collectedBy).toBe(officer.userId);
  });

  it('refuses a second fee for the same application', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    const second = await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    expect(second.statusCode).toBe(409);
  });

  it('refuses a future-dated collection', async () => {
    const loan = await application();

    const response = await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {
      collectedOn: '2099-01-01',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses collection once the application has been decided', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });

    const response = await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    expect(response.statusCode).toBe(422);
  });

  it('refuses an application in another institution', async () => {
    const loan = await application();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    expect(
      (await request('POST', `/loans/${loan.id}/application-fee`, await tokenFor(stranger), {}))
        .statusCode,
    ).toBe(404);
  });
});

describe('the fee is not part of the loan', () => {
  it('does not change the principal or the disbursed balance', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });
    await request('POST', `/loans/${loan.id}/disbursement`, adminToken, {
      disbursementDate: '2026-01-10',
    });

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();

    // Not added to principal, and not deducted from what was advanced. The
    // borrower owes exactly what they borrowed.
    expect(after.principal).toBe(PRINCIPAL);
    expect(after.outstandingBalance).toBe(PRINCIPAL);
  });

  it('leaves the repayment allocator’s fee bucket at nil', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });
    await request('POST', `/loans/${loan.id}/disbursement`, adminToken, {
      disbursementDate: '2026-01-10',
    });

    const recorded = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '50000.00',
    });

    const payment = recorded.json<Payment>();

    // The bucket's *position* is fixed and must stay fixed; its *value* stays
    // nil. A collected application fee must not start filling it, because that
    // would change how a repayment splits.
    expect(payment.allocation.fee).toBe('0.00');

    const parts = Money.sum(
      [
        payment.allocation.penalty,
        payment.allocation.fee,
        payment.allocation.interest,
        payment.allocation.principal,
        payment.allocation.unallocated,
      ].map((part) => Money.fromDatabaseValue(part)),
    );
    expect(parts.toDatabaseValue()).toBe(payment.amountPaid);
  });

  it('creates no payment row and no schedule row', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    const counts = await harness.database.withTransaction(async (client) =>
      client.query<{ payments: string; schedules: string }>(
        `SELECT (SELECT count(*) FROM payments WHERE loan_id = $1)::text AS payments,
                (SELECT count(*) FROM repayment_schedules WHERE loan_id = $1)::text AS schedules`,
        [loan.id],
      ),
    );

    // The fee earns no interest and is not repaid, so it has no business in
    // either table. Asserted because "separate" is a claim the schema has to
    // keep making.
    expect(counts.rows[0]!.payments).toBe('0');
    expect(counts.rows[0]!.schedules).toBe('0');
  });
});

describe('the outcome of the application', () => {
  it('is retained when the application is approved', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });

    const fee = (
      await request('GET', `/loans/${loan.id}/application-fee`, officerToken)
    ).json<ApplicationFee>();

    expect(fee.state).toBe('retained');
  });

  it('falls due for refund when the application is rejected', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, {
      decision: 'reject',
      reason: 'Security offered is insufficient for the amount requested.',
    });

    const fee = (
      await request('GET', `/loans/${loan.id}/application-fee`, officerToken)
    ).json<ApplicationFee>();

    // Rejection returns the application to the officer as a draft, so the state
    // is derived from the recorded rejection rather than from `status`.
    expect(fee.state).toBe('refund_due');
  });

  it('is refunded without erasing the collection', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {
      method: 'Cash',
      reference: 'FRM-4410',
    });
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, {
      decision: 'reject',
      reason: 'Insufficient security.',
    });

    const refunded = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      { reason: 'Application declined.' },
    );

    expect(refunded.statusCode).toBe(200);
    const fee = refunded.json<ApplicationFee>();

    expect(fee.state).toBe('refunded');
    expect(fee.refundedOn).not.toBeNull();
    // The collection survives the refund. Who took it, when, how and against
    // what reference are the evidence, and a refund is a second fact rather
    // than a deletion of the first.
    expect(fee.collectedBy).toBe(officer.userId);
    expect(fee.reference).toBe('FRM-4410');
    expect(fee.amount).toBe(APPLICATION_FEE_AMOUNT);
  });

  it('refuses a second refund', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, {
      decision: 'reject',
      reason: 'Declined.',
    });
    await request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {});

    const second = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );

    expect(second.statusCode).toBe(409);
  });

  it('refuses a refund on an approved application', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });

    const response = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('approved');
  });

  it('refuses a refund while the application is still under consideration', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);

    const response = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );

    expect(response.statusCode).toBe(422);
  });
});

describe('the collection record cannot be rewritten', () => {
  it('refuses an attempt to amend what was collected', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    // No endpoint offers this; the guard is at the database, for anything that
    // reaches the table by another route.
    await expect(
      harness.database.withTransaction(async (client) =>
        client.query('UPDATE loan_application_fees SET amount = 1.00 WHERE loan_id = $1', [
          loan.id,
        ]),
      ),
    ).rejects.toThrow(/cannot be amended/);
  });
});

/**
 * FEE-04a — charged once per application, not once per submission.
 *
 * The decided rule, and the reason it needed deciding: rejection in this system
 * is not a resting state. Migration 0023 moves a rejected application through
 * `rejected` and on to `draft` so the officer can revise it, and `submit` does
 * not clear the rejection reason. Anything that read `status` to decide whether
 * a refund was owed would hand the entitlement back and take it away again as
 * the file moved through the queue.
 *
 * So entitlement is keyed on the recorded rejection decision, and is consumed
 * by at most one refund per collection. Those two facts together are what stop
 * a free resubmission cycle from manufacturing money.
 */
describe('FEE-04a: once per application', () => {
  /** Take an application through submit and a rejection, leaving it as a draft. */
  async function rejectOnce(loanId: string, reason = 'Security offered is insufficient.') {
    await request('POST', `/loans/${loanId}/submit`, officerToken);
    const decided = await request('POST', `/loans/${loanId}/decision`, managerToken, {
      decision: 'reject',
      reason,
    });
    expect(decided.statusCode).toBe(200);
  }

  const feeFor = async (loanId: string): Promise<ApplicationFee> =>
    (await request('GET', `/loans/${loanId}/application-fee`, officerToken)).json<ApplicationFee>();

  it('charges once and never refunds on a straightforward approval', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    await request('POST', `/loans/${loan.id}/decision`, managerToken, { decision: 'approve' });

    const fee = await feeFor(loan.id);

    expect(fee.state).toBe('retained');
    expect(fee.refundedOn).toBeNull();
    expect((await collectionsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('0.00');
  });

  it('keeps the entitlement after the rejected-to-draft transition', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    // The status is back at `draft` — the officer's queue shows work to do —
    // and the entitlement survives it, because it was earned by the decision.
    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();
    expect(after.status).toBe('draft');
    expect((await feeFor(loan.id)).state).toBe('refund_due');
  });

  it('keeps the entitlement through a free resubmission', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    await request('POST', `/loans/${loan.id}/submit`, officerToken);

    // This is the case that a status-based rule got wrong: resubmitted, so the
    // status is `pending_approval` again, and the money is still owed.
    expect((await feeFor(loan.id)).state).toBe('refund_due');
  });

  it('charges nothing extra when a rejected application is revised and resubmitted', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);
    await request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {});

    // Resubmit for free. A second collection is refused because the fee belongs
    // to the application, not to the attempt.
    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    const second = await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    expect(second.statusCode).toBe(409);
    expect((await collectionsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
  });

  it('totals 5,000 collected and 5,000 refunded across a full reject-refund-approve cycle', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);
    await request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {});

    await request('POST', `/loans/${loan.id}/submit`, officerToken);
    const approved = await request('POST', `/loans/${loan.id}/decision`, managerToken, {
      decision: 'approve',
    });
    expect(approved.statusCode).toBe(200);

    // Nothing is recollected merely because the later attempt succeeded.
    expect((await collectionsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
    expect((await feeFor(loan.id)).state).toBe('refunded');
  });

  it('does not create a second entitlement on a second rejection', async () => {
    // The invariant that stops money being made from nothing: collect once,
    // refund once, resubmit free, get rejected again — and there is no second
    // 5,000 to hand back, because there was no second 5,000 taken.
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);
    await request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {});

    await rejectOnce(loan.id, 'Still insufficient.');

    const second = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );

    expect(second.statusCode).toBe(409);
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
  });

  it('never refunds more than was collected, however many cycles run', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});

    for (const reason of ['First look.', 'Second look.', 'Third look.']) {
      await rejectOnce(loan.id, reason);
      await request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {});
    }

    // Summed with Money, not with Number: this is the assertion that would let
    // a rounding artefact hide a real imbalance.
    const collected = await collectionsFor(loan.id);
    const refunded = await refundsFor(loan.id);

    expect(collected.toDatabaseValue()).toBe('5000.00');
    expect(refunded.toDatabaseValue()).toBe('5000.00');
    expect(refunded.lessThan(collected) || refunded.equals(collected)).toBe(true);
  });

  it('refuses a duplicate refund without recording a second financial event', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    const first = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );
    const second = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      officerToken,
      {},
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
  });

  it('lets at most one of two simultaneous refunds succeed', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    // The guard is the `refunded_at IS NULL` predicate on the UPDATE, so the
    // two contend on the write rather than on a check-then-act.
    const [a, b] = await Promise.all([
      request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {}),
      request('POST', `/loans/${loan.id}/application-fee/refund`, officerToken, {}),
    ]);

    const succeeded = [a, b].filter((response) => response.statusCode === 200);
    expect(succeeded).toHaveLength(1);
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('5000.00');
  });

  it('refuses a refund from a caller who cannot handle money', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    // The auditor reads everything and touches nothing.
    const auditor = await seedUserIn(officer.institutionId, officer.branchId, ['auditor']);

    expect(
      (
        await request(
          'POST',
          `/loans/${loan.id}/application-fee/refund`,
          await tokenFor(auditor),
          {},
        )
      ).statusCode,
    ).toBe(403);
  });

  it('refuses a refund against another institution’s application', async () => {
    const loan = await application();
    await request('POST', `/loans/${loan.id}/application-fee`, officerToken, {});
    await rejectOnce(loan.id);

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await request(
      'POST',
      `/loans/${loan.id}/application-fee/refund`,
      await tokenFor(stranger),
      {},
    );

    expect(response.statusCode).toBe(404);
    expect((await refundsFor(loan.id)).toDatabaseValue()).toBe('0.00');
  });
});
