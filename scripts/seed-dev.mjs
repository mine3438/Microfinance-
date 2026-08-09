#!/usr/bin/env node
/**
 * Development seed. Never for production, and it refuses to be.
 *
 * Everything here is invented: the institution, its staff, its products, its
 * borrowers, and — the reason this script exists — its approval thresholds.
 *
 * Those thresholds are the only part that matters architecturally. They are
 * seeded empty by migration `0009_loans.sql`, deliberately: the figures belong
 * to the institution, `01-ARCHITECTURE.md` §13.3 asks for them and has no
 * answer, and an absent limit means *no* authority rather than unlimited. That
 * means a fresh database cannot approve any loan at all, which is correct and
 * also makes the application impossible to walk through.
 *
 * So the figures live here, in a script that runs by hand against a throwaway
 * database, rather than in a migration that would carry an invented lending
 * policy into every deployment.
 *
 * Run: `pnpm seed:dev`
 */
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import { hashPassword } from '@mfi/identity';
import pg from 'pg';

const DEMO_PASSWORD = 'correct horse battery staple';

/**
 * Invented for development. Not advice, not a policy, not a default.
 *
 * A branch manager sanctions up to five million shillings; an administrator up
 * to fifty. The shape is the point — a ladder, with the maker below the checker
 * — not the numbers.
 */
const DEVELOPMENT_APPROVAL_THRESHOLDS = [
  ['branch_manager', '5000000.00'],
  ['institution_admin', '50000000.00'],
];

const STAFF = [
  ['amina@faraja.co.tz', 'Amina Hassan', 'loan_officer', 'branch'],
  ['juma@faraja.co.tz', 'Juma Mwangosi', 'branch_manager', 'branch'],
  ['neema@faraja.co.tz', 'Neema Shirima', 'institution_admin', 'institution'],
  ['fatuma@faraja.co.tz', 'Fatuma Ally', 'accountant', 'institution'],
];

const BORROWERS = [
  ['Zawadi Mushi', 'female', '1991-04-17', '+255712345678'],
  ['Joseph Mollel', 'male', '1979-11-30', '+255713111222'],
  ['Rehema Kileo', 'female', '1986-02-08', '+255714333444'],
  ['Baraka Nyerere', 'male', '1994-07-22', '+255715555666'],
];

function refuseOutsideDevelopment() {
  const environment = process.env.NODE_ENV ?? 'development';

  if (environment === 'production') {
    throw new Error(
      'seed-dev refuses to run with NODE_ENV=production. It writes invented staff, ' +
        'invented borrowers and invented approval limits.',
    );
  }

  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL is required.');
  }

  // A crude but effective guard: a database whose name does not announce itself
  // as local is not one this script should be pointed at by accident.
  const name = new URL(url).pathname.replace(/^\//, '');
  const looksLocal = /(dev|local|demo|test|scratch|postgres)/i.test(name);
  if (!looksLocal && process.env.SEED_DEV_FORCE !== 'true') {
    throw new Error(
      `Refusing to seed "${name}": the name does not look like a development database. ` +
        'Set SEED_DEV_FORCE=true if you are certain.',
    );
  }

  return url;
}

async function main() {
  const connectionString = refuseOutsideDevelopment();
  const pool = new pg.Pool({ connectionString });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reference = await client.query(
      `SELECT
         (SELECT code FROM reference.districts ORDER BY code LIMIT 1) AS district,
         (SELECT code FROM reference.sectors   ORDER BY code LIMIT 1) AS sector,
         (SELECT code FROM reference.loan_types ORDER BY code LIMIT 1) AS loan_type`,
    );
    const { district, sector, loan_type: loanType } = reference.rows[0] ?? {};
    if (!district || !sector || !loanType) {
      throw new Error('BOT reference data is missing. Run `pnpm db:migrate` first.');
    }

    const suffix = randomUUID().slice(0, 6);
    const institution = await client.query(
      `INSERT INTO institutions (name, msp_code, status)
       VALUES ($1, $2, 'active') RETURNING id`,
      [`Faraja Microfinance (dev ${suffix})`, `MSP-DEV-${suffix.toUpperCase()}`],
    );
    const institutionId = institution.rows[0].id;

    const branches = await client.query(
      `INSERT INTO branches (institution_id, code, name, is_head_office)
       VALUES ($1, 'KRK', 'Kariakoo Head Office', true),
              ($1, 'MWZ', 'Mwanza Branch', false)
       RETURNING id, code`,
      [institutionId],
    );
    const headOffice = branches.rows.find((row) => row.code === 'KRK').id;

    const passwordHash = await hashPassword(DEMO_PASSWORD);

    for (const [email, fullName, role, scope] of STAFF) {
      const user = await client.query(
        `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash,
                            status, email_verified_at)
         VALUES ($1, $2, $3, $4, $5, 'active', now()) RETURNING id`,
        [institutionId, scope === 'branch' ? headOffice : null, email, fullName, passwordHash],
      );
      await client.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, user.rows[0].id, role],
      );
    }

    // The reason this script exists. See the header.
    for (const [role, limit] of DEVELOPMENT_APPROVAL_THRESHOLDS) {
      await client.query(
        `INSERT INTO approval_thresholds (institution_id, role_code, max_principal)
         VALUES ($1, $2, $3)`,
        [institutionId, role, limit],
      );
    }

    await client.query(
      `INSERT INTO loan_products
         (institution_id, code, name, bot_loan_type, interest_method,
          min_monthly_rate, max_monthly_rate, min_term_months, max_term_months,
          min_principal, max_principal)
       VALUES
         ($1, 'BIZ', 'Business Loan', $2, 'reducing_balance',
          0.0200, 0.0500, 3, 24, 200000.00, 10000000.00),
         ($1, 'SAL', 'Salary Advance', $2, 'flat',
          0.0300, 0.0600, 1, 12, 100000.00, 3000000.00)`,
      [institutionId, loanType],
    );

    for (const [fullName, gender, dateOfBirth, phone] of BORROWERS) {
      await client.query(
        `INSERT INTO clients (institution_id, branch_id, full_name, gender,
                              date_of_birth, phone, district_code, sector_code)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [institutionId, headOffice, fullName, gender, dateOfBirth, phone, district, sector],
      );
    }

    await client.query('COMMIT');

    console.warn('');
    console.warn('  Development data seeded. Every value below is invented.');
    console.warn('');
    console.warn(`  Institution   Faraja Microfinance (dev ${suffix})`);
    console.warn(`  Password      ${DEMO_PASSWORD}   (all accounts)`);
    console.warn('');
    for (const [email, fullName, role] of STAFF) {
      console.warn(`  ${email.padEnd(24)} ${fullName.padEnd(18)} ${role}`);
    }
    console.warn('');
    console.warn('  Approval limits — invented for development, not a lending policy:');
    for (const [role, limit] of DEVELOPMENT_APPROVAL_THRESHOLDS) {
      console.warn(`  ${role.padEnd(24)} up to TZS ${limit}`);
    }
    console.warn('');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
