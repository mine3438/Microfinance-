import { Database } from '@mfi/db';
import { type FastifyInstance } from 'fastify';
// Named rather than default: ioredis ships CommonJS, and under NodeNext the
// module's namespace object is not itself constructable.
import { Redis } from 'ioredis';

import { AccessTokenService } from './auth/access-token.js';
import { type Environment } from './config/environment.js';
import { buildServer } from './http/server.js';
import { PostgresSessionRepository } from './modules/auth/session-repository.js';
import { PostgresClientRepository } from './modules/clients/client-repository.js';
import { PostgresLoanRepository } from './modules/loans/loan-repository.js';
import { PostgresPaymentRepository } from './modules/payments/payment-repository.js';
import { PostgresReportRepository } from './modules/reporting/report-repository.js';

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
  const payments = new PostgresPaymentRepository(database);
  const reports = new PostgresReportRepository(database);

  const server = await buildServer({
    environment,
    database,
    redis,
    sessions,
    clients,
    loans,
    payments,
    reports,
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
