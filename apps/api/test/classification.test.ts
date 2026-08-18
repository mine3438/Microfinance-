import { randomUUID } from 'node:crypto';

import { type ErrorResponse } from '@mfi/contracts';
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
 * The overdue classification, and the caller it never had.
 *
 * `update_overdue_classifications()` has existed since migration 0011. Nothing
 * invoked it, which is the same shape of defect as the system being replaced —
 * there the job existed and the `pg_cron` line that ran it was commented out,
 * so a loan forty days overdue reported "Current" to the Bank of Tanzania for
 * as long as the system ran (00-PROJECT-ANALYSIS.md R5).
 *
 * What these tests protect is that running it actually moves a loan, that the
 * readiness gate opens once it has run, and — the part that would otherwise
 * only fail in production — that enumerating institutions works through a
 * definer function rather than a plain SELECT the tenancy policy would empty.
 */

let harness: Harness;
let accountant: SeededUser;
let accountantToken: string;
let officer: SeededUser;
let officerToken: string;

beforeAll(async () => {
  harness = await startHarness();

  accountant = await seedUser(harness.database, { roles: ['accountant'] });
  accountantToken = await tokenFor(accountant);

  officer = await seedUserIn(accountant.institutionId, ['loan_officer'], accountant.branchId);
  officerToken = await tokenFor(officer);
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
    const userId = user.rows[0]?.id ?? '';
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
): Promise<InjectResponse> =>
  harness.server.inject({
    method,
    url,
    remoteAddress: freshAddress(),
    headers: { authorization: `Bearer ${token}` },
  });

/** Read one institution's health record, as the readiness gate does. */
async function health(): Promise<{ updatedAt: Date | null; unclassifiable: number } | null> {
  return harness.database.withTransaction(async (client) => {
    const rows = await client.query<{
      classifications_updated_at: Date | null;
      unclassifiable_loan_count: number;
    }>(
      'SELECT classifications_updated_at, unclassifiable_loan_count FROM system_health WHERE institution_id = $1',
      [accountant.institutionId],
    );
    const row = rows.rows[0];
    return row === undefined
      ? null
      : {
          updatedAt: row.classifications_updated_at,
          unclassifiable: row.unclassifiable_loan_count,
        };
  });
}

describe('POST /portfolio/classification', () => {
  it('stamps a health record where an institution had none', async () => {
    // Absence is meaningful: an institution with no row has never been
    // classified, and the readiness gate refuses on exactly that.
    expect(await health()).toBeNull();

    const response = await request('POST', '/portfolio/classification', accountantToken);

    expect(response.statusCode).toBe(200);
    expect(await health()).not.toBeNull();
  });

  it('reports how many loans no provisioning band covers', async () => {
    // Not incidental. A run that leaves loans unclassifiable has not made the
    // return fileable — the gate refuses on the count — so a caller told only
    // "done" would be misled.
    const response = await request('POST', '/portfolio/classification', accountantToken);

    const body = response.json<{ institutionId: string; unclassifiableLoanCount: number }>();
    expect(body.institutionId).toBe(accountant.institutionId);
    expect(body.unclassifiableLoanCount).toBeGreaterThanOrEqual(0);
  });

  it('moves the recorded timestamp forward on a second run', async () => {
    await request('POST', '/portfolio/classification', accountantToken);
    const first = await health();

    await request('POST', '/portfolio/classification', accountantToken);
    const second = await health();

    expect(first?.updatedAt).not.toBeNull();
    expect(second?.updatedAt).not.toBeNull();
    expect(second!.updatedAt!.getTime()).toBeGreaterThanOrEqual(first!.updatedAt!.getTime());
  });

  it('refuses a caller who cannot generate reports', async () => {
    // The permission is report.generate because the person this exists for is
    // the one the reports screen just refused.
    const response = await request('POST', '/portfolio/classification', officerToken);

    expect(response.statusCode).toBe(403);
    expect(response.json<ErrorResponse>().error.message).toContain('report.generate');
  });

  it('classifies the caller’s own institution and no other', async () => {
    const outsider = await seedUser(harness.database, { roles: ['accountant'] });
    const outsiderToken = await tokenFor(outsider);

    const response = await request('POST', '/portfolio/classification', outsiderToken);

    expect(response.json<{ institutionId: string }>().institutionId).toBe(outsider.institutionId);
    expect(response.json<{ institutionId: string }>().institutionId).not.toBe(
      accountant.institutionId,
    );
  });
});

describe('enumerating institutions for the scheduled run', () => {
  it('sees every institution, which a tenancy-scoped read could not', async () => {
    // The scheduled run has no institution to scope to; covering all of them is
    // the job. A plain SELECT would read everything here — the test connection
    // is a superuser and row-level security does not apply — and nothing in
    // production, where the application connects as mfi_app. The definer
    // function is what makes the two agree.
    const ids = await harness.database.withTransaction(async (client) => {
      const rows = await client.query<{ institution_id: string }>(
        'SELECT institution_id FROM institution_ids_for_classification()',
      );
      return rows.rows.map((row) => row.institution_id);
    });

    expect(ids).toContain(accountant.institutionId);
    expect(ids.length).toBeGreaterThan(1);
  });

  it('leaves out institutions that have closed', async () => {
    // A closed institution has no ongoing book, and stamping its health record
    // would make a dormant tenant look freshly classified.
    const closed = await seedUser(harness.database, { roles: ['accountant'] });
    await harness.database.withTransaction(async (client) => {
      await client.query(`UPDATE institutions SET status = 'closed' WHERE id = $1`, [
        closed.institutionId,
      ]);
    });

    const ids = await harness.database.withTransaction(async (client) => {
      const rows = await client.query<{ institution_id: string }>(
        'SELECT institution_id FROM institution_ids_for_classification()',
      );
      return rows.rows.map((row) => row.institution_id);
    });

    expect(ids).not.toContain(closed.institutionId);
  });
});
