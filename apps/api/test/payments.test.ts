import { randomUUID } from 'node:crypto';

import {
  type AllocationPreview,
  type Client,
  type ErrorResponse,
  type Loan,
  type LoanWithSchedule,
  type Page,
  type Payment,
} from '@mfi/contracts';
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

let harness: Harness;

let officer: SeededUser;
let officerToken: string;
let manager: SeededUser;
let managerToken: string;
let admin: SeededUser;
let adminToken: string;

let productId: string;
let clientId: string;

const PRINCIPAL = '1000000.00';
const MONTHLY_RATE = '0.0200';
const TERM_MONTHS = 10;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  manager = await seedUserIn(officer.institutionId, ['branch_manager'], officer.branchId);
  managerToken = await tokenFor(manager);
  admin = await seedUserIn(officer.institutionId, ['institution_admin'], officer.branchId);
  adminToken = await tokenFor(admin);

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
         VALUES ($1, 'PAY', 'Payments Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );
      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Joseph Mollel',
      gender: 'male',
      dateOfBirth: '1979-11-30',
      phone: '0716444555',
      districtCode: reference.district,
      sectorCode: reference.sector,
    })
  ).json<Client>().id;

  await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'branch_manager', 50000000.00)
         ON CONFLICT (institution_id, role_code) DO UPDATE SET max_principal = EXCLUDED.max_principal`,
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
  roles: readonly string[],
  branchId: string,
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

/** A loan carried all the way to active, ready to receive money. */
async function activeLoan(): Promise<LoanWithSchedule> {
  const created = (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal: PRINCIPAL,
      monthlyRate: MONTHLY_RATE,
      termMonths: TERM_MONTHS,
    })
  ).json<Loan>();

  await request('POST', `/loans/${created.id}/submit`, officerToken);
  await request('POST', `/loans/${created.id}/decision`, managerToken, { decision: 'approve' });
  const disbursed = await request('POST', `/loans/${created.id}/disbursement`, adminToken, {
    disbursementDate: '2026-01-10',
  });

  expect(disbursed.statusCode).toBe(200);
  return disbursed.json<LoanWithSchedule>();
}

describe('POST /loans/:loanId/payments/preview', () => {
  it('shows how an amount would be applied without recording it', async () => {
    const loan = await activeLoan();

    const preview = (
      await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid: '100000.00',
      })
    ).json<AllocationPreview>();

    const payments = (await request('GET', `/payments?loanId=${loan.id}`, officerToken)).json<
      Page<Payment>
    >();

    expect(preview.amountPaid).toBe('100000.00');
    expect(payments.items).toEqual([]);
  });

  it('applies interest before principal, as the documentation records', async () => {
    const loan = await activeLoan();

    const preview = (
      await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid: '50000.00',
      })
    ).json<AllocationPreview>();

    // TRD §4 describes the recorded behaviour as interest-first,
    // principal-second. Those are the only two buckets that exist yet; where
    // penalties and fees belong is an open question (§13.2).
    expect(Number(preview.allocation.interest)).toBeGreaterThan(0);
    expect(preview.allocation.penalty).toBe('0.00');
    expect(preview.allocation.fee).toBe('0.00');
  });

  it('accounts for every shilling: the parts sum to the amount', async () => {
    const loan = await activeLoan();

    const preview = (
      await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid: '333333.33',
      })
    ).json<AllocationPreview>();

    const total =
      Number(preview.allocation.penalty) +
      Number(preview.allocation.fee) +
      Number(preview.allocation.interest) +
      Number(preview.allocation.principal) +
      Number(preview.allocation.unallocated);

    // A split that loses a shilling leaves a balance nobody can reconcile.
    expect(total).toBeCloseTo(333333.33, 2);
  });

  it('records an overpayment as unallocated rather than absorbing it', async () => {
    const loan = await activeLoan();

    const preview = (
      await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid: '9999999.99',
      })
    ).json<AllocationPreview>();

    // What an institution does with excess funds is an open rule (§13.8).
    // Silently keeping it would answer that on their behalf.
    expect(Number(preview.allocation.unallocated)).toBeGreaterThan(0);
    expect(preview.balanceAfter).toBe('0.00');
  });

  it('refuses a zero or negative amount', async () => {
    const loan = await activeLoan();

    for (const amountPaid of ['0.00', '-100.00']) {
      const response = await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid,
      });
      expect(response.statusCode).toBe(400);
    }
  });

  it('refuses an amount sent as a JSON number', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
      amountPaid: 100000.5,
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('POST /loans/:loanId/payments', () => {
  it('records a payment and moves the balance by the principal component only', async () => {
    const loan = await activeLoan();

    const recorded = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: '150000.00',
        datePaid: '2026-02-10',
      })
    ).json<Payment>();

    // Interest is a charge the payment settles; paying it does not reduce what
    // was borrowed. The database enforces the same relationship.
    expect(recorded.balanceBefore).toBe(PRINCIPAL);
    expect(Number(recorded.balanceAfter)).toBe(
      Number(recorded.balanceBefore) - Number(recorded.allocation.principal),
    );
  });

  it('applies exactly what the preview showed', async () => {
    const loan = await activeLoan();

    const preview = (
      await request('POST', `/loans/${loan.id}/payments/preview`, officerToken, {
        amountPaid: '175000.00',
      })
    ).json<AllocationPreview>();

    const recorded = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: '175000.00',
      })
    ).json<Payment>();

    // The previous system computed this split twice — in the function that
    // recorded the payment and again in the browser to preview it — and warned
    // in its own documentation that the preview would lie if the two drifted.
    expect(recorded.allocation).toEqual(preview.allocation);
    expect(recorded.balanceAfter).toBe(preview.balanceAfter);
  });

  it('updates the loan’s outstanding balance', async () => {
    const loan = await activeLoan();

    const recorded = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: '200000.00',
      })
    ).json<Payment>();

    const refreshed = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>();

    expect(refreshed.outstandingBalance).toBe(recorded.balanceAfter);
  });

  it('completes the loan when the balance reaches zero', async () => {
    const loan = await activeLoan();

    await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: loan.schedule!.totalRepayable,
    });

    const refreshed = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>();

    expect(refreshed.outstandingBalance).toBe('0.00');
    expect(refreshed.status).toBe('completed');
  });

  it('marks instalments settled oldest first', async () => {
    const loan = await activeLoan();
    const firstTwo = loan.schedule!.instalments.slice(0, 2);
    const amount = (Number(firstTwo[0]!.totalDue) + Number(firstTwo[1]!.totalDue)).toFixed(2);

    await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: amount });

    const refreshed = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>();

    expect(refreshed.schedule?.instalments[0]?.isPaid).toBe(true);
    expect(refreshed.schedule?.instalments[1]?.isPaid).toBe(true);
    expect(refreshed.schedule?.instalments[2]?.isPaid).toBe(false);
  });

  it('refuses a payment dated in the future', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '10000.00',
      datePaid: '2999-01-01',
    });

    // It would put a receipt on a BOT return for a quarter that has not happened.
    expect(response.statusCode).toBe(422);
  });

  it('accepts a backdated payment, which is ordinary', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '10000.00',
      datePaid: '2026-01-20',
    });

    expect(response.statusCode).toBe(201);
  });

  it('refuses a payment against a loan that was never disbursed', async () => {
    const draft = (
      await request('POST', '/loans', officerToken, {
        clientId,
        productId,
        principal: PRINCIPAL,
        monthlyRate: MONTHLY_RATE,
        termMonths: TERM_MONTHS,
      })
    ).json<Loan>();

    const response = await request('POST', `/loans/${draft.id}/payments`, officerToken, {
      amountPaid: '10000.00',
    });

    // A receipt against a loan with no lending behind it.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller-supplied allocation', async () => {
    const loan = await activeLoan();

    const response = await request('POST', `/loans/${loan.id}/payments`, officerToken, {
      amountPaid: '50000.00',
      allocation: { interest: '0.00', principal: '50000.00' },
    });

    // The split is computed, never submitted. A client-supplied one is a second
    // implementation the borrower's balance would then depend on.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a loan in another institution', async () => {
    const loan = await activeLoan();
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });

    const response = await request('POST', `/loans/${loan.id}/payments`, await tokenFor(outsider), {
      amountPaid: '10000.00',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('a recorded payment is never edited', () => {
  it('exposes no route to change one', async () => {
    const loan = await activeLoan();
    const recorded = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '25000.00' })
    ).json<Payment>();

    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await harness.server.inject({
        method,
        url: `/payments/${recorded.id}`,
        remoteAddress: freshAddress(),
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { amountPaid: '1.00' },
      });

      // Evidence that can be edited is not evidence. The application holds
      // INSERT and SELECT on the table and nothing else, so even a route added
      // by mistake could not write the change.
      expect(response.statusCode).toBe(404);
    }
  });
});

describe('POST /payments/:id/reversal', () => {
  it('records a negating row rather than removing the original', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '80000.00' })
    ).json<Payment>();

    const reversal = (
      await request('POST', `/payments/${original.id}/reversal`, managerToken, {
        reason: 'Keyed against the wrong loan.',
      })
    ).json<Payment>();

    expect(reversal.amountPaid).toBe('-80000.00');
    expect(reversal.reversesPaymentId).toBe(original.id);
    expect(reversal.reversalReason).toBe('Keyed against the wrong loan.');

    // Both stay visible. The previous system made payments immutable and never
    // built the correction, so fixing one meant editing the database by hand —
    // which destroys the property the immutability was protecting.
    const still = await request('GET', `/payments/${original.id}`, officerToken);
    expect(still.statusCode).toBe(200);
    expect(still.json<Payment>().reversedByPaymentId).toBe(reversal.id);
  });

  it('returns the loan’s balance to where it was', async () => {
    const loan = await activeLoan();
    const before = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>().outstandingBalance;

    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '120000.00' })
    ).json<Payment>();
    await request('POST', `/payments/${original.id}/reversal`, managerToken, {
      reason: 'Duplicate receipt.',
    });

    const after = (await request('GET', `/loans/${loan.id}`, officerToken)).json<LoanWithSchedule>()
      .outstandingBalance;

    // The pair nets to no movement.
    expect(after).toBe(before);
  });

  it('negates every component, not only the amount', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '95000.00' })
    ).json<Payment>();

    const reversal = (
      await request('POST', `/payments/${original.id}/reversal`, managerToken, {
        reason: 'Reversed at the client’s request.',
      })
    ).json<Payment>();

    // A partial reversal would leave the balance depending on which rows a
    // reader happened to sum. A database trigger refuses one.
    //
    // Summed to zero rather than compared to a negation: a zero component
    // stores as `0.00` and negates to `-0`, and `Object.is(+0, -0)` is false.
    expect(Number(reversal.allocation.interest) + Number(original.allocation.interest)).toBe(0);
    expect(Number(reversal.allocation.principal) + Number(original.allocation.principal)).toBe(0);
    expect(Number(reversal.amountPaid) + Number(original.amountPaid)).toBe(0);
  });

  it('un-marks instalments the reversed payment had settled', async () => {
    const loan = await activeLoan();
    const first = loan.schedule!.instalments[0]!;

    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: first.totalDue,
      })
    ).json<Payment>();

    const marked = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>();
    expect(marked.schedule?.instalments[0]?.isPaid).toBe(true);

    await request('POST', `/payments/${original.id}/reversal`, managerToken, {
      reason: 'Cheque returned unpaid.',
    });

    const unmarked = (
      await request('GET', `/loans/${loan.id}`, officerToken)
    ).json<LoanWithSchedule>();
    expect(unmarked.schedule?.instalments[0]?.isPaid).toBe(false);
  });

  it('refuses to reverse the payment that closed a loan, and says why', async () => {
    const loan = await activeLoan();
    const settled = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: loan.schedule!.totalRepayable,
      })
    ).json<Payment>();

    expect((await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>().status).toBe(
      'completed',
    );

    const response = await request('POST', `/payments/${settled.id}/reversal`, managerToken, {
      reason: 'Settlement funds did not clear.',
    });

    // `completed` is terminal in the domain's transition table and in a
    // database trigger. Reopening a closed loan is not a documented rule
    // (§13.9), so this refuses with an explanation rather than inventing the
    // transition — or letting the trigger reject it with an error that explains
    // nothing. A bounced settlement cheque is real, so the question needs an
    // answer; until it has one, the loan is left as the record says it is.
    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('reopen');

    const unchanged = (await request('GET', `/loans/${loan.id}`, officerToken)).json<Loan>();
    expect(unchanged.status).toBe('completed');
    expect(unchanged.outstandingBalance).toBe('0.00');
  });

  it('refuses a reversal with no reason', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '30000.00' })
    ).json<Payment>();

    const response = await request('POST', `/payments/${original.id}/reversal`, managerToken, {});

    // An unexplained movement of money in an audited ledger is worse than the
    // mistake it corrects.
    expect(response.statusCode).toBe(400);
  });

  it('refuses to reverse the same payment twice', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '40000.00' })
    ).json<Payment>();

    await request('POST', `/payments/${original.id}/reversal`, managerToken, { reason: 'First.' });
    const again = await request('POST', `/payments/${original.id}/reversal`, managerToken, {
      reason: 'Second.',
    });

    expect(again.statusCode).toBe(422);
  });

  it('refuses to reverse a reversal', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '45000.00' })
    ).json<Payment>();
    const reversal = (
      await request('POST', `/payments/${original.id}/reversal`, managerToken, {
        reason: 'Mistaken entry.',
      })
    ).json<Payment>();

    const response = await request('POST', `/payments/${reversal.id}/reversal`, managerToken, {
      reason: 'Undo the undo.',
    });

    // It would make the loan's balance depend on the order rows are read.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller who may record payments but not reverse them', async () => {
    const loan = await activeLoan();
    const original = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '15000.00' })
    ).json<Payment>();

    const response = await request('POST', `/payments/${original.id}/reversal`, officerToken, {
      reason: 'Officer trying to undo their own entry.',
    });

    // Recording money and undoing it are not the same authority.
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('payment.reverse');
  });
});

describe('GET /payments', () => {
  it('lists payments for a loan, newest first', async () => {
    const loan = await activeLoan();
    await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '11000.00' });
    const second = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, { amountPaid: '12000.00' })
    ).json<Payment>();

    const page = (await request('GET', `/payments?loanId=${loan.id}`, officerToken)).json<
      Page<Payment>
    >();

    expect(page.items[0]?.id).toBe(second.id);
  });

  it('shows another institution nothing', async () => {
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });

    const page = (await request('GET', '/payments?limit=100', await tokenFor(outsider))).json<
      Page<Payment>
    >();

    expect(page.items).toEqual([]);
  });

  it('refuses a caller without the read permission', async () => {
    const accountant = await seedUserIn(officer.institutionId, ['accountant'], officer.branchId);

    const response = await request('POST', '/loans/x/payments', await tokenFor(accountant), {
      amountPaid: '1.00',
    });

    expect(response.statusCode).toBe(403);
  });
});
