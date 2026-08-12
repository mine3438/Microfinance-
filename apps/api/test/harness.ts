import { randomUUID } from 'node:crypto';

import { type RoleCode } from '@mfi/contracts';
import { Database } from '@mfi/db';
import { hashPassword } from '@mfi/identity';
import { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

import { AccessTokenService } from '../src/auth/access-token.js';
import { loadEnvironment, type Environment } from '../src/config/environment.js';
import { buildServer } from '../src/http/server.js';
import { PostgresSessionRepository } from '../src/modules/auth/session-repository.js';
import { PostgresClientRepository } from '../src/modules/clients/client-repository.js';
import { PostgresLoanRepository } from '../src/modules/loans/loan-repository.js';
import { PostgresFinanceRepository } from '../src/modules/finance/finance-repository.js';
import { PostgresPaymentRepository } from '../src/modules/payments/payment-repository.js';
import { PostgresComplaintRepository } from '../src/modules/complaints/complaint-repository.js';
import { PostgresFilingRepository } from '../src/modules/filings/filing-repository.js';
import { PostgresCellMapRepository } from '../src/modules/exports/cell-map.js';
import { PostgresExportRepository } from '../src/modules/exports/export-repository.js';
import { PostgresReportRepository } from '../src/modules/reporting/report-repository.js';
import { PostgresStatementRepository } from '../src/modules/statements/statement-repository.js';
import { testDatabaseUrl, testRedisUrl } from './global-setup.js';

/**
 * A running server, built the way `composition.ts` builds the real one.
 *
 * Deliberately not a partial or a mocked variant: the plugins under test are
 * the security controls — helmet, CORS, the rate limiter, the cookie handling —
 * and a harness that skipped them would assert a server nobody deploys.
 */
export interface Harness {
  readonly server: FastifyInstance;
  readonly database: Database;
  readonly environment: Environment;
  readonly tokens: AccessTokenService;
  close(): Promise<void>;
}

/** A 32-character secret, satisfying the minimum without being a real one. */
export const TEST_JWT_SECRET = 'test-secret-for-suite-only-32chars';

export function testEnvironment(overrides: Record<string, string> = {}): Environment {
  return loadEnvironment({
    NODE_ENV: 'test',
    DATABASE_URL: testDatabaseUrl(),
    REDIS_URL: testRedisUrl(),
    JWT_SECRET: TEST_JWT_SECRET,
    CORS_ORIGINS: 'https://app.example.test',
    // The suite runs over Fastify's injected transport, which is not HTTPS.
    COOKIE_SECURE: 'false',
    // Quiet by default. `TEST_LOG_LEVEL=error pnpm test` turns the server's own
    // log back on, which is the only way to see what a deliberately opaque 500
    // was actually caused by.
    LOG_LEVEL: process.env['TEST_LOG_LEVEL'] ?? 'fatal',
    ...overrides,
  });
}

/** Resolve once the client is connected, or reject if it does not connect. */
async function redisReady(redis: Redis, timeoutMs = 5_000): Promise<void> {
  if (redis.status === 'ready') {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Redis did not become ready within ${String(timeoutMs)}ms.`));
    }, timeoutMs);

    const cleanup = (): void => {
      clearTimeout(timer);
      redis.off('ready', onReady);
    };
    const onReady = (): void => {
      cleanup();
      resolve();
    };

    redis.once('ready', onReady);
  });
}

export async function startHarness(
  overrides: Record<string, string> = {},
  { waitForRedis = true }: { waitForRedis?: boolean } = {},
): Promise<Harness> {
  const environment = testEnvironment(overrides);

  const database = Database.fromConnectionString(environment.DATABASE_URL, {
    applicationRole: environment.DATABASE_APPLICATION_ROLE,
  });
  const redis = new Redis(environment.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    // Namespaced so a suite's rate-limit counters cannot be inherited from a
    // previous run or from another suite running against the same Redis.
    keyPrefix: `mfi-api-test:${randomUUID()}:`,
  });

  const tokens = new AccessTokenService({
    secret: environment.JWT_SECRET,
    ttlSeconds: environment.ACCESS_TOKEN_TTL_SECONDS,
  });

  // Swallowed rather than left unhandled: an unhandled 'error' event kills the
  // process, and one suite deliberately points the harness at a dead Redis.
  redis.on('error', () => undefined);

  const server = await buildServer({
    environment,
    database,
    redis,
    sessions: new PostgresSessionRepository(database),
    clients: new PostgresClientRepository(database),
    loans: new PostgresLoanRepository(database),
    payments: new PostgresPaymentRepository(database),
    reports: new PostgresReportRepository(database),
    finance: new PostgresFinanceRepository(database),
    statements: new PostgresStatementRepository(database),
    filings: new PostgresFilingRepository(database),
    complaints: new PostgresComplaintRepository(database),
    exports: new PostgresExportRepository(database),
    cellMaps: new PostgresCellMapRepository(database),
    tokens,
  });
  await server.ready();

  if (waitForRedis) {
    // Waits for the connection, rather than issuing a command against it.
    // `enableOfflineQueue: false` makes any command sent before the socket is
    // ready throw immediately — including a ping intended to check readiness.
    // Without this, whether a suite's first requests see a working limiter
    // depends on how long the preceding fixture happened to take.
    await redisReady(redis);
  }

  return {
    server,
    database,
    environment,
    tokens,
    close: async (): Promise<void> => {
      await server.close();
      await database.close();
      redis.disconnect();
    },
  };
}

export interface SeededUser {
  readonly institutionId: string;
  readonly branchId: string;
  readonly userId: string;
  readonly email: string;
  readonly password: string;
}

export interface SeedOptions {
  readonly email?: string;
  readonly password?: string;
  readonly roles?: readonly RoleCode[];
  readonly userStatus?: 'invited' | 'active' | 'suspended';
  readonly institutionStatus?: 'active' | 'suspended' | 'closed';
  /** Set false to leave the user with no password, as an invitation does. */
  readonly withPassword?: boolean;
}

export const DEFAULT_TEST_PASSWORD = 'correct horse battery staple';

/**
 * Create an institution, a branch and a user, each run with fresh identifiers.
 *
 * Fresh rather than fixed, so suites never contend over a shared row and a
 * failure is never another suite's leftover. `users_email_unique` is global
 * across institutions, so the email is unique per seed too.
 */
export async function seedUser(database: Database, options: SeedOptions = {}): Promise<SeededUser> {
  const institutionId = randomUUID();
  const suffix = institutionId.slice(0, 8);
  const email = options.email ?? `officer.${suffix}@seed.test`;
  const password = options.password ?? DEFAULT_TEST_PASSWORD;
  const withPassword = options.withPassword ?? true;
  const userStatus = options.userStatus ?? 'active';

  const passwordHash = withPassword ? await hashPassword(password) : null;

  return database.withTransaction(async (client) => {
    await client.query('INSERT INTO institutions (id, name, status) VALUES ($1, $2, $3)', [
      institutionId,
      `Seed Institution ${suffix}`,
      options.institutionStatus ?? 'active',
    ]);

    const branch = await client.query<{ id: string }>(
      // Located, because MSP2-10 refuses to compile while an active branch has
      // no district. A fixture that left it NULL would make every reporting
      // test fail for a reason unrelated to what it was testing.
      `INSERT INTO branches (institution_id, code, name, is_head_office, district_code)
       VALUES ($1, 'HQ', 'Seed Head Office', true,
               (SELECT code FROM reference.districts ORDER BY code LIMIT 1))
       RETURNING id`,
      [institutionId],
    );
    const branchId = branch.rows[0]!.id;

    const user = await client.query<{ id: string }>(
      `INSERT INTO users (institution_id, branch_id, email, full_name, password_hash, status)
       VALUES ($1, $2, $3, 'Seed Officer', $4, $5) RETURNING id`,
      [institutionId, branchId, email, passwordHash, userStatus],
    );
    const userId = user.rows[0]!.id;

    for (const role of options.roles ?? (['loan_officer'] as const)) {
      await client.query(
        'INSERT INTO user_roles (institution_id, user_id, role_code) VALUES ($1, $2, $3)',
        [institutionId, userId, role],
      );
    }

    return { institutionId, branchId, userId, email, password };
  });
}

let addressCounter = 0;

/**
 * A source address no other request in this run has used.
 *
 * The rate limiter keys on the caller's address, and every injected request
 * otherwise arrives from the same one — so a suite performing more than five
 * logins would rate-limit itself, and each test's result would depend on how
 * many ran before it.
 *
 * Distinct addresses rather than a raised limit in the test configuration: the
 * limits are a security control, and a suite that runs against loosened ones
 * proves nothing about the server that ships. The limiter here is the
 * production limiter, exercised deliberately by `security.test.ts`.
 */
export function freshAddress(): string {
  addressCounter += 1;
  const n = addressCounter;
  // 10.0.0.0/8 — sixteen million, so the counter cannot wrap within a run and
  // reuse an address whose allowance is already spent.
  return `10.${String((n >> 16) & 0xff)}.${String((n >> 8) & 0xff)}.${String(n & 0xff)}`;
}

/** The `Set-Cookie` value for one cookie, or undefined if it was not set. */
export function cookieFrom(headers: unknown, name: string): string | undefined {
  const raw = (headers as Record<string, string | string[] | undefined>)['set-cookie'];
  const all = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return all.find((entry) => entry.startsWith(`${name}=`));
}

/** The value of a cookie from a `Set-Cookie` header, without its attributes. */
export function cookieValue(setCookie: string): string {
  return setCookie.split(';')[0]!.split('=').slice(1).join('=');
}
