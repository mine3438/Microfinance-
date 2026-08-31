import { randomUUID } from 'node:crypto';

import { type ApprovalThreshold, type ErrorResponse } from '@mfi/contracts';
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
 * Approval limits, as settings rather than as a question.
 *
 * §13.3 asked an institution for its thresholds as though they were a decision
 * somebody could give once. They are not: two providers will set them
 * differently and both will change them next year. Until this module existed
 * the figures had nowhere to go — the approval check read a table that nothing
 * could write.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let adminToken: string;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  adminToken = await tokenFor(
    await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']),
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
       VALUES ($1, $2, $3, 'Seed Staff', $4, 'active') RETURNING id`,
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
  method: 'GET' | 'PUT',
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

const limitFor = (thresholds: ApprovalThreshold[], role: string): string | null =>
  thresholds.find((threshold) => threshold.roleCode === role)?.maxPrincipal ?? null;

describe('GET /settings/approval-thresholds', () => {
  it('lists every role, including the ones with no authority', async () => {
    const thresholds = (await request('GET', '/settings/approval-thresholds', officerToken)).json<
      ApprovalThreshold[]
    >();

    // A screen has to show "no limit set" as a state rather than as a missing
    // row, because the absence of a limit means no authority at all.
    expect(thresholds.length).toBeGreaterThanOrEqual(5);
    expect(thresholds.every((threshold) => threshold.roleName.length > 0)).toBe(true);
    expect(limitFor(thresholds, 'branch_manager')).toBeNull();
  });
});

describe('PUT /settings/approval-thresholds/:role', () => {
  it('records a limit an administrator sets', async () => {
    const response = await request(
      'PUT',
      '/settings/approval-thresholds/branch_manager',
      adminToken,
      { maxPrincipal: '2500000.00' },
    );

    expect(response.statusCode).toBe(200);
    expect(limitFor(response.json<ApprovalThreshold[]>(), 'branch_manager')).toBe('2500000.00');
  });

  it('clearing a limit removes the authority rather than making it unlimited', async () => {
    await request('PUT', '/settings/approval-thresholds/accountant', adminToken, {
      maxPrincipal: '500000.00',
    });

    const cleared = await request('PUT', '/settings/approval-thresholds/accountant', adminToken, {
      maxPrincipal: null,
    });

    expect(limitFor(cleared.json<ApprovalThreshold[]>(), 'accountant')).toBeNull();
  });

  it('refuses a role this system does not have', async () => {
    const response = await request('PUT', '/settings/approval-thresholds/regulator', adminToken, {
      maxPrincipal: '1000.00',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses a limit of nothing, which is not the same as no limit', async () => {
    // Zero would read as "may sanction nothing" and so would an absent row, but
    // only one of them is a state the schema allows.
    const response = await request(
      'PUT',
      '/settings/approval-thresholds/branch_manager',
      adminToken,
      { maxPrincipal: '0.00' },
    );

    expect(response.statusCode).toBe(400);
  });

  it('refuses an officer setting the limit they are governed by', async () => {
    const response = await request(
      'PUT',
      '/settings/approval-thresholds/branch_manager',
      officerToken,
      { maxPrincipal: '99999999.00' },
    );

    // A role that could raise its own limit would not be a limit.
    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('settings.manage');
  });

  it('does not leak a limit across institutions', async () => {
    await request('PUT', '/settings/approval-thresholds/branch_manager', adminToken, {
      maxPrincipal: '7000000.00',
    });

    const outsider = await seedUser(harness.database, { roles: ['institution_admin'] });
    const theirs = (
      await request('GET', '/settings/approval-thresholds', await tokenFor(outsider))
    ).json<ApprovalThreshold[]>();

    expect(limitFor(theirs, 'branch_manager')).toBeNull();
  });
});
