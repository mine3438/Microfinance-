import {
  type Complaint,
  type ComplaintNature,
  type CompiledReturn,
  type ErrorResponse,
  type Page,
} from '@mfi/contracts';
import { type Response as InjectResponse } from 'light-my-request';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { randomUUID } from 'node:crypto';

import { hashPassword } from '@mfi/identity';

import {
  DEFAULT_TEST_PASSWORD,
  freshAddress,
  seedUser,
  startHarness,
  type Harness,
  type SeededUser,
} from './harness.js';

/**
 * Complaints, and the roll-forward they produce.
 *
 * MSP2-06 is the only form on the return that is a movement statement, and
 * every line of it is a question about dates. So the suite is mostly about
 * dates: which quarter a complaint lands in, when it stops being unresolved,
 * and when a referral starts counting.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let auditorToken: string;
/** Compiling a return is `report.generate`, which a loan officer does not hold. */
let accountantToken: string;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);

  const auditor = await seedUser(harness.database, { roles: ['auditor'] });
  auditorToken = await tokenFor(auditor);

  accountantToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['accountant']),
  );

  await harness.database.withTransaction(async (client) => {
    await client.query(
      `INSERT INTO system_health (institution_id, classifications_updated_at)
       VALUES ($1, now())
       ON CONFLICT (institution_id)
       DO UPDATE SET classifications_updated_at = EXCLUDED.classifications_updated_at`,
      [officer.institutionId],
    );
  });
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
       VALUES ($1, $2, $3, 'Seed Accountant', $4, 'active') RETURNING id`,
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
  method: 'GET' | 'POST',
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

/** Log a complaint against the seeded institution's head office. */
async function log(
  overrides: Record<string, unknown> = {},
  token = officerToken,
): Promise<InjectResponse> {
  return request('POST', '/complaints', token, {
    complainantName: 'Neema Kileo',
    branchId: officer.branchId,
    natureCode: 'repayments',
    summary: 'A repayment was credited to the wrong loan.',
    amount: '250000.00',
    receivedOn: '2026-02-11',
    ...overrides,
  });
}

/** Compile a quarter and pull MSP2-06 out of it. */
async function msp2_06(year: number, quarter: number): Promise<CompiledReturn['msp2_06']> {
  const response = await request(
    'GET',
    `/reports/msp2/${String(year)}/${String(quarter)}`,
    accountantToken,
  );
  return response.json<CompiledReturn>().msp2_06;
}

const countAt = (form: CompiledReturn['msp2_06'], sno: number): number =>
  form.rows.find((row) => row.sno === sno)?.count ?? 0;

describe('GET /reference/complaint-natures', () => {
  it('serves BOT’s six categories so no client embeds its own copy', async () => {
    const response = await request('GET', '/reference/complaint-natures', officerToken);

    const natures = response.json<ComplaintNature[]>();
    expect(natures).toHaveLength(6);
    expect(natures.map((nature) => nature.code)).toContain('loan_processing');
  });
});

describe('POST /complaints', () => {
  it('logs a complaint with an allocated code', async () => {
    const response = await log();

    expect(response.statusCode).toBe(201);
    const complaint = response.json<Complaint>();
    expect(complaint.complaintCode).toMatch(/^CMP-2026-\d{3}$/u);
    expect(complaint.natureName).toBe('Repayments');
    expect(complaint.resolvedOn).toBeNull();
    // A complaint need not be about a client on the books.
    expect(complaint.clientId).toBeNull();
  });

  it('refuses a nature BOT does not publish', async () => {
    // The form has a column per category and no room for a seventh, so this is
    // refused by the database rather than accepted and lost at compile time.
    const response = await log({ natureCode: 'staff_conduct' });

    // A foreign key, so the refusal reads as a bad field rather than as a rule
    // the caller could argue with.
    expect(response.statusCode).toBe(400);
  });

  it('refuses a complaint received in the future', async () => {
    const response = await log({ receivedOn: '2099-01-01' });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('future');
  });

  it('refuses a caller without complaint.manage', async () => {
    const response = await log({}, auditorToken);

    expect(response.statusCode).toBe(403);
  });
});

describe('POST /complaints/:id/resolution', () => {
  it('records which of BOT’s two routes resolved it', async () => {
    const complaint = (await log({ receivedOn: '2026-02-01' })).json<Complaint>();

    const response = await request('POST', `/complaints/${complaint.id}/resolution`, officerToken, {
      resolvedOn: '2026-02-20',
      resolvedBy: 'other_party',
      resolutionNote: 'Settled at the Fair Competition Commission.',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Complaint>().resolvedBy).toBe('other_party');
  });

  it('refuses a resolution dated before the complaint arrived', async () => {
    const complaint = (await log({ receivedOn: '2026-02-11' })).json<Complaint>();

    const response = await request('POST', `/complaints/${complaint.id}/resolution`, officerToken, {
      resolvedOn: '2026-01-05',
      resolvedBy: 'institution',
      resolutionNote: 'Impossible.',
    });

    expect(response.statusCode).toBe(422);
    // BOT's roll-forward is an identity only while the dates are in order.
    expect(response.json<ErrorResponse>().error.message).toContain('roll-forward');
  });

  it('refuses to resolve the same complaint twice', async () => {
    const complaint = (await log()).json<Complaint>();
    const resolution = {
      resolvedOn: '2026-03-01',
      resolvedBy: 'institution',
      resolutionNote: 'Repayment reallocated.',
    };

    await request('POST', `/complaints/${complaint.id}/resolution`, officerToken, resolution);
    const second = await request(
      'POST',
      `/complaints/${complaint.id}/resolution`,
      officerToken,
      resolution,
    );

    expect(second.statusCode).toBe(409);
    // Re-resolving would move it between quarters on a form already filed.
    expect(second.json<ErrorResponse>().error.message).toContain('already been resolved');
  });
});

describe('POST /complaints/:id/referral', () => {
  it('records where an open complaint has been taken, and when', async () => {
    const complaint = (await log({ receivedOn: '2026-02-02' })).json<Complaint>();

    const response = await request('POST', `/complaints/${complaint.id}/referral`, officerToken, {
      referredTo: 'bank_of_tanzania',
      referredOn: '2026-03-15',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<Complaint>().referredTo).toBe('bank_of_tanzania');
  });

  it('refuses to refer a complaint that has been resolved', async () => {
    const complaint = (await log({ receivedOn: '2026-02-03' })).json<Complaint>();
    await request('POST', `/complaints/${complaint.id}/resolution`, officerToken, {
      resolvedOn: '2026-02-10',
      resolvedBy: 'institution',
      resolutionNote: 'Closed.',
    });

    const response = await request('POST', `/complaints/${complaint.id}/referral`, officerToken, {
      referredTo: 'courts',
      referredOn: '2026-02-20',
    });

    expect(response.statusCode).toBe(409);
    // Lines 6-9 count referrals of unresolved complaints only.
    expect(response.json<ErrorResponse>().error.message).toContain('unresolved');
  });
});

describe('GET /complaints', () => {
  it('separates the open from the resolved', async () => {
    const open = (await request('GET', '/complaints?state=open', officerToken)).json<
      Page<Complaint>
    >();
    const resolved = (await request('GET', '/complaints?state=resolved', officerToken)).json<
      Page<Complaint>
    >();

    expect(open.items.every((complaint) => complaint.resolvedOn === null)).toBe(true);
    expect(resolved.items.every((complaint) => complaint.resolvedOn !== null)).toBe(true);
    expect(resolved.items.length).toBeGreaterThan(0);
  });

  it('does not serve another institution’s complaints', async () => {
    const outsider = await seedUser(harness.database, { roles: ['loan_officer'] });

    const page = (await request('GET', '/complaints', await tokenFor(outsider))).json<
      Page<Complaint>
    >();

    expect(page.items).toHaveLength(0);
  });
});

describe('MSP2-06', () => {
  it('rolls the complaints forward across the quarter', async () => {
    // 2026 Q1 holds everything logged above: several received in February, one
    // resolved by the institution in March, one by another party in February.
    const form = await msp2_06(2026, 1);

    expect(form.rows.map((row) => row.sno)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const rollForward = countAt(form, 1) + countAt(form, 2) - countAt(form, 3) - countAt(form, 4);
    // Line 5 is derived from the records, not from this arithmetic. That the
    // two agree is BOT's rule 8.
    expect(countAt(form, 5)).toBe(rollForward);
    expect(countAt(form, 2)).toBeGreaterThan(0);
  });

  it('carries an open complaint into the next quarter as its opening balance', async () => {
    const first = await msp2_06(2026, 1);
    const second = await msp2_06(2026, 2);

    // Nothing is stored between the two: the second quarter's opening line is
    // the first quarter's closing line because both are the same question about
    // the same records, asked at different moments.
    expect(countAt(second, 1)).toBe(countAt(first, 5));
  });

  it('splits every line across BOT’s six natures', async () => {
    const form = await msp2_06(2026, 1);
    const received = form.rows.find((row) => row.sno === 2);

    expect(Object.keys(received?.byNature ?? {})).toHaveLength(6);
    const split = Object.values(received?.byNature ?? {}).reduce((sum, count) => sum + count, 0);
    // Rule 7.
    expect(split).toBe(received?.count);
  });

  it('leaves nothing on the return unavailable', async () => {
    const response = await request('GET', '/reports/msp2/2026/1', accountantToken);

    // MSP2-06 was the last one. All ten forms now compile.
    expect(response.json<CompiledReturn>().unavailableForms).toEqual([]);
  });
});
