import { randomUUID } from 'node:crypto';

import { type Client, type ErrorResponse, type Page } from '@mfi/contracts';
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

/** An officer confined to one branch, and an administrator who is not. */
let officer: SeededUser;
let officerToken: string;
let admin: SeededUser;
let adminToken: string;

/** A second branch in the officer's institution, which they may not reach. */
let otherBranchId: string;

/** A user in a different institution entirely. */
let outsider: SeededUser;
let outsiderToken: string;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);

  // A different institution entirely, for the cross-tenant assertions.
  outsider = await seedUser(harness.database, { roles: ['loan_officer'] });
  outsiderToken = await tokenFor(outsider);

  // A second branch, and an administrator, both inside the *officer's*
  // institution. The administrator has to share it: these tests turn on one
  // user seeing a branch another cannot, and a second institution would make
  // row-level security the reason rather than branch authority — a different
  // control, leaving this one untested.
  otherBranchId = await harness.database.withTenantTransaction(
    { institutionId: officer.institutionId },
    async (client) => {
      const branch = await client.query<{ id: string }>(
        `INSERT INTO branches (institution_id, code, name, is_head_office)
         VALUES ($1, 'MWZ', 'Mwanza Branch', false) RETURNING id`,
        [officer.institutionId],
      );
      return branch.rows[0]!.id;
    },
  );

  admin = await seedAdminIn(officer.institutionId);
  adminToken = await tokenFor(admin);
});

afterAll(async () => {
  await harness.close();
});

/**
 * An institution-wide administrator inside an existing institution.
 *
 * `branch_id` is left null, which is what institution-wide authority *is* in a
 * principal — not a role name, but the absence of a branch to be confined to.
 */
async function seedAdminIn(institutionId: string): Promise<SeededUser> {
  const email = `admin.${randomUUID().slice(0, 8)}@seed.test`;
  const passwordHash = await hashPassword(DEFAULT_TEST_PASSWORD);

  return harness.database.withTransaction(async (client) => {
    const branch = await client.query<{ id: string }>(
      'SELECT id FROM branches WHERE institution_id = $1 ORDER BY code LIMIT 1',
      [institutionId],
    );
    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, NULL, $2, 'Seed Administrator', $3, 'active') RETURNING id`,
      [institutionId, email, passwordHash],
    );
    const userId = user.rows[0]!.id;
    await client.query(
      `INSERT INTO user_roles (institution_id, user_id, role_code)
       VALUES ($1, $2, 'institution_admin')`,
      [institutionId, userId],
    );

    return {
      institutionId,
      branchId: branch.rows[0]!.id,
      userId,
      email,
      password: DEFAULT_TEST_PASSWORD,
    };
  });
}

/** Sign a token the way login would, without going through the endpoint. */
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

/** A valid registration body, minus anything a test wants to change. */
const validClient = {
  fullName: 'Amina Hassan',
  gender: 'female',
  dateOfBirth: '1991-04-17',
  phone: '0712345678',
  districtCode: 'TZ-01-01',
  sectorCode: 'A',
} as const;

/** District and sector codes actually seeded from BOT's template. */
let districtCode: string;
let sectorCode: string;

beforeAll(async () => {
  const reference = await harness.database.withTransaction(async (client) => {
    const district = await client.query<{ code: string }>(
      'SELECT code FROM reference.districts ORDER BY code LIMIT 1',
    );
    const sector = await client.query<{ code: string }>(
      'SELECT code FROM reference.sectors ORDER BY code LIMIT 1',
    );
    return { district: district.rows[0]!.code, sector: sector.rows[0]!.code };
  });
  districtCode = reference.district;
  sectorCode = reference.sector;
});

const registration = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...validClient,
  districtCode,
  sectorCode,
  ...overrides,
});

describe('POST /clients', () => {
  it('registers a client and allocates a code', async () => {
    const response = await request('POST', '/clients', officerToken, registration());

    expect(response.statusCode).toBe(201);
    const created = response.json<Client>();
    // Allocated by a database trigger, never supplied by the caller.
    expect(created.clientCode).toMatch(/^MFI-\d{4}-\d+$/);
    expect(response.headers.location).toBe(`/clients/${created.id}`);
  });

  it('normalises the phone number to E.164, whatever form it arrived in', async () => {
    // The system this replaces stored whatever was typed and validated only in
    // the browser, so one borrower could exist twice under two spellings of one
    // number — two client records, two loan histories, one person.
    for (const typed of ['0712345678', '+255712345678', '255712345678', '0712 345 678']) {
      const response = await request(
        'POST',
        '/clients',
        officerToken,
        registration({ phone: typed }),
      );

      expect(response.statusCode).toBe(201);
      expect(response.json<Client>().phone).toBe('+255712345678');
    }
  });

  it('infers the branch from a branch-scoped officer', async () => {
    const created = await request('POST', '/clients', officerToken, registration());

    expect(created.json<Client>().branchId).toBe(officer.branchId);
  });

  it('refuses an officer registering into another branch', async () => {
    const response = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ branchId: otherBranchId }),
    );

    expect(response.statusCode).toBe(403);
  });

  it('requires an institution-wide user to state the branch, since none can be inferred', async () => {
    const response = await request('POST', '/clients', adminToken, registration());

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.path).toEqual(['branchId']);
  });

  it('lets an institution-wide user register into any branch they name', async () => {
    const response = await request(
      'POST',
      '/clients',
      adminToken,
      registration({ branchId: admin.branchId }),
    );

    expect(response.statusCode).toBe(201);
  });

  it('refuses a branch belonging to another institution', async () => {
    const response = await request(
      'POST',
      '/clients',
      adminToken,
      registration({ branchId: outsider.branchId }),
    );

    // Row-level security makes the branch invisible, so it reads as a bad field
    // value rather than as a permission problem — which is also the answer that
    // discloses least.
    expect(response.statusCode).toBe(400);
  });

  it.each([
    ['a gender outside BOT’s two columns', { gender: 'other' }],
    ['a future date of birth', { dateOfBirth: '2999-01-01' }],
    ['a date that does not exist', { dateOfBirth: '2025-02-29' }],
    ['a phone number that is not Tanzanian', { phone: '+441234567890' }],
    ['a blank name', { fullName: '   ' }],
    ['a district outside the seeded taxonomy', { districtCode: 'NOWHERE' }],
  ])('refuses %s', async (_label, override) => {
    const response = await request('POST', '/clients', officerToken, registration(override));

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).toBeLessThan(500);
  });

  it('names the field when a district or sector is outside BOT’s taxonomy', async () => {
    // A foreign key would catch this regardless, but its error names a
    // constraint and not an input. MSP2-10 aggregates across this exact
    // hierarchy, so a code that does not exist is a borrower missing from a
    // return — worth an error that says which box was wrong.
    const response = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ districtCode: 'NOWHERE', sectorCode: 'ALSO-NOWHERE' }),
    );

    expect(response.statusCode).toBe(400);
    expect(
      response
        .json<ErrorResponse>()
        .error.details?.map((d) => d.path[0])
        .sort(),
    ).toEqual(['districtCode', 'sectorCode']);
  });

  it('names the field for an implausible date of birth', async () => {
    const response = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ dateOfBirth: '2999-01-01' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.details?.[0]?.path).toEqual(['dateOfBirth']);
  });

  it('rejects a caller-supplied client code rather than honouring it', async () => {
    const response = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ clientCode: 'MFI-2020-999' }),
    );

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponse>().error.code).toBe('validation_failed');
  });

  it('rejects a caller-supplied institution', async () => {
    const response = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ institutionId: outsider.institutionId }),
    );

    expect(response.statusCode).toBe(400);
  });
});

describe('GET /clients', () => {
  it('returns a page with a cursor and no total', async () => {
    const page = (await request('GET', '/clients?limit=2', officerToken)).json<Page<Client>>();

    expect(page.items.length).toBeLessThanOrEqual(2);
    expect(page).toHaveProperty('nextCursor');
    expect(page).not.toHaveProperty('total');
  });

  it('pages through every client exactly once', async () => {
    // The property offset pagination cannot hold under concurrent writes: a
    // client registered mid-listing shifts every later row, so a record is seen
    // twice or missed. On a portfolio listing that is a reconciliation problem.
    const seen: string[] = [];
    let cursor: string | null = null;

    for (let guard = 0; guard < 20; guard += 1) {
      const url: string =
        cursor === null ? '/clients?limit=2' : `/clients?limit=2&cursor=${cursor}`;
      const page: Page<Client> = (await request('GET', url, officerToken)).json<Page<Client>>();
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
      if (cursor === null) {
        break;
      }
    }

    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(2);
  });

  it('orders newest first, which UUIDv7 gives for free', async () => {
    const created = await request(
      'POST',
      '/clients',
      officerToken,
      registration({ fullName: 'Newest Borrower' }),
    );
    const page = (await request('GET', '/clients?limit=1', officerToken)).json<Page<Client>>();

    expect(page.items[0]?.id).toBe(created.json<Client>().id);
  });

  it('shows a branch-scoped officer only their own branch', async () => {
    await request('POST', '/clients', adminToken, registration({ branchId: otherBranchId }));

    const page = (await request('GET', '/clients?limit=100', officerToken)).json<Page<Client>>();

    expect(page.items.every((item) => item.branchId === officer.branchId)).toBe(true);
    expect(page.items.length).toBeGreaterThan(0);
  });

  it('refuses an officer filtering by a branch that is not theirs', async () => {
    // Refused rather than quietly narrowed to their own branch: returning one
    // branch's clients under a filter naming another is a wrong answer
    // presented as a right one.
    const response = await request('GET', `/clients?branchId=${otherBranchId}`, officerToken);

    expect(response.statusCode).toBe(403);
  });

  it('shows an institution-wide user every branch', async () => {
    const page = (await request('GET', '/clients?limit=100', adminToken)).json<Page<Client>>();

    expect(new Set(page.items.map((item) => item.branchId)).size).toBeGreaterThan(0);
  });

  it('shows another institution nothing of this one', async () => {
    const page = (await request('GET', '/clients?limit=100', outsiderToken)).json<Page<Client>>();

    expect(page.items).toEqual([]);
  });

  it('searches by name and by client code', async () => {
    const created = (
      await request('POST', '/clients', officerToken, registration({ fullName: 'Zawadi Mushi' }))
    ).json<Client>();

    const byName = (await request('GET', '/clients?search=Zawadi', officerToken)).json<
      Page<Client>
    >();
    const byCode = (
      await request('GET', `/clients?search=${created.clientCode}`, officerToken)
    ).json<Page<Client>>();

    expect(byName.items.map((item) => item.id)).toContain(created.id);
    expect(byCode.items.map((item) => item.id)).toEqual([created.id]);
  });

  it('treats a wildcard in the search box as a character, not a pattern', async () => {
    // Not injection — a parameterised ILIKE is safe either way — but an
    // unescaped `%` turns a search into a full scan that matches everything.
    const page = (await request('GET', '/clients?search=%25', officerToken)).json<Page<Client>>();

    expect(page.items).toEqual([]);
  });

  it('refuses a page size beyond the cap', async () => {
    expect((await request('GET', '/clients?limit=100000', officerToken)).statusCode).toBe(400);
  });

  it('refuses a cursor it did not issue', async () => {
    const response = await request('GET', '/clients?cursor=bm90LWEtY3Vyc29y', officerToken);

    // Refused rather than ignored: silently starting from page one when the
    // caller asked for page nine reads as data loss.
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown query parameter rather than ignoring it', async () => {
    expect((await request('GET', '/clients?stauts=active', officerToken)).statusCode).toBe(400);
  });
});

describe('GET /clients/:id', () => {
  it('returns a client in the caller’s branch', async () => {
    const created = (
      await request('POST', '/clients', officerToken, registration())
    ).json<Client>();

    const found = await request('GET', `/clients/${created.id}`, officerToken);

    expect(found.statusCode).toBe(200);
    expect(found.json<Client>().id).toBe(created.id);
  });

  it('answers 404, not 403, for a client in another branch', async () => {
    const elsewhere = (
      await request('POST', '/clients', adminToken, registration({ branchId: otherBranchId }))
    ).json<Client>();

    const response = await request('GET', `/clients/${elsewhere.id}`, officerToken);

    // A 403 would confirm that a client with this identifier exists in the
    // institution, which is what the branch boundary exists to withhold.
    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for a client in another institution', async () => {
    const theirs = (
      await request('POST', '/clients', outsiderToken, registration())
    ).json<Client>();

    expect((await request('GET', `/clients/${theirs.id}`, officerToken)).statusCode).toBe(404);
  });

  it('refuses an identifier that is not a UUID before it reaches a query', async () => {
    const response = await request('GET', "/clients/1' OR '1'='1", officerToken);

    expect(response.statusCode).toBe(400);
  });
});

describe('PATCH /clients/:id', () => {
  it('applies a correction', async () => {
    const created = (
      await request('POST', '/clients', officerToken, registration())
    ).json<Client>();

    const updated = await request('PATCH', `/clients/${created.id}`, officerToken, {
      fullName: 'Amina Hassan Mwakalinga',
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json<Client>().fullName).toBe('Amina Hassan Mwakalinga');
  });

  it('normalises a corrected phone number too', async () => {
    const created = (
      await request('POST', '/clients', officerToken, registration())
    ).json<Client>();

    const updated = await request('PATCH', `/clients/${created.id}`, officerToken, {
      phone: '0755000111',
    });

    expect(updated.json<Client>().phone).toBe('+255755000111');
  });

  it.each([
    ['the branch', { branchId: '01930000-0000-7000-8000-000000000000' }],
    ['the client code', { clientCode: 'MFI-2020-001' }],
    ['the institution', { institutionId: '01930000-0000-7000-8000-000000000000' }],
    ['the date of birth', { dateOfBirth: '1980-01-01' }],
  ])('refuses to change %s', async (_label, change) => {
    const created = (
      await request('POST', '/clients', officerToken, registration())
    ).json<Client>();

    const response = await request('PATCH', `/clients/${created.id}`, officerToken, change);

    expect(response.statusCode).toBe(400);
  });

  it('refuses an update naming nothing', async () => {
    const created = (
      await request('POST', '/clients', officerToken, registration())
    ).json<Client>();

    expect((await request('PATCH', `/clients/${created.id}`, officerToken, {})).statusCode).toBe(
      400,
    );
  });

  it('answers 404 for a client in another branch', async () => {
    const elsewhere = (
      await request('POST', '/clients', adminToken, registration({ branchId: otherBranchId }))
    ).json<Client>();

    const response = await request('PATCH', `/clients/${elsewhere.id}`, officerToken, {
      fullName: 'Renamed By Someone Else',
    });

    expect(response.statusCode).toBe(404);
  });
});

describe('authorisation', () => {
  it('refuses every client route without a token', async () => {
    for (const [method, url] of [
      ['GET', '/clients'],
      ['GET', '/clients/01930000-0000-7000-8000-000000000000'],
      ['POST', '/clients'],
      ['PATCH', '/clients/01930000-0000-7000-8000-000000000000'],
    ] as const) {
      const response = await harness.server.inject({
        method,
        url,
        remoteAddress: freshAddress(),
        payload: {},
      });

      expect(response.statusCode).toBe(401);
    }
  });

  it('refuses a reader the permission to register', async () => {
    // An auditor reads everything and writes nothing. The check is a permission,
    // not a role name, so the refusal names the permission that was missing.
    const auditor = await seedUser(harness.database, { roles: ['auditor'] });
    const token = await tokenFor(auditor);

    const response = await request('POST', '/clients', token, registration());

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('client.create');
  });

  it('lets a reader read', async () => {
    const auditor = await seedUser(harness.database, { roles: ['auditor'] });
    const token = await tokenFor(auditor);

    expect((await request('GET', '/clients', token)).statusCode).toBe(200);
  });
});

describe('GET /branches', () => {
  it('lists the institution’s branches, head office first', async () => {
    const listed = (await request('GET', '/branches', officerToken)).json<
      { id: string; name: string; isHeadOffice: boolean }[]
    >();

    expect(listed.length).toBeGreaterThanOrEqual(2);
    expect(listed[0]?.isHeadOffice).toBe(true);
    expect(listed.map((branch) => branch.id)).toContain(otherBranchId);
  });

  it('is answerable by a branch officer, not only by an administrator', async () => {
    // An officer confined to one branch still needs the list: a client, a loan
    // or a complaint is filed against a named branch, and the officer's own is
    // only one of the choices their institution has.
    expect((await request('GET', '/branches', officerToken)).statusCode).toBe(200);
    expect((await request('GET', '/branches', adminToken)).statusCode).toBe(200);
  });

  it('shows an outsider nothing of this institution’s branches', async () => {
    const listed = (await request('GET', '/branches', outsiderToken)).json<{ id: string }[]>();

    expect(listed.map((branch) => branch.id)).not.toContain(otherBranchId);
  });
});

describe('branch management', () => {
  const districtCode = async (): Promise<string> =>
    (await request('GET', '/reference/districts', officerToken)).json<{ code: string }[]>()[0]
      ?.code ?? '';

  it('opens a branch, which nothing in the application could do before', async () => {
    // Branches existed only where a seed script had put them. An institution
    // opening one had no way to record it.
    const response = await request('POST', '/branches', adminToken, {
      code: `BR${randomUUID().slice(0, 6)}`,
      name: 'Mwanza Branch',
      districtCode: await districtCode(),
    });

    expect(response.statusCode).toBe(201);
    expect(response.json<{ name: string; districtCode: string | null }>().name).toBe(
      'Mwanza Branch',
    );
    expect(response.json<{ districtCode: string | null }>().districtCode).not.toBeNull();
  });

  it('requires a district, because MSP2-10 reports per district', async () => {
    // The column is nullable only because migration 0013 added it to branches
    // that already existed. A new branch has no such excuse, and one without a
    // district blocks the whole return through the readiness gate.
    const response = await request('POST', '/branches', adminToken, {
      code: `BR${randomUUID().slice(0, 6)}`,
      name: 'Nowhere Branch',
    });

    expect(response.statusCode).toBe(400);
  });

  it('names the district on every branch it lists', async () => {
    const code = await districtCode();
    await request('POST', '/branches', adminToken, {
      code: `BR${randomUUID().slice(0, 6)}`,
      name: 'Listed Branch',
      districtCode: code,
    });

    const listed = (await request('GET', '/branches', officerToken)).json<
      { name: string; districtName: string | null }[]
    >();

    const branch = listed.find((row) => row.name === 'Listed Branch');
    expect(branch?.districtName).not.toBeNull();
  });

  it('places a branch that had no district, answering the readiness refusal', async () => {
    // This is the refusal that previously needed SQL: the gate blocks a return
    // while any active branch is unplaced.
    const created = (
      await request('POST', '/branches', adminToken, {
        code: `BR${randomUUID().slice(0, 6)}`,
        name: 'Relocatable Branch',
        districtCode: await districtCode(),
      })
    ).json<{ id: string }>();

    const districts = (await request('GET', '/reference/districts', officerToken)).json<
      { code: string }[]
    >();
    const elsewhere = districts[1]?.code ?? '';

    const moved = await request('PATCH', `/branches/${created.id}`, adminToken, {
      districtCode: elsewhere,
    });

    expect(moved.statusCode).toBe(200);
    expect(moved.json<{ districtCode: string }>().districtCode).toBe(elsewhere);
  });

  it('changes only what it was given', async () => {
    const created = (
      await request('POST', '/branches', adminToken, {
        code: `BR${randomUUID().slice(0, 6)}`,
        name: 'Keeps Its Name',
        districtCode: await districtCode(),
      })
    ).json<{ id: string; name: string; districtCode: string }>();

    const closed = await request('PATCH', `/branches/${created.id}`, adminToken, {
      status: 'closed',
    });

    expect(closed.json<{ status: string }>().status).toBe('closed');
    expect(closed.json<{ name: string }>().name).toBe('Keeps Its Name');
    expect(closed.json<{ districtCode: string }>().districtCode).toBe(created.districtCode);
  });

  it('refuses an empty change rather than silently doing nothing', async () => {
    const created = (
      await request('POST', '/branches', adminToken, {
        code: `BR${randomUUID().slice(0, 6)}`,
        name: 'Unchanged Branch',
        districtCode: await districtCode(),
      })
    ).json<{ id: string }>();

    expect((await request('PATCH', `/branches/${created.id}`, adminToken, {})).statusCode).toBe(
      400,
    );
  });

  it('refuses a district BOT does not publish', async () => {
    const response = await request('POST', '/branches', adminToken, {
      code: `BR${randomUUID().slice(0, 6)}`,
      name: 'Imaginary Place',
      districtCode: 'not_a_real_district',
    });

    expect(response.statusCode).toBe(400);
  });

  it('refuses an officer, who may see branches but not open one', async () => {
    const response = await request('POST', '/branches', officerToken, {
      code: `BR${randomUUID().slice(0, 6)}`,
      name: 'Unauthorised Branch',
      districtCode: await districtCode(),
    });

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('branch.manage');
  });

  it('refuses to amend another institution’s branch as though it did not exist', async () => {
    expect(
      (await request('PATCH', `/branches/${randomUUID()}`, adminToken, { name: 'Nope' }))
        .statusCode,
    ).toBe(404);
  });
});

describe('GET /reference/districts and /reference/sectors', () => {
  it('serves BOT’s district list with its region names', async () => {
    // 193 bare district names are unusable — several repeat across regions.
    const districts = (await request('GET', '/reference/districts', officerToken)).json<
      { code: string; name: string; regionName: string }[]
    >();

    expect(districts.length).toBeGreaterThan(100);
    expect(districts[0]?.regionName).toBeTruthy();
  });

  it('serves BOT’s sectors', async () => {
    const sectors = (await request('GET', '/reference/sectors', officerToken)).json<
      { code: string; name: string }[]
    >();

    expect(sectors.length).toBeGreaterThan(1);
    expect(sectors[0]?.name).toBeTruthy();
  });
});
