import { PhoneNumber, ageBandAt } from '@mfi/domain';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Database } from '../src/database.js';
import { testDatabaseUrl } from './global-setup.js';

/**
 * Clients and guarantors.
 *
 * Most of what is asserted here is a constraint the previous schema enforced in
 * the browser only: the phone format, the sector taxonomy, the district. Those
 * feed MSP2 returns, and a value that only the interface checks is a value a
 * direct API call can set to anything — which then aggregates into a regulatory
 * filing that nothing rejects.
 */

const INSTITUTION_A = 'aaaa0000-0000-7000-8000-000000000001';
const INSTITUTION_B = 'bbbb0000-0000-7000-8000-000000000002';

let pool: pg.Pool;
let db: Database;
let branchA: string;
let branchB: string;
let districtCode: string;
let sectorCode: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
  db = new Database(pool);

  const reference = await pool.query<{ district: string; sector: string }>(
    `SELECT (SELECT code FROM reference.districts ORDER BY sort_order LIMIT 1) AS district,
            (SELECT code FROM reference.sectors ORDER BY sno LIMIT 1) AS sector`,
  );
  districtCode = reference.rows[0]?.district ?? '';
  sectorCode = reference.rows[0]?.sector ?? '';
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  const owned = [INSTITUTION_A, INSTITUTION_B];

  await db.withTransaction(async (client) => {
    for (const table of ['guarantors', 'clients', 'code_sequences', 'branches']) {
      await client.query(`DELETE FROM ${table} WHERE institution_id = ANY($1::uuid[])`, [owned]);
    }
    await client.query('DELETE FROM institutions WHERE id = ANY($1::uuid[])', [owned]);

    // Cleared last, and after the deletes above: tearing down the fixture is
    // itself an audited change, so clearing the log first would leave the
    // teardown's own entries behind for the next test to trip over.
    await client.query('DELETE FROM audit_logs WHERE institution_id = ANY($1::uuid[])', [owned]);

    await client.query('INSERT INTO institutions (id, name) VALUES ($1, $2), ($3, $4)', [
      INSTITUTION_A,
      'Client Institution A',
      INSTITUTION_B,
      'Client Institution B',
    ]);

    const branches = await client.query<{ id: string; institution_id: string }>(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'HQ', 'A HQ', true), ($2, 'HQ', 'B HQ', true)
       RETURNING id, institution_id`,
      [INSTITUTION_A, INSTITUTION_B],
    );
    branchA = branches.rows.find((row) => row.institution_id === INSTITUTION_A)?.id ?? '';
    branchB = branches.rows.find((row) => row.institution_id === INSTITUTION_B)?.id ?? '';
  });
});

interface ClientOverrides {
  institutionId?: string;
  branchId?: string;
  fullName?: string;
  gender?: string;
  dateOfBirth?: string;
  phone?: string;
  districtCode?: string;
  sectorCode?: string;
}

/** Insert a client through the tenant path, returning its generated code. */
async function insertClient(overrides: ClientOverrides = {}): Promise<string> {
  const institutionId = overrides.institutionId ?? INSTITUTION_A;

  return db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
    const result = await client.query<{ client_code: string }>(
      `INSERT INTO clients
         (institution_id, branch_id, full_name, gender, date_of_birth, phone, district_code, sector_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING client_code`,
      [
        institutionId,
        overrides.branchId ?? branchA,
        overrides.fullName ?? 'Grace Mwakasege',
        overrides.gender ?? 'female',
        overrides.dateOfBirth ?? '1990-06-01',
        overrides.phone ?? PhoneNumber.parse('0712345678').toDatabaseValue(),
        overrides.districtCode ?? districtCode,
        overrides.sectorCode ?? sectorCode,
      ],
    );
    return result.rows[0]?.client_code ?? '';
  });
}

describe('client codes', () => {
  it('allocates a readable code automatically', async () => {
    const code = await insertClient();

    expect(code).toMatch(/^MFI-\d{4}-\d{3}$/);
  });

  it('increments within the institution', async () => {
    const first = await insertClient({ fullName: 'First Client' });
    const second = await insertClient({ fullName: 'Second Client' });

    expect(first).not.toBe(second);
    expect(Number(second.split('-')[2])).toBe(Number(first.split('-')[2]) + 1);
  });

  it('never issues the same code twice under concurrency', async () => {
    // The race the previous schema had: deriving the next number by parsing
    // MAX(client_code) lets two simultaneous registrations compute the same
    // value. A busy branch morning is exactly when that happens.
    const codes = await Promise.all(
      Array.from({ length: 20 }, (_unused, index) =>
        insertClient({ fullName: `Concurrent Client ${String(index)}` }),
      ),
    );

    expect(new Set(codes).size).toBe(20);
  });
});

describe('phone numbers are enforced by the database', () => {
  it('accepts a normalised E.164 number', async () => {
    await expect(
      insertClient({ phone: PhoneNumber.parse('0654321098').toDatabaseValue() }),
    ).resolves.toMatch(/^MFI-/);
  });

  it.each([
    ['local form', '0712345678'],
    ['no country code', '712345678'],
    ['another country', '+254712345678'],
    ['a landline', '+255222123456'],
    ['too short', '+25571234567'],
    ['free text', 'call the shop'],
  ])('refuses a %s number at the database, not only in the browser', async (_label, phone) => {
    // The previous system validated in the browser alone, so a direct API call
    // could store anything. Two spellings of one number are two clients, two
    // client codes, and two loan histories that no report reconciles.
    await expect(insertClient({ phone })).rejects.toThrow(/clients_phone_check|violates check/i);
  });
});

describe('BOT taxonomies are enforced by the database', () => {
  it('refuses a sector outside BOT’s list', async () => {
    await expect(insertClient({ sectorCode: 'crypto_mining' })).rejects.toThrow(
      /foreign key|sector/i,
    );
  });

  it('refuses a district outside Tanzania’s administrative hierarchy', async () => {
    await expect(insertClient({ districtCode: 'atlantis' })).rejects.toThrow(
      /foreign key|district/i,
    );
  });

  it.each(['other', 'unknown', ''])(
    'refuses gender %j, which no column can hold',
    async (gender) => {
      await expect(insertClient({ gender })).rejects.toThrow(
        /clients_gender_check|violates check/i,
      );
    },
  );

  it.each(['male', 'female'])('accepts %s', async (gender) => {
    await expect(insertClient({ gender, fullName: `Client ${gender}` })).resolves.toMatch(/^MFI-/);
  });
});

describe('date of birth', () => {
  it('refuses a future date', async () => {
    await expect(insertClient({ dateOfBirth: '2999-01-01' })).rejects.toThrow(
      /date_of_birth_plausible|violates check/i,
    );
  });

  it('refuses an implausibly distant past, which is nearly always a typed year', async () => {
    await expect(insertClient({ dateOfBirth: '1823-01-01' })).rejects.toThrow(
      /date_of_birth_plausible|violates check/i,
    );
  });

  it('supports the MSP2-10 age band derivation', async () => {
    await insertClient({ dateOfBirth: '1990-06-01', fullName: 'Age Band Client' });

    const stored = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        const result = await client.query<{ date_of_birth: Date }>(
          `SELECT date_of_birth FROM clients WHERE full_name = 'Age Band Client'`,
        );
        return result.rows[0]?.date_of_birth;
      },
    );

    expect(stored).toBeDefined();
    expect(ageBandAt(stored!, new Date('2026-12-31T00:00:00.000Z'))).toBe('above_35');
  });
});

describe('referential tenancy', () => {
  it('refuses a client in another institution’s branch', async () => {
    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO clients
             (institution_id, branch_id, full_name, gender, date_of_birth, phone, district_code, sector_code)
           VALUES ($1, $2, 'Misplaced', 'male', '1990-01-01', '+255712345678', $3, $4)`,
          [INSTITUTION_A, branchB, districtCode, sectorCode],
        );
      }),
    ).rejects.toThrow(/clients_branch_within_institution|foreign key/i);
  });

  it('refuses a guarantor attached to another institution’s client', async () => {
    await insertClient({ fullName: 'Guaranteed Client' });
    const clientId = await db.withTransaction(async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM clients WHERE full_name = 'Guaranteed Client'`,
      );
      return result.rows[0]?.id ?? '';
    });

    await expect(
      db.withTransaction(async (client) => {
        await client.query(
          `INSERT INTO guarantors (institution_id, client_id, full_name, relationship, phone)
           VALUES ($1, $2, 'Wrong Tenant', 'brother', '+255712345678')`,
          [INSTITUTION_B, clientId],
        );
      }),
    ).rejects.toThrow(/guarantors_client_within_institution|foreign key/i);
  });
});

describe('tenant isolation', () => {
  it('hides clients from other institutions', async () => {
    await insertClient({ fullName: 'Private Client' });

    const visible = await db.withTenantTransaction(
      { institutionId: INSTITUTION_B },
      async (client) => {
        const result = await client.query<{ id: string }>('SELECT id FROM clients');
        return result.rows;
      },
    );

    expect(visible).toEqual([]);
  });

  it('refuses a client tagged to another institution', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO clients
             (institution_id, branch_id, full_name, gender, date_of_birth, phone, district_code, sector_code)
           VALUES ($1, $2, 'Cross Tenant', 'male', '1990-01-01', '+255712345678', $3, $4)`,
          [INSTITUTION_B, branchB, districtCode, sectorCode],
        );
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it('offers no DELETE, since loan history will reference the client', async () => {
    await insertClient({ fullName: 'Undeletable Client' });

    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(`DELETE FROM clients WHERE full_name = 'Undeletable Client'`);
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('deactivates instead of deleting', async () => {
    await insertClient({ fullName: 'Deactivated Client' });

    const status = await db.withTenantTransaction(
      { institutionId: INSTITUTION_A },
      async (client) => {
        await client.query(
          `UPDATE clients SET status = 'inactive' WHERE full_name = 'Deactivated Client'`,
        );
        const result = await client.query<{ status: string }>(
          `SELECT status FROM clients WHERE full_name = 'Deactivated Client'`,
        );
        return result.rows[0]?.status;
      },
    );

    expect(status).toBe('inactive');
  });
});

describe('auditing', () => {
  it('records client registration', async () => {
    await insertClient({ fullName: 'Audited Client' });

    const entries = await pool.query<{ operation: string; after_data: Record<string, unknown> }>(
      `SELECT operation, after_data FROM audit_logs
        WHERE institution_id = $1 AND table_name = 'clients'`,
      [INSTITUTION_A],
    );

    expect(entries.rows).toHaveLength(1);
    expect(entries.rows[0]?.operation).toBe('INSERT');
    expect(entries.rows[0]?.after_data).toMatchObject({ full_name: 'Audited Client' });
  });

  it('records a guarantor being added', async () => {
    await insertClient({ fullName: 'Client With Guarantor' });

    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      await client.query(
        `INSERT INTO guarantors (institution_id, client_id, full_name, relationship, phone)
         SELECT $1, id, 'Standing Guarantor', 'sister', '+255787654321'
           FROM clients WHERE full_name = 'Client With Guarantor'`,
        [INSTITUTION_A],
      );
    });

    const entries = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM audit_logs
        WHERE institution_id = $1 AND table_name = 'guarantors'`,
      [INSTITUTION_A],
    );

    expect(entries.rows[0]?.count).toBe('1');
  });
});

describe('guarantors', () => {
  const addGuarantor = async (declaredValue: string | null): Promise<void> => {
    await db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
      await client.query(
        `INSERT INTO guarantors (institution_id, client_id, full_name, relationship, phone, declared_value)
         SELECT $1, id, 'A Guarantor', 'neighbour', '+255787654321', $2
           FROM clients WHERE full_name = 'Guarantor Subject'`,
        [INSTITUTION_A, declaredValue],
      );
    });
  };

  beforeEach(async () => {
    await insertClient({ fullName: 'Guarantor Subject' });
  });

  it('records a guarantee with a declared value', async () => {
    await expect(addGuarantor('5000000.00')).resolves.toBeUndefined();
  });

  it('permits an undeclared value, since declaring one is not always required', async () => {
    await expect(addGuarantor(null)).resolves.toBeUndefined();
  });

  it('refuses a negative declared value', async () => {
    await expect(addGuarantor('-1.00')).rejects.toThrow(/declared_value|violates check/i);
  });

  it('enforces the phone format on guarantors too', async () => {
    await expect(
      db.withTenantTransaction({ institutionId: INSTITUTION_A }, async (client) => {
        await client.query(
          `INSERT INTO guarantors (institution_id, client_id, full_name, relationship, phone)
           SELECT $1, id, 'Bad Phone', 'cousin', '0712345678'
             FROM clients WHERE full_name = 'Guarantor Subject'`,
          [INSTITUTION_A],
        );
      }),
    ).rejects.toThrow(/guarantors_phone_check|violates check/i);
  });
});
