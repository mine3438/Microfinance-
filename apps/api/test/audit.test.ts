import { randomUUID } from 'node:crypto';

import {
  type AuditEntry,
  type AuditEntryDetail,
  type AuditedTable,
  type Client,
  type ErrorResponse,
  type Page,
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
 * Reading the audit trail.
 *
 * The trail has been written since migration 0006, by a trigger on every
 * business table, and `schema-invariants.test.ts` asserts that no table escaped
 * it. What this suite covers is the half that did not exist: reading it back.
 *
 * The tests below are mostly about refusals, because the interesting property
 * of an audit reader is not that it returns rows — it is who it returns them
 * to, and what it does when asked a question it does not understand.
 */

let harness: Harness;
let officer: SeededUser;
let officerToken: string;
let admin: SeededUser;
let adminToken: string;
let districtCode: string;
let sectorCode: string;

beforeAll(async () => {
  harness = await startHarness();

  officer = await seedUser(harness.database, { roles: ['loan_officer'] });
  officerToken = await tokenFor(officer);

  admin = await seedUserIn(officer.institutionId, officer.branchId, ['institution_admin']);
  adminToken = await tokenFor(admin);

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

/** Register a borrower through the API, so the change has a human actor. */
async function registerClient(fullName: string): Promise<Client> {
  const response = await request('POST', '/clients', officerToken, {
    fullName,
    gender: 'female',
    dateOfBirth: '1991-04-17',
    phone: `07${String(Math.floor(10_000_000 + Math.random() * 89_999_999))}`,
    districtCode,
    sectorCode,
  });

  expect(response.statusCode).toBe(201);
  return response.json<Client>();
}

describe('GET /audit', () => {
  it('reports a change made through the API, and who made it', async () => {
    const created = await registerClient('Amina Hassan');

    const page = (
      await request('GET', `/audit?tableName=clients&rowId=${created.id}`, adminToken)
    ).json<Page<AuditEntry>>();

    expect(page.items).toHaveLength(1);
    const entry = page.items[0]!;
    expect(entry.operation).toBe('INSERT');
    expect(entry.tableName).toBe('clients');
    // The actor comes from `app.user_id`, set by the tenant transaction — not
    // from anything the request body said about itself.
    expect(entry.actorUserId).toBe(officer.userId);
    expect(entry.actorName).toBe('Seed Officer');
  });

  it('names the columns an update actually moved, and no others', async () => {
    const created = await registerClient('Neema Joseph');
    const renamed = await request('PATCH', `/clients/${created.id}`, officerToken, {
      fullName: 'Neema Joseph Mushi',
    });
    expect(renamed.statusCode).toBe(200);

    const page = (
      await request(
        'GET',
        `/audit?tableName=clients&rowId=${created.id}&operation=UPDATE`,
        adminToken,
      )
    ).json<Page<AuditEntry>>();

    expect(page.items).toHaveLength(1);
    // `updated_at` moves too — a trigger maintains it — so the assertion is
    // that the name is listed and that untouched columns are not.
    expect(page.items[0]!.changedColumns).toContain('full_name');
    expect(page.items[0]!.changedColumns).not.toContain('phone');
    expect(page.items[0]!.changedColumns).not.toContain('date_of_birth');
  });

  it('records the changes a scheduled run makes with no actor at all', async () => {
    // Seeding happens outside any request, as a migration or a nightly job
    // does. Those entries are not defective: an audit trail that could only
    // describe user actions would be silent about exactly the changes nobody
    // watched happen.
    const page = (await request('GET', '/audit?tableName=institutions', adminToken)).json<
      Page<AuditEntry>
    >();

    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((entry) => entry.actorUserId === null)).toBe(true);
    expect(page.items.every((entry) => entry.actorName === null)).toBe(true);
  });

  it('refuses a reader without audit.read', async () => {
    // A loan officer can see the borrowers they registered. They cannot see who
    // else touched them, which is a different question and a different
    // permission.
    expect((await request('GET', '/audit', officerToken)).statusCode).toBe(403);
  });

  it('refuses a table the trail does not cover, rather than reporting nothing happened', async () => {
    // `clients` exists; `client` does not. Returning an empty page would say
    // "no borrower was ever changed", which is a false answer to a question the
    // server did not understand.
    const response = await request('GET', '/audit?tableName=client', adminToken);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorResponse>().error.code).toBe('rule_violation');
  });

  it('refuses a filter the contract does not define', async () => {
    expect((await request('GET', '/audit?tabel=clients', adminToken)).statusCode).toBe(400);
  });

  it('shows one institution nothing of another', async () => {
    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const strangerToken = await tokenFor(stranger);
    const created = await registerClient('Halima Said');

    const page = (await request('GET', `/audit?rowId=${created.id}`, strangerToken)).json<
      Page<AuditEntry>
    >();

    // Not a filtered-out row: the policy on `audit_logs` scopes the table to
    // the caller's institution, so the row is not visible to this session at
    // all.
    expect(page.items).toEqual([]);
  });

  it('pages newest first, and the cursor does not repeat a row', async () => {
    await registerClient('Rehema Paul');
    await registerClient('Grace Mwita');

    const first = (await request('GET', '/audit?limit=1', adminToken)).json<Page<AuditEntry>>();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();

    const second = (
      await request('GET', `/audit?limit=1&cursor=${String(first.nextCursor)}`, adminToken)
    ).json<Page<AuditEntry>>();

    expect(second.items).toHaveLength(1);
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
    // UUIDv7 orders by creation time, so newest-first is id-descending.
    expect(second.items[0]!.id < first.items[0]!.id).toBe(true);
  });
});

describe('GET /audit/tables', () => {
  it('lists the tables the trigger is attached to', async () => {
    const tables = (await request('GET', '/audit/tables', adminToken)).json<AuditedTable[]>();
    const names = tables.map((table) => table.name);

    expect(names).toContain('clients');
    expect(names).toContain('loans');
    expect(names).toContain('payments');
  });

  it('omits the tables migration 0006 deliberately excluded', async () => {
    const names = (await request('GET', '/audit/tables', adminToken))
      .json<AuditedTable[]>()
      .map((table) => table.name);

    // Session churn, and auditing the audit log is circular.
    expect(names).not.toContain('refresh_tokens');
    expect(names).not.toContain('audit_logs');
  });

  it('refuses a reader without audit.read', async () => {
    expect((await request('GET', '/audit/tables', officerToken)).statusCode).toBe(403);
  });
});

describe('GET /audit/:id', () => {
  it('returns the row as it stood after the change, and nothing before it', async () => {
    const created = await registerClient('Zainabu Omary');
    const page = (
      await request('GET', `/audit?tableName=clients&rowId=${created.id}`, adminToken)
    ).json<Page<AuditEntry>>();

    const detail = (
      await request('GET', `/audit/${page.items[0]!.id}`, adminToken)
    ).json<AuditEntryDetail>();

    expect(detail.before).toBeNull();
    expect(detail.after?.['full_name']).toBe('Zainabu Omary');
  });

  it('carries no password hash, on a table that has one', async () => {
    // `audit_redact()` strips it at write time, so this is not the reader being
    // careful — it is the reader confirming the trail never held it. An audit
    // log full of password hashes would be a second credential store with a
    // longer retention and a wider audience than the first.
    const page = (await request('GET', '/audit?tableName=users', adminToken)).json<
      Page<AuditEntry>
    >();
    expect(page.items.length).toBeGreaterThan(0);

    const detail = (
      await request('GET', `/audit/${page.items[0]!.id}`, adminToken)
    ).json<AuditEntryDetail>();

    const payload = detail.after ?? detail.before ?? {};
    expect(Object.keys(payload)).toContain('email');
    expect(Object.keys(payload)).not.toContain('password_hash');
  });

  it('reports an entry belonging to another institution as absent', async () => {
    const created = await registerClient('Fatuma Juma');
    const page = (
      await request('GET', `/audit?tableName=clients&rowId=${created.id}`, adminToken)
    ).json<Page<AuditEntry>>();

    const stranger = await seedUser(harness.database, { roles: ['institution_admin'] });
    const response = await request('GET', `/audit/${page.items[0]!.id}`, await tokenFor(stranger));

    expect(response.statusCode).toBe(404);
  });

  it('refuses a reader without audit.read', async () => {
    const created = await registerClient('Sophia Kimaro');
    const page = (
      await request('GET', `/audit?tableName=clients&rowId=${created.id}`, adminToken)
    ).json<Page<AuditEntry>>();

    expect((await request('GET', `/audit/${page.items[0]!.id}`, officerToken)).statusCode).toBe(
      403,
    );
  });
});
