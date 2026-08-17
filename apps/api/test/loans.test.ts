import { randomUUID } from 'node:crypto';

import {
  type Client,
  type ErrorResponse,
  type Loan,
  type LoanWithSchedule,
  type Page,
  type RepaymentSchedule,
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
/** A manager who may approve, and who did not submit. */
let manager: SeededUser;
let managerToken: string;
let disburser: SeededUser;
let disburserToken: string;

let productId: string;
let flatProductId: string;
let clientId: string;

const PRINCIPAL = '1200000.00';
const MONTHLY_RATE = '0.0300';
const TERM_MONTHS = 12;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);

  manager = await seedUserIn(officer.institutionId, ['branch_manager'], officer.branchId);
  managerToken = await tokenFor(manager);

  // Disbursement is its own permission; the seeded administrator holds it.
  disburser = await seedUserIn(officer.institutionId, ['institution_admin'], officer.branchId);
  disburserToken = await tokenFor(disburser);

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

  // A reducing-balance product and a flat one, both wide enough to admit the
  // terms these tests use.
  const products = await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      const insert = async (code: string, method: string): Promise<string> => {
        const row = await client.query<{ id: string }>(
          `INSERT INTO loan_products
             (institution_id, code, name, bot_loan_type, interest_method,
              min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
              min_principal, max_principal)
           VALUES ($1, $2, $3, $4, $5, 0.0100, 0.1000, 1, 60, 100000.00, 5000000.00)
           RETURNING id`,
          [officer.institutionId, code, `${code} Product`, reference.loanType, method],
        );
        return row.rows[0]!.id;
      };
      return {
        reducing: await insert('RB', 'reducing_balance'),
        flat: await insert('FL', 'flat'),
      };
    },
  );
  productId = products.reducing;
  flatProductId = products.flat;

  const created = await request('POST', '/clients', officerToken, {
    fullName: 'Neema Kimaro',
    gender: 'female',
    dateOfBirth: '1988-09-02',
    phone: '0713111222',
    districtCode: reference.district,
    sectorCode: reference.sector,
  });
  clientId = created.json<Client>().id;
});

afterAll(async () => {
  await harness.close();
});

/** A user in an existing institution, with chosen roles and branch. */
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

const application = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  clientId,
  productId,
  principal: PRINCIPAL,
  monthlyRate: MONTHLY_RATE,
  termMonths: TERM_MONTHS,
  ...overrides,
});

/** Set an approval limit for a role, which is otherwise unset and so zero. */
async function setApprovalLimit(roleCode: string, maxPrincipal: string): Promise<void> {
  await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, $2, $3)
         ON CONFLICT (institution_id, role_code) DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [officer.institutionId, roleCode, maxPrincipal],
      );
    },
  );
}

/** Walk a loan from draft to approved. */
async function approvedLoan(overrides: Record<string, unknown> = {}): Promise<Loan> {
  await setApprovalLimit('branch_manager', '10000000.00');

  const created = (
    await request('POST', '/loans', officerToken, application(overrides))
  ).json<Loan>();
  await request('POST', `/loans/${created.id}/submit`, officerToken);
  const decided = await request('POST', `/loans/${created.id}/decision`, managerToken, {
    decision: 'approve',
  });

  expect(decided.statusCode).toBe(200);
  return decided.json<Loan>();
}

describe('POST /loans/preview-schedule', () => {
  it('returns a schedule without creating anything', async () => {
    const before = (await request('GET', '/loans?limit=100', officerToken)).json<Page<Loan>>();

    const preview = await request('POST', '/loans/preview-schedule', officerToken, application());

    expect(preview.statusCode).toBe(200);
    const after = (await request('GET', '/loans?limit=100', officerToken)).json<Page<Loan>>();
    expect(after.items.length).toBe(before.items.length);
  });

  it('produces one instalment per month, summing to exactly the principal', async () => {
    const schedule = (
      await request('POST', '/loans/preview-schedule', officerToken, application())
    ).json<RepaymentSchedule>();

    expect(schedule.instalments).toHaveLength(TERM_MONTHS);
    // Not "close to" — exactly. A schedule that loses a shilling produces a
    // balance nobody can reconcile, and reconciling by hand is what this system
    // exists to stop.
    expect(schedule.totalPrincipal).toBe(PRINCIPAL);
  });

  it('closes the loan exactly: the last closing balance is zero', async () => {
    const schedule = (
      await request('POST', '/loans/preview-schedule', officerToken, application())
    ).json<RepaymentSchedule>();

    expect(schedule.instalments.at(-1)?.closingBalance).toBe('0.00');
  });

  it('returns every amount as a string, never a JSON number', async () => {
    const body = (await request('POST', '/loans/preview-schedule', officerToken, application()))
      .body;

    // A JSON number is a binary double. `"principalDue": 91234.56` would already
    // have lost precision by the time any client parsed it.
    expect(body).not.toMatch(/"(principalDue|interestDue|totalDue)":\s*-?\d/);
  });

  it('charges less interest on reducing balance than on flat, for the same terms', async () => {
    const reducing = (
      await request('POST', '/loans/preview-schedule', officerToken, application())
    ).json<RepaymentSchedule>();
    const flat = (
      await request(
        'POST',
        '/loans/preview-schedule',
        officerToken,
        application({ productId: flatProductId }),
      )
    ).json<RepaymentSchedule>();

    // Flat interest is charged on the original principal for the whole term;
    // reducing balance is charged on what is still owed. The relationship is
    // definitional, and a preview that got it backwards would misprice a loan.
    expect(Number(flat.totalInterest)).toBeGreaterThan(Number(reducing.totalInterest));
  });

  it('takes the interest method from the product, not the request', async () => {
    const response = await request(
      'POST',
      '/loans/preview-schedule',
      officerToken,
      application({ interestMethod: 'flat' }),
    );

    // Letting an application nominate the method would let two loans on one
    // product be priced differently with nothing recording why.
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['a principal below the product floor', { principal: '1000.00' }],
    ['a principal above the product ceiling', { principal: '99000000.00' }],
    ['a rate below the product floor', { monthlyRate: '0.0001' }],
    ['a rate above the product ceiling', { monthlyRate: '0.9000' }],
    ['a term beyond the product maximum', { termMonths: 120 }],
    ['a zero principal', { principal: '0.00' }],
    ['a negative principal', { principal: '-5000.00' }],
  ])('refuses %s', async (_label, override) => {
    const response = await request(
      'POST',
      '/loans/preview-schedule',
      officerToken,
      application(override),
    );

    expect(response.statusCode).toBe(400);
  });

  it('names the field that fell outside the product', async () => {
    const response = await request(
      'POST',
      '/loans/preview-schedule',
      officerToken,
      application({ principal: '1000.00' }),
    );

    expect(response.json<ErrorResponse>().error.details?.[0]?.path).toEqual(['principal']);
  });

  it('refuses a principal sent as a JSON number rather than a string', async () => {
    const response = await request(
      'POST',
      '/loans/preview-schedule',
      officerToken,
      application({ principal: 1200000.5 }),
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('binary doubles');
  });
});

describe('POST /loans', () => {
  it('creates a draft and takes the branch from the client', async () => {
    const response = await request('POST', '/loans', officerToken, application());

    expect(response.statusCode).toBe(201);
    const loan = response.json<Loan>();
    expect(loan.status).toBe('draft');
    expect(loan.branchId).toBe(officer.branchId);
    expect(loan.outstandingBalance).toBeNull();
  });

  it('copies the terms rather than referencing the product', async () => {
    const loan = (await request('POST', '/loans', officerToken, application())).json<Loan>();

    // A product's rate may be revised; a loan's may not. Reading the rate
    // through the product would silently restate every historic schedule and
    // every MSP2-04 return the next time someone changed a price.
    expect(loan.principal).toBe(PRINCIPAL);
    expect(loan.monthlyRate).toBe(MONTHLY_RATE);
    expect(loan.interestMethod).toBe('reducing_balance');
  });

  it('has no schedule until it is disbursed', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();

    const fetched = (
      await request('GET', `/loans/${created.id}`, officerToken)
    ).json<LoanWithSchedule>();

    expect(fetched.schedule).toBeNull();
  });

  it('refuses a client from another institution', async () => {
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });
    const outsiderToken = await tokenFor(outsider);
    const theirClient = await request('POST', '/clients', outsiderToken, {
      fullName: 'Their Borrower',
      gender: 'male',
      dateOfBirth: '1990-01-01',
      phone: '0714222333',
      districtCode: (
        await harness.database.withTransaction(async (c) =>
          c.query<{ code: string }>('SELECT code FROM reference.districts ORDER BY code LIMIT 1'),
        )
      ).rows[0]!.code,
      sectorCode: (
        await harness.database.withTransaction(async (c) =>
          c.query<{ code: string }>('SELECT code FROM reference.sectors ORDER BY code LIMIT 1'),
        )
      ).rows[0]!.code,
    });

    const response = await request(
      'POST',
      '/loans',
      officerToken,
      application({ clientId: theirClient.json<Client>().id }),
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses lending to an inactive client', async () => {
    const created = (
      await request('POST', '/clients', officerToken, {
        fullName: 'Dormant Borrower',
        gender: 'male',
        dateOfBirth: '1985-05-05',
        phone: '0715333444',
        districtCode: (
          await harness.database.withTransaction(async (c) =>
            c.query<{ code: string }>('SELECT code FROM reference.districts ORDER BY code LIMIT 1'),
          )
        ).rows[0]!.code,
        sectorCode: (
          await harness.database.withTransaction(async (c) =>
            c.query<{ code: string }>('SELECT code FROM reference.sectors ORDER BY code LIMIT 1'),
          )
        ).rows[0]!.code,
      })
    ).json<Client>();

    await request('PATCH', `/clients/${created.id}`, officerToken, { status: 'inactive' });

    const response = await request(
      'POST',
      '/loans',
      officerToken,
      application({ clientId: created.id }),
    );

    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller-supplied status', async () => {
    const response = await request(
      'POST',
      '/loans',
      officerToken,
      application({ status: 'active' }),
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses a caller-supplied outstanding balance', async () => {
    const response = await request(
      'POST',
      '/loans',
      officerToken,
      application({ outstandingBalance: '0.00' }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('the approval workflow', () => {
  it('moves draft to pending on submission, recording the submitter', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();

    const submitted = (
      await request('POST', `/loans/${created.id}/submit`, officerToken)
    ).json<Loan>();

    expect(submitted.status).toBe('pending_approval');
    expect(submitted.submittedBy).toBe(officer.userId);
    expect(submitted.submittedAt).not.toBeNull();
  });

  it('refuses to submit a loan that is not a draft', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const again = await request('POST', `/loans/${created.id}/submit`, officerToken);

    expect(again.statusCode).toBe(422);
    expect(again.json<ErrorResponse>().error.message).toContain('pending_approval');
  });

  it('refuses approval by the person who submitted', async () => {
    // Maker-checker. The point is that two people saw it, not that one was
    // senior enough — so this holds even for a user who also has the permission.
    await setApprovalLimit('institution_admin', '10000000.00');

    const created = (await request('POST', '/loans', disburserToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, disburserToken);

    const response = await request('POST', `/loans/${created.id}/decision`, disburserToken, {
      decision: 'approve',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain(
      'cannot be approved by the person',
    );
  });

  it('refuses an officer without the approve permission', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const response = await request('POST', `/loans/${created.id}/decision`, officerToken, {
      decision: 'approve',
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('loan.approve');
  });

  it('refuses every approval while no threshold is configured', async () => {
    // §13.3 asks for these figures and has no answer, so thresholds are seeded
    // empty. An absent limit means no authority, never unlimited — the opposite
    // reading would let any role approve any amount the moment someone forgot
    // to configure a ceiling.
    await harness.database.withTenantTransaction(
      { institutionId: officer.institutionId },
      async (client) => {
        await client.query('DELETE FROM approval_thresholds WHERE institution_id = $1', [
          officer.institutionId,
        ]);
      },
    );

    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const response = await request('POST', `/loans/${created.id}/decision`, managerToken, {
      decision: 'approve',
    });

    expect(response.statusCode).toBe(403);
  });

  it('refuses an amount above the approver’s configured limit', async () => {
    await setApprovalLimit('branch_manager', '500000.00');

    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const response = await request('POST', `/loans/${created.id}/decision`, managerToken, {
      decision: 'approve',
    });

    expect(response.statusCode).toBe(403);
  });

  it('approves within the limit, recording who decided', async () => {
    const approved = await approvedLoan();

    expect(approved.status).toBe('approved');
    expect(approved.decidedBy).toBe(manager.userId);
    expect(approved.decidedAt).not.toBeNull();
  });

  it('rejects with a reason', async () => {
    await setApprovalLimit('branch_manager', '10000000.00');
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const rejected = (
      await request('POST', `/loans/${created.id}/decision`, managerToken, {
        decision: 'reject',
        reason: 'Existing arrears on a previous facility.',
      })
    ).json<Loan>();

    // Back to the officer as a draft, with the reason attached (§13.3). A
    // rejection is usually a missing document or a term to change, not a
    // judgement that the borrower should never be lent to — so the officer
    // revises and resubmits rather than rekeying the application.
    expect(rejected.status).toBe('draft');
    expect(rejected.rejectionReason).toBe('Existing arrears on a previous facility.');
    expect(rejected.decidedBy).not.toBeNull();
  });

  it('lets the officer revise a rejected application and resubmit it', async () => {
    await setApprovalLimit('branch_manager', '10000000.00');
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);
    await request('POST', `/loans/${created.id}/decision`, managerToken, {
      decision: 'reject',
      reason: 'Term too long for this borrower.',
    });

    const resubmitted = await request('POST', `/loans/${created.id}/submit`, officerToken);

    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.json<Loan>().status).toBe('pending_approval');
  });

  it('refuses a rejection with no reason', async () => {
    await setApprovalLimit('branch_manager', '10000000.00');
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);

    const response = await request('POST', `/loans/${created.id}/decision`, managerToken, {
      decision: 'reject',
    });

    // "Declined" with no reason is not a record the borrower, the officer or an
    // auditor can act on. The database enforces the same rule beneath this.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a decision on a loan that is not awaiting one', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();

    const response = await request('POST', `/loans/${created.id}/decision`, managerToken, {
      decision: 'approve',
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('POST /loans/:id/disbursement', () => {
  it('writes the schedule and activates the loan', async () => {
    const approved = await approvedLoan();

    const response = await request('POST', `/loans/${approved.id}/disbursement`, disburserToken, {
      disbursementDate: '2026-01-15',
    });

    expect(response.statusCode).toBe(200);
    const disbursed = response.json<LoanWithSchedule>();
    expect(disbursed.status).toBe('active');
    expect(disbursed.outstandingBalance).toBe(PRINCIPAL);
    expect(disbursed.schedule?.instalments).toHaveLength(TERM_MONTHS);
  });

  it('stores a schedule identical to what the preview showed', async () => {
    // The property the whole preview endpoint exists for. The system this
    // replaces computed the breakdown twice — server-side to write it, in the
    // browser to preview it — and its own technical document warned that if the
    // two drifted the preview would lie about what was recorded.
    const terms = application({ principal: '900000.00', termMonths: 6 });
    const previewed = (
      await request('POST', '/loans/preview-schedule', officerToken, {
        ...terms,
        disbursementDate: '2026-02-01',
      })
    ).json<RepaymentSchedule>();

    await setApprovalLimit('branch_manager', '10000000.00');
    const created = (await request('POST', '/loans', officerToken, terms)).json<Loan>();
    await request('POST', `/loans/${created.id}/submit`, officerToken);
    await request('POST', `/loans/${created.id}/decision`, managerToken, { decision: 'approve' });

    await request('POST', `/loans/${created.id}/disbursement`, disburserToken, {
      disbursementDate: '2026-02-01',
    });

    // Compared against the schedule read back **from the database**, not
    // against the one the disbursement response happened to return. Comparing
    // two in-memory results of the same function would prove only that the
    // function is deterministic; what matters is that the rows a borrower is
    // held to are the rows they were shown before signing.
    const stored = (
      await request('GET', `/loans/${created.id}`, officerToken)
    ).json<LoanWithSchedule>();

    expect(stored.schedule).toEqual(previewed);
  });

  it('reads back the stored schedule unchanged', async () => {
    const approved = await approvedLoan();
    const disbursed = (
      await request('POST', `/loans/${approved.id}/disbursement`, disburserToken, {
        disbursementDate: '2026-03-01',
      })
    ).json<LoanWithSchedule>();

    const fetched = (
      await request('GET', `/loans/${approved.id}`, officerToken)
    ).json<LoanWithSchedule>();

    // Read back from the rows, not regenerated. Regenerating a schedule to
    // display it is a second implementation whose output can differ from the
    // record the borrower is held to.
    expect(fetched.schedule).toEqual(disbursed.schedule);
  });

  it('refuses a disbursement dated in the future', async () => {
    const approved = await approvedLoan();

    const response = await request('POST', `/loans/${approved.id}/disbursement`, disburserToken, {
      disbursementDate: '2999-01-01',
    });

    // The schedule would start in the future and the loan would report as
    // active on a BOT return before any money had moved.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a loan that has not been approved', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();

    const response = await request('POST', `/loans/${created.id}/disbursement`, disburserToken, {});

    expect(response.statusCode).toBe(422);
  });

  it('refuses to disburse the same loan twice', async () => {
    const approved = await approvedLoan();
    await request('POST', `/loans/${approved.id}/disbursement`, disburserToken, {});

    const again = await request('POST', `/loans/${approved.id}/disbursement`, disburserToken, {});

    // Money released twice against one application is the failure this guards.
    expect(again.statusCode).toBe(422);
  });

  it('refuses a caller without the disburse permission', async () => {
    const approved = await approvedLoan();

    const response = await request('POST', `/loans/${approved.id}/disbursement`, officerToken, {});

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('loan.disburse');
  });

  it('leaves no schedule behind when the disbursement is refused', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    await request('POST', `/loans/${created.id}/disbursement`, disburserToken, {});

    const rows = await harness.database.withTenantTransaction(
      { institutionId: officer.institutionId },
      async (client) =>
        client.query('SELECT 1 FROM repayment_schedules WHERE loan_id = $1', [created.id]),
    );

    // The status change and the schedule are one transaction. A loan active
    // with no schedule — or a schedule with no active loan — is a balance
    // nobody can reconcile (analysis R3).
    expect(rows.rowCount).toBe(0);
  });
});

describe('GET /loans', () => {
  it('returns a page scoped to the caller’s institution', async () => {
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });
    const theirToken = await tokenFor(outsider);

    const theirs = (await request('GET', '/loans?limit=100', theirToken)).json<Page<Loan>>();

    expect(theirs.items).toEqual([]);
  });

  it('filters by status', async () => {
    await approvedLoan();

    const page = (await request('GET', '/loans?status=approved&limit=100', officerToken)).json<
      Page<Loan>
    >();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((loan) => loan.status === 'approved')).toBe(true);
  });

  it('filters by client', async () => {
    const page = (await request('GET', `/loans?clientId=${clientId}&limit=100`, officerToken)).json<
      Page<Loan>
    >();

    expect(page.items.every((loan) => loan.clientId === clientId)).toBe(true);
  });

  it('answers 404 for a loan in another institution', async () => {
    const created = (await request('POST', '/loans', officerToken, application())).json<Loan>();
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });

    const response = await request('GET', `/loans/${created.id}`, await tokenFor(outsider));

    expect(response.statusCode).toBe(404);
  });
});

describe('GET /loan-products', () => {
  it('lists the institution’s products with their bounds', async () => {
    const products = (await request('GET', '/loan-products', officerToken)).json<
      { id: string; minPrincipal: string }[]
    >();

    expect(products.map((product) => product.id)).toContain(productId);
    expect(products.map((product) => product.id)).toContain(flatProductId);
    // Bounds as strings, since a client renders them beside monetary inputs.
    expect(products[0]?.minPrincipal).toMatch(/^\d+\.\d{2}$/);
  });
});
