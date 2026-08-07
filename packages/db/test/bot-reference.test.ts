import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { testDatabaseUrl } from './global-setup.js';

/**
 * The seeded BOT reference data, checked against the specification.
 *
 * Every expected value here traces to `02-BOT-REPORTING-SPEC.md`, which was
 * read from BOT's own template rather than from anyone's recollection of it.
 * The data reaches the database through a generator, so these tests are what
 * confirm the generator did not quietly drop, duplicate, or mangle a row on the
 * way — a missing sector or a mistyped provision rate produces a wrong
 * regulatory filing, not an error.
 */

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: testDatabaseUrl() });
});

afterAll(async () => {
  await pool.end();
});

const scalar = async <T>(sql: string, values: unknown[] = []): Promise<T | undefined> => {
  const result = await pool.query<Record<string, T>>(sql, values);
  const row = result.rows[0];
  return row === undefined ? undefined : Object.values(row)[0];
};

describe('sectors (MSP2-03, MSP2-09)', () => {
  it('seeds exactly the 22 BOT sectors', async () => {
    expect(await scalar<string>('SELECT COUNT(*)::text FROM reference.sectors')).toBe('22');
  });

  it('preserves BOT’s order and wording', async () => {
    const result = await pool.query<{ name: string }>(
      'SELECT name FROM reference.sectors ORDER BY sno',
    );

    expect(result.rows.map((row) => row.name)).toEqual([
      'Agriculture',
      'Fishing',
      'Forest',
      'Hunting',
      'Financial Intermediaries',
      'Mining and Quarrying',
      'Manufacturing',
      'Building and Construction',
      'Real Estate',
      'Leasing',
      'Transport and Communication',
      'Trade',
      'Tourism',
      'Hotels and Restaurants',
      'Warehousing and Storage',
      'Electricity',
      'Gas',
      'Water',
      'Education',
      'Health',
      'Other Services',
      'Personal (Private)',
    ]);
  });
});

describe('loan types (MSP2-04)', () => {
  it('seeds 12 reportable types plus the two salaried sub-rows', async () => {
    expect(await scalar<string>('SELECT COUNT(*)::text FROM reference.loan_types')).toBe('14');
    expect(
      await scalar<string>(
        'SELECT COUNT(*)::text FROM reference.loan_types WHERE parent_code IS NULL',
      ),
    ).toBe('12');
  });

  it('rolls the salaried sub-rows up to their parent', async () => {
    const result = await pool.query<{ name: string; parent_code: string }>(
      'SELECT name, parent_code FROM reference.loan_types WHERE parent_code IS NOT NULL ORDER BY sno',
    );

    expect(result.rows.map((row) => row.name)).toEqual([
      'Government Employees',
      'Non-Government Employees',
    ]);
    expect(new Set(result.rows.map((row) => row.parent_code))).toEqual(new Set(['salaried_loans']));
  });

  it('flags housing microfinance for the separate provisioning schedule', async () => {
    // The consequence: a housing loan 100 days overdue provisions at 25%,
    // where any other loan at 100 days provisions at 100%.
    const result = await pool.query<{ name: string; provisioning_schedule: string }>(
      `SELECT name, provisioning_schedule FROM reference.loan_types
        WHERE provisioning_schedule <> 'standard'`,
    );

    expect(result.rows).toEqual([
      { name: 'Housing Microfinance Loans', provisioning_schedule: 'housing' },
    ]);
  });
});

describe('provisioning schedules (MSP2-03 §4.1)', () => {
  it('seeds the five standard bands at BOT’s rates', async () => {
    const result = await pool.query<{
      classification: string;
      min_days_overdue: number;
      max_days_overdue: number | null;
      provision_rate: string;
    }>(
      `SELECT classification, min_days_overdue, max_days_overdue, provision_rate
         FROM reference.provisioning_bands
        WHERE schedule_code = 'standard'
        ORDER BY min_days_overdue`,
    );

    expect(result.rows).toEqual([
      {
        classification: 'current',
        min_days_overdue: 0,
        max_days_overdue: 5,
        provision_rate: '0.0100',
      },
      {
        classification: 'esm',
        min_days_overdue: 6,
        max_days_overdue: 30,
        provision_rate: '0.0500',
      },
      {
        classification: 'substandard',
        min_days_overdue: 31,
        max_days_overdue: 60,
        provision_rate: '0.2500',
      },
      {
        classification: 'doubtful',
        min_days_overdue: 61,
        max_days_overdue: 90,
        provision_rate: '0.5000',
      },
      {
        classification: 'loss',
        min_days_overdue: 91,
        max_days_overdue: null,
        provision_rate: '1.0000',
      },
    ]);
  });

  it('seeds the three housing bands at BOT’s longer windows', async () => {
    const result = await pool.query<{
      classification: string;
      min_days_overdue: number;
      max_days_overdue: number | null;
      provision_rate: string;
    }>(
      `SELECT classification, min_days_overdue, max_days_overdue, provision_rate
         FROM reference.provisioning_bands
        WHERE schedule_code = 'housing'
        ORDER BY min_days_overdue`,
    );

    expect(result.rows).toEqual([
      {
        classification: 'substandard',
        min_days_overdue: 91,
        max_days_overdue: 180,
        provision_rate: '0.2500',
      },
      {
        classification: 'doubtful',
        min_days_overdue: 181,
        max_days_overdue: 360,
        provision_rate: '0.5000',
      },
      {
        classification: 'loss',
        min_days_overdue: 361,
        max_days_overdue: null,
        provision_rate: '1.0000',
      },
    ]);
  });

  it('leaves no gap or overlap between standard bands', async () => {
    const result = await pool.query<{ min_days_overdue: number; max_days_overdue: number | null }>(
      `SELECT min_days_overdue, max_days_overdue FROM reference.provisioning_bands
        WHERE schedule_code = 'standard' ORDER BY min_days_overdue`,
    );

    let expectedNext = 0;
    for (const band of result.rows) {
      expect(band.min_days_overdue).toBe(expectedNext);
      if (band.max_days_overdue !== null) {
        expectedNext = band.max_days_overdue + 1;
      }
    }
    expect(result.rows.at(-1)?.max_days_overdue).toBeNull();
  });

  it('records that the housing schedule starts at 91 days, leaving 0–90 undefined', async () => {
    // Not an assertion that this is correct — an assertion that the gap is real
    // and visible. BOT's template states only three housing bands and says
    // nothing about a housing loan under 91 days overdue. Recorded as an open
    // question in 02-BOT-REPORTING-SPEC.md §11.5; the provisioning engine in a
    // later stage cannot be written without the answer.
    const earliest = await scalar<number>(
      `SELECT MIN(min_days_overdue) FROM reference.provisioning_bands WHERE schedule_code = 'housing'`,
    );

    expect(earliest).toBe(91);
  });

  it('keeps rates within a valid proportion', async () => {
    expect(
      await scalar<string>(
        `SELECT COUNT(*)::text FROM reference.provisioning_bands
          WHERE provision_rate < 0 OR provision_rate > 1`,
      ),
    ).toBe('0');
  });
});

describe('geography (MSP2-10)', () => {
  it('seeds 31 regions and 193 districts', async () => {
    expect(await scalar<string>('SELECT COUNT(*)::text FROM reference.regions')).toBe('31');
    expect(await scalar<string>('SELECT COUNT(*)::text FROM reference.districts')).toBe('193');
  });

  it('splits mainland from Zanzibar, as MSP2-10 subtotals them separately', async () => {
    const result = await pool.query<{ area: string; count: string }>(
      'SELECT area, COUNT(*)::text AS count FROM reference.regions GROUP BY area ORDER BY area',
    );

    expect(result.rows).toEqual([
      { area: 'mainland', count: '26' },
      { area: 'zanzibar', count: '5' },
    ]);
  });

  it('parses council-type suffixes where BOT uses them', async () => {
    const result = await pool.query<{ name: string; council_type: string | null }>(
      `SELECT name, council_type FROM reference.districts
        WHERE name IN ('Arusha CC', 'Ilala MC', 'Karatu', 'Kondoa TC', 'Bahi DC')
        ORDER BY name`,
    );

    expect(result.rows).toEqual([
      { name: 'Arusha CC', council_type: 'CC' },
      { name: 'Bahi DC', council_type: 'DC' },
      { name: 'Ilala MC', council_type: 'MC' },
      { name: 'Karatu', council_type: null },
      { name: 'Kondoa TC', council_type: 'TC' },
    ]);
  });

  it('gives every district a region', async () => {
    expect(
      await scalar<string>(
        `SELECT COUNT(*)::text FROM reference.districts d
          LEFT JOIN reference.regions r ON r.code = d.region_code
         WHERE r.code IS NULL`,
      ),
    ).toBe('0');
  });

  it('keeps district codes unique even where names repeat across regions', async () => {
    // "Kaskazini A" and similar names occur in more than one region, so codes
    // are qualified by region. Without that, a district would silently
    // overwrite its namesake and its loans would report under the wrong region.
    const duplicateNames = await scalar<string>(
      `SELECT COUNT(*)::text FROM (
         SELECT name FROM reference.districts GROUP BY name HAVING COUNT(*) > 1
       ) AS repeated`,
    );

    expect(Number(duplicateNames)).toBeGreaterThan(0);
    expect(await scalar<string>('SELECT COUNT(DISTINCT code)::text FROM reference.districts')).toBe(
      '193',
    );
  });
});

describe('financial institutions (MSP2-07, MSP2-08)', () => {
  it('seeds banks and the six mobile network operators', async () => {
    const result = await pool.query<{ kind: string; count: string }>(
      `SELECT kind, COUNT(*)::text AS count FROM reference.financial_institutions
       GROUP BY kind ORDER BY kind`,
    );

    expect(result.rows).toEqual([
      { kind: 'bank', count: '55' },
      { kind: 'mno', count: '6' },
    ]);
  });

  it('names the mobile network operators BOT lists', async () => {
    const result = await pool.query<{ name: string }>(
      `SELECT name FROM reference.financial_institutions WHERE kind = 'mno' ORDER BY sort_order`,
    );

    expect(result.rows.map((row) => row.name)).toEqual([
      'MPESA',
      'AIRTEL MONEY',
      'T-PESA',
      'HALOPESA',
      'TIGOPESA',
      'ZPESA',
    ]);
  });

  it('tracks BOT’s two overlapping lists separately', async () => {
    // MSP2-07's deposits list and MSP2-08's agent-banking list differ; an
    // institution can appear on one, the other, or both.
    const deposits = await scalar<string>(
      'SELECT COUNT(*)::text FROM reference.financial_institutions WHERE in_deposits_list',
    );
    const agent = await scalar<string>(
      'SELECT COUNT(*)::text FROM reference.financial_institutions WHERE in_agent_banking_list',
    );

    expect(deposits).toBe('61');
    expect(agent).toBe('51');
  });

  it('excludes BOT’s NIL placeholder row', async () => {
    // "NIL" heads both dropdown lists meaning "none selected". Seeded as an
    // institution it would become a selectable counterparty and flow into
    // MSP2-07 as a real bank.
    expect(
      await scalar<string>(
        `SELECT COUNT(*)::text FROM reference.financial_institutions WHERE upper(name) = 'NIL'`,
      ),
    ).toBe('0');
  });
});

describe('financial statement lines (MSP2-01, MSP2-02)', () => {
  it('seeds all 61 balance sheet and 42 income statement lines', async () => {
    const result = await pool.query<{ form_code: string; count: string }>(
      'SELECT form_code, COUNT(*)::text AS count FROM reference.form_lines GROUP BY form_code ORDER BY form_code',
    );

    expect(result.rows).toEqual([
      { form_code: 'MSP2-01', count: '61' },
      { form_code: 'MSP2-02', count: '42' },
    ]);
  });

  it('marks computed lines as derived rather than entered', async () => {
    // Sno 33 is Total Assets, which BOT's template computes. A line the
    // template derives must never be an input in this system either, or the
    // balance sheet could be filed not balancing.
    const totalAssets = await pool.query<{ label: string; is_computed: boolean }>(
      `SELECT label, is_computed FROM reference.form_lines WHERE form_code = 'MSP2-01' AND sno = 33`,
    );

    expect(totalAssets.rows[0]?.label).toContain('TOTAL ASSETS');
    expect(totalAssets.rows[0]?.is_computed).toBe(true);
  });

  it('retains BOT’s own formula for each computed line', async () => {
    // Kept so a future template revision can be diffed against what this
    // system implements, rather than re-derived by reading the sheet again.
    const formula = await scalar<string>(
      `SELECT formula FROM reference.form_lines WHERE form_code = 'MSP2-01' AND sno = 33`,
    );

    expect(formula).toBe('=C14+C21+C27+C30+C36+C39');
  });

  it('keeps Sno unique within a form, since validation rules address cells by it', async () => {
    expect(
      await scalar<string>(
        `SELECT COUNT(*)::text FROM (
           SELECT form_code, sno FROM reference.form_lines GROUP BY form_code, sno HAVING COUNT(*) > 1
         ) AS duplicated`,
      ),
    ).toBe('0');
  });
});

describe('cross-form validation rules', () => {
  it('seeds all 18 rules', async () => {
    expect(await scalar<string>('SELECT COUNT(*)::text FROM reference.validation_rules')).toBe(
      '18',
    );
  });

  it('includes the balance sheet identity', async () => {
    const rule = await scalar<string>(
      `SELECT rule FROM reference.validation_rules
        WHERE form_code = 'MSP2-01' AND rule LIKE '%Total Assets%'`,
    );

    expect(rule).toBe('Sno33 (Total Assets) = Sno61 (Total Liabilities and Capital)');
  });
});

describe('reference data is read-only to the application', () => {
  it('grants SELECT on every reference table', async () => {
    const result = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'reference'`,
    );
    expect(result.rows.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const { table_name } of result.rows) {
      const granted = await scalar<boolean>(`SELECT has_table_privilege('mfi_app', $1, 'SELECT')`, [
        `reference.${table_name}`,
      ]);
      if (granted !== true) {
        offenders.push(table_name);
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE'])(
    'withholds %s on every reference table',
    async (privilege) => {
      // Reference data is BOT's, not the institution's. It changes when BOT
      // revises a template, through a reviewed migration — never at runtime.
      const result = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'reference'`,
      );

      const offenders: string[] = [];
      for (const { table_name } of result.rows) {
        const granted = await scalar<boolean>(`SELECT has_table_privilege('mfi_app', $1, $2)`, [
          `reference.${table_name}`,
          privilege,
        ]);
        if (granted === true) {
          offenders.push(table_name);
        }
      }

      expect(offenders).toEqual([]);
    },
  );

  it('holds no institution-scoped column, confirming it is not tenant storage', async () => {
    // The reason this data sits outside `public`: tenant-isolation invariants
    // apply to everything in that schema, and reference data legitimately has
    // no row-level security. Separating by schema makes "is this tenant data?"
    // answerable structurally instead of by a list someone has to maintain.
    expect(
      await scalar<string>(
        `SELECT COUNT(*)::text FROM information_schema.columns
          WHERE table_schema = 'reference' AND column_name = 'institution_id'`,
      ),
    ).toBe('0');
  });
});
