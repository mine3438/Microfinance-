import { Database } from '@mfi/db';
import { type FastifyInstance } from 'fastify';
// Named rather than default: ioredis ships CommonJS, and under NodeNext the
// module's namespace object is not itself constructable.
import { Redis } from 'ioredis';
import { pino } from 'pino';

import { AccessTokenService } from './auth/access-token.js';
import { type Environment } from './config/environment.js';
import { buildServer } from './http/server.js';
import { PostgresAuditRepository } from './modules/audit/audit-repository.js';
import { PostgresUserRepository } from './modules/users/user-repository.js';
import { createInvitationDelivery } from './notifications/invitation-delivery.js';
import { PostgresSessionRepository } from './modules/auth/session-repository.js';
import { PostgresClientRepository } from './modules/clients/client-repository.js';
import { PostgresLoanRepository } from './modules/loans/loan-repository.js';
import { PostgresWriteOffRepository } from './modules/loans/write-off-repository.js';
import { PostgresApplicationFeeRepository } from './modules/loans/application-fee-repository.js';
import { PostgresGroupRepository } from './modules/groups/group-repository.js';
import { PostgresSettlementRepository } from './modules/loans/settlement-repository.js';
import { PostgresRestructuringRepository } from './modules/loans/restructuring-repository.js';
import { PostgresFinanceRepository } from './modules/finance/finance-repository.js';
import { PostgresPaymentRepository } from './modules/payments/payment-repository.js';
import { PostgresComplaintRepository } from './modules/complaints/complaint-repository.js';
import { PostgresSavingsRepository } from './modules/savings/savings-repository.js';
import { PostgresPenaltyRepository } from './modules/penalties/penalty-repository.js';
import { PostgresSettingsRepository } from './modules/settings/settings-repository.js';
import { PostgresFilingRepository } from './modules/filings/filing-repository.js';
import { PostgresCellMapRepository } from './modules/exports/cell-map.js';
import { PostgresClassificationRepository } from './modules/portfolio/classification-repository.js';
import { PostgresExportRepository } from './modules/exports/export-repository.js';
import { PostgresReportRepository } from './modules/reporting/report-repository.js';
import { PostgresStatementRepository } from './modules/statements/statement-repository.js';

/**
 * The composition root.
 *
 * Every dependency in the application is constructed here, once, and passed
 * inward as an argument. There is no container, no decorator and no runtime
 * resolution — which is the point of choosing Fastify over NestJS
 * (01-ARCHITECTURE.md §17.1). A missing or mistyped dependency is a compile
 * error at the line below that would have supplied it, rather than an exception
 * thrown when a module loads.
 *
 * It is also the only file that knows both what a `Database` is and what an
 * HTTP route is. Everything else sees one or the other.
 */
export interface Application {
  readonly server: FastifyInstance;
  /** Release every connection. Safe to call more than once. */
  readonly shutdown: () => Promise<void>;
}

export async function composeApplication(environment: Environment): Promise<Application> {
  const database = Database.fromConnectionString(environment.DATABASE_URL, {
    applicationRole: environment.DATABASE_APPLICATION_ROLE,
  });

  const redis = new Redis(environment.REDIS_URL, {
    // The rate limiter must not queue requests behind a reconnect. Failing the
    // command lets the limiter decide what to do — which, per `server.ts`, is
    // to continue unlimited everywhere except login. Queueing instead would
    // make every request wait for Redis to come back.
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  const tokens = new AccessTokenService({
    secret: environment.JWT_SECRET,
    ttlSeconds: environment.ACCESS_TOKEN_TTL_SECONDS,
  });

  const sessions = new PostgresSessionRepository(database);
  const clients = new PostgresClientRepository(database);
  const loans = new PostgresLoanRepository(database);
  const writeOffs = new PostgresWriteOffRepository(database);
  const applicationFees = new PostgresApplicationFeeRepository(database);
  const groups = new PostgresGroupRepository(database);
  const settlements = new PostgresSettlementRepository(database);
  const restructurings = new PostgresRestructuringRepository(database);
  const payments = new PostgresPaymentRepository(database);
  const reports = new PostgresReportRepository(database);
  const finance = new PostgresFinanceRepository(database);
  const statements = new PostgresStatementRepository(database);
  const filings = new PostgresFilingRepository(database);
  const complaints = new PostgresComplaintRepository(database);
  const savings = new PostgresSavingsRepository(database);
  const penalties = new PostgresPenaltyRepository(database);
  const settings = new PostgresSettingsRepository(database);
  const exports = new PostgresExportRepository(database);
  const cellMaps = new PostgresCellMapRepository(database);
  const classification = new PostgresClassificationRepository(database);
  const audit = new PostgresAuditRepository(database);
  const users = new PostgresUserRepository(database);

  /**
   * How invitations reach the people invited.
   *
   * Built here rather than inside the server so a deployment that has asked for
   * a mechanism it may not use fails at startup, before a port is bound —
   * `INVITATION_DELIVERY=log` in production throws from this call. A guard that
   * fired on the first invitation instead would let the institution discover it
   * at the worst moment, which is while onboarding staff.
   *
   * Its own logger, because the server's does not exist yet and this is the
   * composition root: the alternative is passing a factory inward and letting
   * `buildServer` decide, which moves a security-relevant choice out of the one
   * file that is supposed to hold every such choice.
   */
  const invitationDelivery = createInvitationDelivery({
    mode: environment.INVITATION_DELIVERY,
    isProduction: environment.NODE_ENV === 'production',
    logger: pino({ level: environment.LOG_LEVEL }),
  });

  // Where the acceptance link points. The first CORS origin is the browser
  // origin this API already serves, so it is the right default; a deployment
  // whose web app lives elsewhere names it, rather than silently sending every
  // invitee to a host that 404s.
  const webBaseUrl = environment.WEB_BASE_URL ?? environment.CORS_ORIGINS[0];

  if (webBaseUrl === undefined) {
    throw new Error(
      'No web base URL: set WEB_BASE_URL, or list at least one origin in CORS_ORIGINS.',
    );
  }

  const server = await buildServer({
    environment,
    database,
    redis,
    sessions,
    clients,
    loans,
    writeOffs,
    applicationFees,
    groups,
    settlements,
    restructurings,
    payments,
    reports,
    finance,
    statements,
    filings,
    complaints,
    savings,
    penalties,
    settings,
    exports,
    cellMaps,
    classification,
    audit,
    users,
    invitationDelivery,
    webBaseUrl,
    tokens,
  });

  // ioredis emits `error` on every failed connection attempt. An unhandled
  // 'error' event on an EventEmitter terminates the process, so this listener
  // is not optional — without it a Redis blip stops the API by crashing it,
  // which is precisely the availability the limiter's `skipOnError` was set to
  // preserve.
  redis.on('error', (error: Error) => {
    server.log.error({ err: error }, 'Redis connection error; rate limiting is degraded.');
  });

  let closed = false;
  const shutdown = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;

    // Order matters. The server stops accepting connections and finishes what
    // it is holding first; closing the pool underneath an in-flight request
    // would fail a request that was about to succeed — and on this system an
    // in-flight request may be recording a payment.
    await server.close();
    await database.close();
    redis.disconnect();
  };

  return { server, shutdown };
}
