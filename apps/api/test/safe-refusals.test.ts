import { randomUUID } from 'node:crypto';

import { type Branch, type ErrorResponse, type Payment } from '@mfi/contracts';
import { Money } from '@mfi/money';
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
 * The behaviours that must not drift while a business decision is outstanding.
 *
 * Nothing here is new functionality. Each test pins an existing refusal or an
 * existing nil so that a later change cannot quietly turn an unanswered
 * question into an invented answer — which on a lending system means a
 * borrower's balance moving for a reason nobody decided.
 *
 * The head-office tests are the exception: that operation is new, and its
 * invariant is the reason it exists.
 */

let harness: Harness;
let manager: SeededUser;
let managerToken: string;
let adminToken: string;
let districtCode: string;
let sectorCode: string;
let productId: string;

beforeAll(async () => {
  harness = await startHarness();

  // A branch manager creates and approves within the branch; the administrator
  // disburses. Both are needed because the approval ladder refuses a maker who
  // is also the checker.
  manager = await seedUser(harness.database, { roles: ['branch_manager'] });
  managerToken = await tokenFor(manager);
  adminToken = await tokenFor(
    await seedUserIn(manager.institutionId, manager.branchId, ['institution_admin']),
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
  districtCode = reference.district;
  sectorCode = reference.sector;

  productId = await harness.database.withTenantTransaction(
    { institutionId: manager.institutionId },
    async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal)
         VALUES ($1, 'SAFE', 'Safe Refusals Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [manager.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  await harness.database.withTenantTransaction(
    { institutionId: manager.institutionId },
    async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'institution_admin', 50000000.00)
         ON CONFLICT (institution_id, role_code)
           DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [manager.institutionId],
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

  return harness.database.withTransaction(async (db) => {
    const user = await db.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Administrator', $4, 'active') RETURNING id`,
      [institutionId, branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await db.query(
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

/** A loan carried all the way to active, ready to receive money. */
async function disbursedLoan(principal: string): Promise<{ loanId: string }> {
  const clientId = (
    await request('POST', '/clients', managerToken, {
      fullName: 'Amina Hassan',
      gender: 'female',
      dateOfBirth: '1991-04-17',
      phone: `07${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
      districtCode,
      sectorCode,
    })
  ).json<{ id: string }>().id;

  const created = (
    await request('POST', '/loans', managerToken, {
      clientId,
      productId,
      principal,
      monthlyRate: '0.0200',
      termMonths: 10,
    })
  ).json<{ id: string }>();

  await request('POST', `/loans/${created.id}/submit`, managerToken);
  await request('POST', `/loans/${created.id}/decision`, adminToken, { decision: 'approve' });
  const disbursed = await request('POST', `/loans/${created.id}/disbursement`, adminToken, {
    disbursementDate: '2026-01-10',
  });

  if (disbursed.statusCode !== 200) {
    throw new Error(`Could not disburse the fixture loan: ${disbursed.body}`);
  }

  return { loanId: created.id };
}

describe('overpayment stays unallocated (§13.8 open)', () => {
  it('records the excess rather than absorbing it into a bucket', async () => {
    const { loanId } = await disbursedLoan('100000.00');

    const quoted = await request('POST', `/loans/${loanId}/payments/preview`, managerToken, {
      amountPaid: '100000000.00',
    });
    expect(quoted.statusCode).toBe(200);

    const preview = quoted.json<{
      allocation: {
        penalty: string;
        fee: string;
        interest: string;
        principal: string;
        unallocated: string;
      };
      balanceAfter: string;
    }>();

    // What an institution does with money paid beyond everything owed — refund,
    // credit, early settlement of a future instalment — is §13.8, unanswered.
    // Keeping it visible is what makes the eventual answer applicable; silently
    // adding it to principal would be an answer chosen by omission.
    expect(Money.fromDatabaseValue(preview.allocation.unallocated).isPositive()).toBe(true);
    expect(preview.balanceAfter).toBe('0.00');
  });

  it('keeps the parts summing to the payment', async () => {
    const { loanId } = await disbursedLoan('100000.00');

    const recorded = await request('POST', `/loans/${loanId}/payments`, managerToken, {
      amountPaid: '100000000.00',
    });
    expect(recorded.statusCode).toBe(201);

    const payment = recorded.json<Payment>();

    // Summed with `Money`, not with `Number`. A test guarding a financial
    // invariant must not compute it the one way this system forbids everywhere
    // else — a float sum could agree with a broken allocator, or disagree with
    // a correct one, and either way the test would be reporting on its own
    // arithmetic rather than on the server's.
    const parts = Money.sum(
      [
        payment.allocation.penalty,
        payment.allocation.fee,
        payment.allocation.interest,
        payment.allocation.principal,
        payment.allocation.unallocated,
      ].map((part) => Money.fromDatabaseValue(part)),
    );

    // A split that loses a shilling produces a balance nobody can reconcile.
    expect(parts.toDatabaseValue()).toBe(payment.amountPaid);
  });
});

describe('the fee bucket stays nil (§13.8 open)', () => {
  it('allocates nothing to fees, while keeping the bucket in its fixed position', async () => {
    const { loanId } = await disbursedLoan('500000.00');

    const recorded = await request('POST', `/loans/${loanId}/payments`, managerToken, {
      amountPaid: '50000.00',
    });

    const payment = recorded.json<Payment>();

    // The bucket's *position* — penalties, fees, interest, principal — is fixed
    // and must stay fixed: introducing it later would silently change how every
    // earlier payment would have been split. Its *value* stays nil until §13.8
    // says what a loan fee is.
    expect(payment.allocation.fee).toBe('0.00');
    expect(Object.keys(payment.allocation)).toEqual([
      'penalty',
      'fee',
      'interest',
      'principal',
      'unallocated',
    ]);
  });
});

describe('written-off loans do not take ordinary repayments (§13.8 open)', () => {
  it('refuses a payment against a written-off loan', async () => {
    const { loanId } = await disbursedLoan('200000.00');

    await harness.database.withTransaction(async (db) => {
      await db.query("UPDATE loans SET status = 'written_off' WHERE id = $1", [loanId]);
    });

    const response = await request('POST', `/loans/${loanId}/payments`, managerToken, {
      amountPaid: '10000.00',
    });

    // Whether a recovery on a written-off loan is a repayment, a separate
    // income line, or a reinstatement is an accounting treatment nobody has
    // specified. Until they do, the safe answer is that this path refuses —
    // silently allocating a recovery as though the loan were active would put
    // it on a return under a heading nobody chose.
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('written_off');
  });
});

describe('designating a head office', () => {
  const branchNamed = async (code: string, name: string): Promise<Branch> => {
    const created = await request('POST', '/branches', adminToken, {
      code,
      name,
      districtCode,
    });
    expect(created.statusCode).toBe(201);
    return created.json<Branch>();
  };

  it('moves the designation and leaves exactly one', async () => {
    const branch = await branchNamed(`HO${randomUUID().slice(0, 4)}`, 'New Head Office');

    const designated = await request('POST', `/branches/${branch.id}/head-office`, adminToken);
    expect(designated.statusCode).toBe(200);
    expect(designated.json<Branch>().isHeadOffice).toBe(true);

    const all = (await request('GET', '/branches', adminToken)).json<Branch[]>();
    expect(all.filter((entry) => entry.isHeadOffice)).toHaveLength(1);
  });

  it('is idempotent, so a retried request is safe', async () => {
    const branch = await branchNamed(`HR${randomUUID().slice(0, 4)}`, 'Repeat Head Office');

    await request('POST', `/branches/${branch.id}/head-office`, adminToken);
    const again = await request('POST', `/branches/${branch.id}/head-office`, adminToken);

    expect(again.statusCode).toBe(200);
    expect(again.json<Branch>().isHeadOffice).toBe(true);

    const all = (await request('GET', '/branches', adminToken)).json<Branch[]>();
    expect(all.filter((entry) => entry.isHeadOffice)).toHaveLength(1);
  });

  it('holds the one-head-office invariant under concurrent promotion', async () => {
    const first = await branchNamed(`C1${randomUUID().slice(0, 4)}`, 'Contender One');
    const second = await branchNamed(`C2${randomUUID().slice(0, 4)}`, 'Contender Two');

    // Both at once. The institution row is locked FOR UPDATE, so the second
    // waits for the first and then clears what the first actually set — rather
    // than clearing a stale snapshot and colliding on the partial unique index.
    const [a, b] = await Promise.all([
      request('POST', `/branches/${first.id}/head-office`, adminToken),
      request('POST', `/branches/${second.id}/head-office`, adminToken),
    ]);

    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);

    const all = (await request('GET', '/branches', adminToken)).json<Branch[]>();
    expect(all.filter((entry) => entry.isHeadOffice)).toHaveLength(1);
  });

  it('refuses a caller without branch.manage', async () => {
    const all = (await request('GET', '/branches', adminToken)).json<Branch[]>();
    const target = all[0]!;

    const officer = await seedUser(harness.database, { roles: ['loan_officer'] });
    const officerToken = await tokenFor(officer);

    expect(
      (await request('POST', `/branches/${target.id}/head-office`, officerToken)).statusCode,
    ).toBe(403);
  });

  it('refuses a branch belonging to another institution', async () => {
    const all = (await request('GET', '/branches', adminToken)).json<Branch[]>();
    const target = all[0]!;

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);

    const response = await request('POST', `/branches/${target.id}/head-office`, strangerToken);

    // Row-level security makes it invisible, so it reports absent rather than
    // forbidden — the caller learns nothing about another tenant's branches.
    expect(response.statusCode).toBe(404);

    // And the stranger's own head office is untouched.
    const theirs = (await request('GET', '/branches', strangerToken)).json<Branch[]>();
    expect(theirs.filter((entry) => entry.isHeadOffice)).toHaveLength(1);
  });
});
