import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Asserts the driver behaviour every monetary value in this system depends on.
 *
 * `@mfi/money` refuses to construct an amount from a JavaScript number, because
 * a double cannot hold most decimal fractions exactly. That guarantee only
 * holds end to end if the database driver hands `NUMERIC` back as a **string**.
 * node-postgres does so by default — but a single `pg.types.setTypeParser(1700,
 * parseFloat)` anywhere in the process would silently turn every balance in the
 * institution's loan book into a float, with no error and no obvious symptom
 * until figures stopped reconciling.
 *
 * These tests are the tripwire. They live here rather than in `@mfi/money`
 * because that package is a leaf and may not import a database driver; this is
 * the closest place to the wire that can hold a live connection.
 */
const CONNECTION_STRING =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres@localhost:5432/postgres';

/** Postgres OID for NUMERIC/DECIMAL. */
const NUMERIC_OID = 1700;

/**
 * The registered NUMERIC parser, typed to return `unknown`.
 *
 * `pg.types.getTypeParser` is declared as returning `any`, which would let
 * every assertion about the parser's return type pass vacuously. Narrowing it
 * to `unknown` forces `typeof` checks to mean something.
 */
type NumericParser = (value: string) => unknown;

const numericParser = (): NumericParser => {
  const parser: unknown = pg.types.getTypeParser(NUMERIC_OID);
  if (typeof parser !== 'function') {
    throw new TypeError(`pg returned no type parser for OID ${String(NUMERIC_OID)}.`);
  }
  return parser as NumericParser;
};

const parseNumeric = (value: string): unknown => numericParser()(value);

let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: CONNECTION_STRING });
});

afterAll(async () => {
  await pool.end();
});

describe('NUMERIC is returned as a string', () => {
  it('returns a plain NUMERIC as a string, not a number', async () => {
    const result = await pool.query<{ value: unknown }>("SELECT '1234.56'::NUMERIC(15,2) AS value");

    expect(typeof result.rows[0]?.value).toBe('string');
    expect(result.rows[0]?.value).toBe('1234.56');
  });

  it('preserves a value a double could not represent', async () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004.
    const result = await pool.query<{ value: unknown }>(
      "SELECT ('0.1'::NUMERIC + '0.2'::NUMERIC) AS value",
    );

    expect(result.rows[0]?.value).toBe('0.3');
  });

  it('preserves the largest value NUMERIC(15,2) can store', async () => {
    const result = await pool.query<{ value: unknown }>(
      "SELECT '9999999999999.99'::NUMERIC(15,2) AS value",
    );

    // As a double this is 9999999999999.99 → 9999999999999.99, but the nearest
    // double to it is not exact, and larger books would lose shillings.
    expect(result.rows[0]?.value).toBe('9999999999999.99');
  });

  it('preserves scale, so 100 comes back as 100.00', async () => {
    const result = await pool.query<{ value: unknown }>("SELECT '100'::NUMERIC(15,2) AS value");

    expect(result.rows[0]?.value).toBe('100.00');
  });

  it('returns aggregate results as strings too', async () => {
    const result = await pool.query<{ total: unknown }>(
      `SELECT SUM(amount)::NUMERIC(15,2) AS total
         FROM (VALUES ('0.01'::NUMERIC), ('0.02'), ('0.03')) AS t(amount)`,
    );

    expect(typeof result.rows[0]?.total).toBe('string');
    expect(result.rows[0]?.total).toBe('0.06');
  });

  it('has no custom parser registered for NUMERIC', () => {
    // getTypeParser returns the built-in parser unless overridden. Feeding it a
    // known string must give the same string back; a parseFloat override would
    // return a number.
    expect(typeof parseNumeric('1234.56')).toBe('string');
    expect(parseNumeric('1234.56')).toBe('1234.56');
  });
});

describe('the tripwire itself', () => {
  it('detects a driver misconfigured to parse NUMERIC as a float', () => {
    // Proves the assertions above can actually fail. Without this, a broken
    // check would be indistinguishable from a healthy driver.
    const original = numericParser();
    try {
      pg.types.setTypeParser(NUMERIC_OID, Number.parseFloat);

      expect(typeof parseNumeric('1234.56')).toBe('number');
    } finally {
      pg.types.setTypeParser(NUMERIC_OID, original);
    }

    // Restored, so the rest of the suite sees a healthy driver.
    expect(typeof parseNumeric('1234.56')).toBe('string');
  });
});
