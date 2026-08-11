import { randomUUID } from 'node:crypto';

import {
  type Client,
  type CompiledReturn,
  type ErrorResponse,
  type Loan,
  type LoanWithSchedule,
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

/**
 * The BOT MSP2 quarterly return, end to end.
 *
 * Two properties are worth more than the rest of this suite put together, and
 * both are about refusing rather than producing:
 *
 * 1. **The return restates the past.** A payment received in April must not
 *    reduce the balance reported for the quarter that ended in March. Every
 *    other reporting system this replaces read `loans.outstanding_balance`,
 *    which is today's figure, and filed it against last quarter's date.
 * 2. **Stale classifications block the filing.** The system being replaced
 *    never ran its classification job at all, and reported loans forty days
 *    overdue as Current — to its dashboard and to the Bank of Tanzania (R5).
 *
 * The tests below are written so that a regression in either produces a
 * failure that names which one broke.
 */

let harness: Harness;

let officer: SeededUser;
let officerToken: string;
let manager: SeededUser;
let managerToken: string;
let admin: SeededUser;
let adminToken: string;
let accountant: SeededUser;
let accountantToken: string;

let productId: string;
let clientId: string;
let sectorCode: string;
let loanTypeCode: string;

const PRINCIPAL = '1200000.00';
const MONTHLY_RATE = '0.0200';
const TERM_MONTHS = 12;

/** The quarter every test reports on. Long finished, so never in the future. */
const YEAR = 2026;
const QUARTER = 1;
const QUARTER_END = '2026-03-31';

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  manager = await seedUserIn(officer.institutionId, ['branch_manager']);
  managerToken = await tokenFor(manager);
  admin = await seedUserIn(officer.institutionId, ['institution_admin']);
  adminToken = await tokenFor(admin);
  accountant = await seedUserIn(officer.institutionId, ['accountant']);
  accountantToken = await tokenFor(accountant);

  const reference = await harness.database.withTransaction(async (client) => {
    const district = await client.query<{ code: string }>(
      'SELECT code FROM reference.districts ORDER BY code LIMIT 1',
    );
    const sector = await client.query<{ code: string }>(
      'SELECT code FROM reference.sectors ORDER BY sno LIMIT 1',
    );
    // A standard-schedule type deliberately, not housing: the housing schedule
    // defines no band below 91 days (§11.5), so a housing loan would come back
    // unclassifiable and every test here would refuse for that reason instead
    // of the one it is testing.
    const loanType = await client.query<{ code: string }>(
      `SELECT code FROM reference.loan_types
        WHERE provisioning_schedule = 'standard' ORDER BY sno LIMIT 1`,
    );
    return {
      district: district.rows[0]!.code,
      sector: sector.rows[0]!.code,
      loanType: loanType.rows[0]!.code,
    };
  });
  sectorCode = reference.sector;
  loanTypeCode = reference.loanType;

  productId = await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      const row = await client.query<{ id: string }>(
        `INSERT INTO loan_products
           (institution_id, code, name, bot_loan_type, interest_method,
            min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
            min_principal, max_principal)
         VALUES ($1, 'RPT', 'Reporting Product', $2, 'flat',
                 0.0100, 0.1000, 1, 60, 100000.00, 9000000.00)
         RETURNING id`,
        [officer.institutionId, reference.loanType],
      );

      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, 'branch_manager', 50000000.00)
         ON CONFLICT (institution_id, role_code)
         DO UPDATE SET max_principal = EXCLUDED.max_principal`,
        [officer.institutionId],
      );

      return row.rows[0]!.id;
    },
  );

  clientId = (
    await request('POST', '/clients', officerToken, {
      fullName: 'Neema Kileo',
      gender: 'female',
      dateOfBirth: '1990-06-14',
      phone: '0716111222',
      districtCode: reference.district,
      sectorCode: reference.sector,
    })
  ).json<Client>().id;
});

afterAll(async () => {
  await harness.close();
});

async function seedUserIn(institutionId: string, roles: readonly string[]): Promise<SeededUser> {
  const email = `staff.${randomUUID().slice(0, 8)}@seed.test`;
  const passwordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

  return harness.database.withTransaction(async (client) => {
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Staff', $4, 'active') RETURNING id`,
      [institutionId, officer.branchId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    for (const role of roles) {
      await client.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, userId, role],
      );
    }
    return {
      institutionId,
      branchId: officer.branchId,
      userId,
      email,
      password: DEFAULT_TEST_PASSWORD,
    };
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

/**
 * A reported amount in cents, exactly.
 *
 * `Number('4231908776.35')` is a double and comparing two of them for equality
 * is the mistake this whole system is built to avoid — including in its own
 * tests, where a float comparison that happens to pass proves nothing about
 * the values that will not.
 */
function cents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(`${whole ?? '0'}${fraction.padEnd(2, '0')}`);
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

/** A loan carried to active, disbursed on the given date. */
async function activeLoan(
  disbursementDate: string,
  principal = PRINCIPAL,
): Promise<LoanWithSchedule> {
  const created = (
    await request('POST', '/loans', officerToken, {
      clientId,
      productId,
      principal,
      monthlyRate: MONTHLY_RATE,
      termMonths: TERM_MONTHS,
    })
  ).json<Loan>();

  await request('POST', `/loans/${created.id}/submit`, officerToken);
  await request('POST', `/loans/${created.id}/decision`, managerToken, { decision: 'approve' });
  const disbursed = await request('POST', `/loans/${created.id}/disbursement`, adminToken, {
    disbursementDate,
  });

  expect(disbursed.statusCode).toBe(200);
  return disbursed.json<LoanWithSchedule>();
}

/**
 * Stamp the classification record so the freshness gate is satisfied.
 *
 * Written directly rather than by running the classification function, because
 * these tests are about compilation and not about the job. The gate itself is
 * tested by removing this stamp, below.
 */
async function markClassified(at: Date | null): Promise<void> {
  await harness.database.withTransaction(async (client) => {
    if (at === null) {
      await client.query('DELETE FROM system_health WHERE institution_id = $1', [
        officer.institutionId,
      ]);
      return;
    }
    await client.query(
      `INSERT INTO system_health (institution_id, classifications_updated_at)
       VALUES ($1, $2)
       ON CONFLICT (institution_id)
       DO UPDATE SET classifications_updated_at = EXCLUDED.classifications_updated_at`,
      [officer.institutionId, at],
    );
  });
}

const compile = async (token = accountantToken, query = ''): Promise<InjectResponse> =>
  request('GET', `/reports/msp2/${String(YEAR)}/${String(QUARTER)}${query}`, token);

describe('GET /reports/msp2/:year/:quarter', () => {
  it('refuses a caller without report.generate', async () => {
    await markClassified(new Date());

    const response = await compile(officerToken);

    // A loan officer may read a compiled return but not produce one. Filing
    // figures with a regulator is not the same authority as looking at them.
    expect(response.statusCode).toBe(403);
  });

  it('refuses when classifications have never been computed', async () => {
    await markClassified(null);

    const response = await compile();
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(422);
    expect(body.error.details?.some((detail) => detail.path[0] === 'never_classified')).toBe(true);
    // The refusal has to say what to do, or it is an obstacle rather than a gate.
    expect(body.error.details?.[0]?.message).toContain('classification job');
  });

  it('refuses when the last classification run is stale', async () => {
    // Two days. The limit is twenty-four hours, because a loan crosses from ESM
    // into Substandard because a day passed and nothing else.
    await markClassified(new Date(Date.now() - 48 * 60 * 60 * 1000));

    const response = await compile();
    const body = response.json<ErrorResponse>();

    expect(response.statusCode).toBe(422);
    expect(body.error.details?.some((detail) => detail.path[0] === 'classifications_stale')).toBe(
      true,
    );
  });

  it('refuses a quarter that has not finished', async () => {
    await markClassified(new Date());
    const nextYear = new Date().getUTCFullYear() + 1;

    const response = await request('GET', `/reports/msp2/${String(nextYear)}/4`, accountantToken);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('has not finished');
  });

  it('rejects a quarter outside 1 to 4 before it reaches the domain', async () => {
    await markClassified(new Date());

    const response = await request('GET', '/reports/msp2/2026/7', accountantToken);

    expect(response.statusCode).toBe(400);
  });

  it('refuses while an active branch has no district', async () => {
    await markClassified(new Date());

    const branchId = await harness.database.withTenantTransaction(
      { institutionId: officer.institutionId },
      async (client) => {
        const row = await client.query<{ id: string }>(
          `INSERT INTO branches (institution_id, code, name, district_code)
           VALUES ($1, $2, 'Unlocated Branch', NULL) RETURNING id`,
          [officer.institutionId, `UNL-${randomUUID().slice(0, 6)}`],
        );
        return row.rows[0]!.id;
      },
    );

    try {
      const body = (await compile()).json<ErrorResponse>();

      // MSP2-10 reports branches per district. A branch in no district is a
      // branch counted nowhere, and the filed total would be short by one.
      expect(body.error.details?.some((detail) => detail.path[0] === 'unlocated_branches')).toBe(
        true,
      );
    } finally {
      await harness.database.withTransaction(async (client) => {
        await client.query('DELETE FROM branches WHERE id = $1', [branchId]);
      });
    }
  });

  it('compiles the four portfolio forms with every published row present', async () => {
    await activeLoan('2026-01-15');
    await markClassified(new Date());

    const response = await compile();
    const compiled = response.json<CompiledReturn>();

    expect(response.statusCode).toBe(200);
    expect(compiled.period).toEqual({
      year: YEAR,
      quarter: QUARTER,
      startDate: '2026-01-01',
      endDate: QUARTER_END,
    });

    // BOT's templates have a fixed number of rows read by position, so a sector
    // with no lending is an empty row rather than an absent one.
    expect(compiled.msp2_03.rows).toHaveLength(22);
    expect(compiled.msp2_04.rows).toHaveLength(14);
    expect(compiled.msp2_09.rows).toHaveLength(22);
    expect(compiled.msp2_10.districts).toHaveLength(193);
    expect(compiled.msp2_10.regions).toHaveLength(31);
    // MSP2-02 prints all forty-two lines whether or not anything was recorded
    // against them, and MSP2-07 prints all four of its sections.
    expect(compiled.msp2_02.rows).toHaveLength(42);
    expect(compiled.msp2_07.sections).toHaveLength(4);
    // 61 lines less the heading BOT's own Total Liabilities formula ignores.
    expect(compiled.msp2_01.rows).toHaveLength(60);

    // Sectors in BOT's own serial order, not alphabetical. Sorting by code
    // would file every figure one row out.
    expect(compiled.msp2_03.rows[0]?.sectorCode).toBe('agriculture');
    expect(compiled.msp2_04.rows[0]?.botLoanType).toBe('business_group_loans');
  });

  it('reports every figure as a string, never as a JSON number', async () => {
    await activeLoan('2026-01-20');
    await markClassified(new Date());

    // Read as text rather than through `json()`, because by the time a parser
    // has produced a number the precision is already gone and no assertion on
    // the parsed value can detect it.
    const raw = (await compile()).body;

    expect(raw).not.toMatch(/"totalOutstanding":\s*-?\d/);
    expect(raw).not.toMatch(/"nonPerformingRatio":\s*-?\d/);
    expect(raw).toMatch(/"totalOutstanding":\s*"/);
  });

  it('reports the balance as at the quarter end, not as it stands today', async () => {
    const loan = await activeLoan('2026-02-02', '600000.00');
    await markClassified(new Date());

    const beforePayment = (await compile()).json<CompiledReturn>();
    const outstandingBefore = beforePayment.msp2_03.total.totalOutstanding;

    // Received after the quarter closed, and large enough to reach principal —
    // allocation is interest-first, so a smaller payment would leave the
    // balance unchanged whatever its date and the test would pass without
    // proving anything. This one reduces the loan today and must not touch the
    // figure filed for a quarter that had already ended when it arrived.
    const payment = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: '300000.00',
        datePaid: '2026-04-20',
      })
    ).json<Payment>();
    expect(cents(payment.balanceAfter)).toBeLessThan(cents(payment.balanceBefore));

    const afterPayment = (await compile()).json<CompiledReturn>();

    expect(afterPayment.msp2_03.total.totalOutstanding).toBe(outstandingBefore);
  });

  it('counts a payment made inside the quarter against the quarter’s balance', async () => {
    const loan = await activeLoan('2026-01-05', '900000.00');
    await markClassified(new Date());

    const before = (await compile()).json<CompiledReturn>();

    const payment = (
      await request('POST', `/loans/${loan.id}/payments`, officerToken, {
        amountPaid: '400000.00',
        datePaid: '2026-03-10',
      })
    ).json<Payment>();

    const after = (await compile()).json<CompiledReturn>();

    // The mirror of the test above: in-period money must move the figure, or
    // the restatement would be excluding everything rather than restating.
    //
    // The expected movement is taken from the payment's own snapshots rather
    // than from the amount paid, because the reported figure is principal
    // outstanding and allocation is interest-first — 400,000 received is not
    // 400,000 off the balance. What the return must show is exactly what the
    // loan's balance did.
    const reduction = cents(payment.balanceBefore) - cents(payment.balanceAfter);
    expect(reduction).toBeGreaterThan(0n);
    expect(cents(after.msp2_03.total.totalOutstanding)).toBe(
      cents(before.msp2_03.total.totalOutstanding) - reduction,
    );
  });

  it('reports disbursements as a flow and balances as a stock', async () => {
    await activeLoan('2026-02-14', '750000.00');
    await markClassified(new Date());

    const compiled = (await compile()).json<CompiledReturn>();

    const disbursedRow = compiled.msp2_09.rows.find((row) => row.sectorCode === sectorCode);
    // The borrower is female, so the male column of that sector stays nil while
    // the female one carries the advance at its full principal.
    expect(disbursedRow?.male.count).toBe(0);
    expect(cents(disbursedRow?.female.amount ?? '0')).toBeGreaterThan(0n);
    expect(compiled.msp2_09.total.total.count).toBe(compiled.msp2_09.total.female.count);
  });

  it('states which annualisation convention produced its rates', async () => {
    await markClassified(new Date());

    const simple = (await compile()).json<CompiledReturn>();
    const effective = (
      await compile(accountantToken, '?annualisation=effective')
    ).json<CompiledReturn>();

    expect(simple.msp2_04.annualisation).toBe('simple');
    expect(effective.msp2_04.annualisation).toBe('effective');

    const row = (compiled: CompiledReturn): { lowest: string | null } =>
      compiled.msp2_04.rows.find((entry) => entry.botLoanType === loanTypeCode)!.straightLine;

    // 2% a month is 24% simple and 26.8242% compounded. Which BOT reads is
    // §11.2, which is why the convention is a parameter and is echoed back.
    expect(row(simple).lowest).toBe('24.0000');
    expect(row(effective).lowest).not.toBe(row(simple).lowest);
  });

  it('rejects an annualisation convention it does not implement', async () => {
    await markClassified(new Date());

    const response = await compile(accountantToken, '?annualisation=continuous');

    expect(response.statusCode).toBe(400);
  });

  it('lists the forms it cannot produce rather than filing four of ten silently', async () => {
    await markClassified(new Date());

    const compiled = (await compile()).json<CompiledReturn>();

    // A screen showing four forms and saying nothing about the other six reads
    // as a complete submission, and the institution finds out otherwise at the
    // filing desk.
    // One, since stage 12 supplied MSP2-01 and MSP2-05. Complaints are the
    // only form left.
    expect(compiled.unavailableForms.map((form) => form.code)).toEqual(['MSP2-06']);
    expect(compiled.unavailableForms.every((form) => form.reason.length > 0)).toBe(true);
  });

  it('refuses to call a return submittable while the balance sheet is empty', async () => {
    await markClassified(new Date());

    const compiled = (await compile()).json<CompiledReturn>();

    // Rule 1 doing its job rather than a defect: nothing has been entered
    // against MSP2-01, so it does not balance. The finding names the rule and
    // says what to look at first.
    const ruleOne = compiled.validation.findings.find((finding) => finding.ruleId === 1);
    expect(ruleOne?.severity).toBe('blocking');
    expect(ruleOne?.message).toMatch(/have not been filled in yet/);
    expect(compiled.validation.submittable).toBe(false);
  });

  it('warns rather than blocks when compulsory savings are nil', async () => {
    await markClassified(new Date());

    const compiled = (await compile()).json<CompiledReturn>();

    // An institution may genuinely hold none. What the warning says is that
    // rule 16 passes only because both sides derive from the same nil.
    const warning = compiled.validation.findings.find((finding) =>
      finding.message.includes('Compulsory savings are reported as nil'),
    );
    expect(warning?.severity).toBe('warning');
  });

  it('keeps one institution’s figures out of another’s return', async () => {
    await markClassified(new Date());
    const outsider = await seedUser(harness.database, { roles: ['accountant'] });
    const outsiderToken = await tokenFor(outsider);

    await harness.database.withTransaction(async (client) => {
      await client.query(
        `INSERT INTO system_health (institution_id, classifications_updated_at)
         VALUES ($1, now())
         ON CONFLICT (institution_id)
         DO UPDATE SET classifications_updated_at = EXCLUDED.classifications_updated_at`,
        [outsider.institutionId],
      );
    });

    const mine = (await compile()).json<CompiledReturn>();
    const theirs = (await compile(outsiderToken)).json<CompiledReturn>();

    expect(cents(mine.msp2_03.total.totalOutstanding)).toBeGreaterThan(0n);
    // A fresh institution has lent nothing. Anything else here would mean the
    // point-in-time query reached across the tenant boundary.
    expect(theirs.msp2_03.total.totalOutstanding).toBe('0.00');
    expect(theirs.msp2_03.total.borrowerCount).toBe(0);
  });
});
