import { randomUUID } from 'node:crypto';

import { type ErrorResponse, type Group, type GroupMember } from '@mfi/contracts';
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
 * Lending groups, and membership over time.
 *
 * The approved model is GROUP-01…04: the group is the borrower, liability is
 * joint, one disbursement, one balance, one schedule, one repayment.
 *
 * What is tested here is the group and its membership — deliberately not group
 * *lending*, which is blocked on GROUP-05. So the assertion that matters most
 * is the one about intervals: membership has to stay answerable as at a past
 * date, because that is the only thing that will make a group loan legible once
 * the reporting question is settled and people have come and gone.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let adminToken: string;
let clientA: string;
let clientB: string;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);
  adminToken = await tokenFor(await seedUserIn(officer.institutionId, null, ['institution_admin']));

  const reference = await harness.database.withTransaction(async (client) => {
    const district = await client.query<{ code: string }>(
      'SELECT code FROM reference.districts ORDER BY code LIMIT 1',
    );
    const sector = await client.query<{ code: string }>(
      'SELECT code FROM reference.sectors ORDER BY code LIMIT 1',
    );
    return { district: district.rows[0]!.code, sector: sector.rows[0]!.code };
  });

  clientA = await registerClient('Amina Hassan', '0716111222', reference);
  clientB = await registerClient('Joseph Mollel', '0716333444', reference);
});

afterAll(async () => {
  await harness.close();
});

async function registerClient(
  fullName: string,
  phone: string,
  reference: { district: string; sector: string },
): Promise<string> {
  const created = await request('POST', '/clients', officerToken, {
    fullName,
    gender: 'female',
    dateOfBirth: '1990-05-05',
    phone,
    districtCode: reference.district,
    sectorCode: reference.sector,
  });
  return created.json<{ id: string }>().id;
}

async function seedUserIn(
  institutionId: string,
  branchId: string | null,
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
    return {
      institutionId,
      branchId: branchId ?? '',
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

async function makeGroup(overrides: Record<string, unknown> = {}): Promise<Group> {
  const created = await request('POST', '/groups', officerToken, {
    code: `G-${randomUUID().slice(0, 8)}`,
    name: 'Umoja Savings Group',
    formedOn: '2026-01-05',
    ...overrides,
  });
  expect(created.statusCode).toBe(201);
  return created.json<Group>();
}

describe('creating a group', () => {
  it('records the group with the branch inferred from the officer', async () => {
    const group = await makeGroup();

    expect(group.name).toBe('Umoja Savings Group');
    expect(group.branchId).toBe(officer.branchId);
    expect(group.status).toBe('active');
    expect(group.currentMemberCount).toBe(0);
  });

  it('refuses a group formed in the future', async () => {
    const response = await request('POST', '/groups', officerToken, {
      code: `G-${randomUUID().slice(0, 8)}`,
      name: 'Tomorrow Group',
      formedOn: '2099-01-01',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses a duplicate code within the institution', async () => {
    const group = await makeGroup();

    const duplicate = await request('POST', '/groups', officerToken, {
      code: group.code,
      name: 'Another Group',
      formedOn: '2026-01-05',
    });

    expect(duplicate.statusCode).toBe(409);
  });

  it('requires an institution-wide user to name the branch', async () => {
    const response = await request('POST', '/groups', adminToken, {
      code: `G-${randomUUID().slice(0, 8)}`,
      name: 'Unplaced Group',
      formedOn: '2026-01-05',
    });

    // Nothing to infer, so it must be stated — the borrower form's rule.
    expect(response.statusCode).toBe(422);
  });

  it('refuses a caller who cannot register borrowers', async () => {
    const auditor = await seedUserIn(officer.institutionId, officer.branchId, ['auditor']);

    const response = await request('POST', '/groups', await tokenFor(auditor), {
      code: `G-${randomUUID().slice(0, 8)}`,
      name: 'Audited Group',
      formedOn: '2026-01-05',
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('membership', () => {
  it('adds a member and counts them', async () => {
    const group = await makeGroup();

    const added = await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });

    expect(added.statusCode).toBe(201);
    expect(added.json<GroupMember>().leftOn).toBeNull();

    const after = (await request('GET', `/groups/${group.id}`, officerToken)).json<Group>();
    expect(after.currentMemberCount).toBe(1);
  });

  it('refuses the same borrower twice while they are still in', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, { clientId: clientA });

    const again = await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
    });

    expect(again.statusCode).toBe(409);
  });

  it('refuses a borrower who is not registered here', async () => {
    const group = await makeGroup();

    const response = await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: randomUUID(),
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.message).toContain('not registered');
  });

  it('refuses joining before the group was formed', async () => {
    const group = await makeGroup({ formedOn: '2026-03-01' });

    const response = await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });

    expect(response.statusCode).toBe(422);
  });

  it('refuses adding to a closed group', async () => {
    const group = await makeGroup();
    await request('PATCH', `/groups/${group.id}`, officerToken, { status: 'closed' });

    const response = await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
    });

    expect(response.statusCode).toBe(422);
  });
});

describe('membership is an interval, not a roster', () => {
  it('keeps the record after a member leaves', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });

    const departed = await request(
      'POST',
      `/groups/${group.id}/members/${clientA}/departure`,
      officerToken,
      { leftOn: '2026-06-30' },
    );

    expect(departed.statusCode).toBe(200);
    expect(departed.json<GroupMember>().leftOn).toBe('2026-06-30');

    // Gone from today's roster…
    const current = (await request('GET', `/groups/${group.id}/members`, officerToken)).json<
      GroupMember[]
    >();
    expect(current).toHaveLength(0);
  });

  it('answers who was in the group on a past date', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });
    await request('POST', `/groups/${group.id}/members/${clientA}/departure`, officerToken, {
      leftOn: '2026-06-30',
    });

    // …and still there as at a date inside the interval. This is the property
    // that will make a group loan advanced in March legible in December.
    const inMarch = (
      await request('GET', `/groups/${group.id}/members?asAt=2026-03-15`, officerToken)
    ).json<GroupMember[]>();
    expect(inMarch.map((member) => member.clientId)).toEqual([clientA]);

    const inJanuary = (
      await request('GET', `/groups/${group.id}/members?asAt=2026-01-15`, officerToken)
    ).json<GroupMember[]>();
    expect(inJanuary).toHaveLength(0);
  });

  it('counts the day of departure as a day of membership', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });
    await request('POST', `/groups/${group.id}/members/${clientA}/departure`, officerToken, {
      leftOn: '2026-06-30',
    });

    const onTheDay = (
      await request('GET', `/groups/${group.id}/members?asAt=2026-06-30`, officerToken)
    ).json<GroupMember[]>();

    expect(onTheDay).toHaveLength(1);
  });

  it('lets a member rejoin, keeping both periods', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientB,
      joinedOn: '2026-02-01',
    });
    await request('POST', `/groups/${group.id}/members/${clientB}/departure`, officerToken, {
      leftOn: '2026-04-30',
    });
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientB,
      joinedOn: '2026-08-01',
    });

    const rows = await harness.database.withTransaction(async (client) =>
      client.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM group_members WHERE group_id = $1 AND client_id = $2',
        [group.id, clientB],
      ),
    );

    // Two intervals, not one row edited twice. The gap between them is real.
    expect(rows.rows[0]!.count).toBe('2');

    const inMay = (
      await request('GET', `/groups/${group.id}/members?asAt=2026-05-15`, officerToken)
    ).json<GroupMember[]>();
    expect(inMay).toHaveLength(0);
  });

  it('refuses a second departure for the same membership', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, { clientId: clientA });
    await request('POST', `/groups/${group.id}/members/${clientA}/departure`, officerToken, {});

    const again = await request(
      'POST',
      `/groups/${group.id}/members/${clientA}/departure`,
      officerToken,
      {},
    );

    expect(again.statusCode).toBe(409);
  });

  it('refuses rewriting when a membership began', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientA,
      joinedOn: '2026-02-01',
    });

    // No endpoint offers this; the guard is at the database for anything that
    // reaches the table another way.
    await expect(
      harness.database.withTransaction(async (client) =>
        client.query("UPDATE group_members SET joined_on = '2020-01-01' WHERE group_id = $1", [
          group.id,
        ]),
      ),
    ).rejects.toThrow(/cannot be rewritten/);
  });
});

describe('tenant isolation', () => {
  it('shows one institution nothing of another’s groups', async () => {
    await makeGroup();

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const listed = (await request('GET', '/groups', await tokenFor(stranger))).json<Group[]>();

    expect(listed).toEqual([]);
  });

  it('refuses reading another institution’s group by identifier', async () => {
    const group = await makeGroup();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    expect((await request('GET', `/groups/${group.id}`, await tokenFor(stranger))).statusCode).toBe(
      404,
    );
  });

  it('refuses adding a member to another institution’s group', async () => {
    const group = await makeGroup();
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    const response = await request(
      'POST',
      `/groups/${group.id}/members`,
      await tokenFor(stranger),
      { clientId: clientA },
    );

    expect(response.statusCode).toBe(404);
  });
});

describe('the groups a borrower belongs to', () => {
  it('lists them from the borrower’s side', async () => {
    const first = await makeGroup();
    const second = await makeGroup();
    await request('POST', `/groups/${first.id}/members`, officerToken, { clientId: clientA });
    await request('POST', `/groups/${second.id}/members`, officerToken, { clientId: clientA });

    const listed = (await request('GET', `/clients/${clientA}/groups`, officerToken)).json<
      GroupMember[]
    >();

    const ids = listed.map((member) => member.groupId);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('drops a group once the borrower has left it', async () => {
    const group = await makeGroup();
    await request('POST', `/groups/${group.id}/members`, officerToken, {
      clientId: clientB,
      joinedOn: '2026-02-01',
    });
    await request('POST', `/groups/${group.id}/members/${clientB}/departure`, officerToken, {
      leftOn: '2026-06-30',
    });

    const now = (await request('GET', `/clients/${clientB}/groups`, officerToken)).json<
      GroupMember[]
    >();
    expect(now.map((member) => member.groupId)).not.toContain(group.id);

    // …but still there as at a date inside the interval, which is the whole
    // point of holding membership as intervals.
    const then = (
      await request('GET', `/clients/${clientB}/groups?asAt=2026-03-15`, officerToken)
    ).json<GroupMember[]>();
    expect(then.map((member) => member.groupId)).toContain(group.id);
  });

  it('refuses a borrower who is not registered here', async () => {
    expect((await request('GET', `/clients/${randomUUID()}/groups`, officerToken)).statusCode).toBe(
      404,
    );
  });

  it('refuses another institution’s borrower', async () => {
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });

    expect(
      (await request('GET', `/clients/${clientA}/groups`, await tokenFor(stranger))).statusCode,
    ).toBe(404);
  });
});
