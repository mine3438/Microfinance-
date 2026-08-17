import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { type Database } from '@mfi/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Redis } from 'ioredis';

import { type AccessTokenService } from '../auth/access-token.js';
import { type Environment } from '../config/environment.js';
import { type SessionRepository } from '../modules/auth/session-repository.js';
import { type ClientRepository } from '../modules/clients/client-repository.js';
import { registerClientRoutes } from '../modules/clients/routes.js';
import { type LoanRepository } from '../modules/loans/loan-repository.js';
import { registerLoanRoutes } from '../modules/loans/routes.js';
import { type PaymentRepository } from '../modules/payments/payment-repository.js';
import { type FinanceRepository } from '../modules/finance/finance-repository.js';
import { registerFinanceRoutes } from '../modules/finance/routes.js';
import { registerPaymentRoutes } from '../modules/payments/routes.js';
import { type ReportRepository } from '../modules/reporting/report-repository.js';
import { type FilingRepository } from '../modules/filings/filing-repository.js';
import { registerFilingRoutes } from '../modules/filings/routes.js';
import { type ComplaintRepository } from '../modules/complaints/complaint-repository.js';
import { registerComplaintRoutes } from '../modules/complaints/routes.js';
import { type SavingsRepository } from '../modules/savings/savings-repository.js';
import { registerSavingsRoutes } from '../modules/savings/routes.js';
import { type PenaltyRepository } from '../modules/penalties/penalty-repository.js';
import { registerPenaltyRoutes } from '../modules/penalties/routes.js';
import { type SettingsRepository } from '../modules/settings/settings-repository.js';
import { registerSettingsRoutes } from '../modules/settings/routes.js';
import { type CellMapRepository } from '../modules/exports/cell-map.js';
import { type ExportRepository } from '../modules/exports/export-repository.js';
import { registerExportRoutes } from '../modules/exports/routes.js';
import { registerReportRoutes } from '../modules/reporting/routes.js';
import { type StatementRepository } from '../modules/statements/statement-repository.js';
import { registerStatementRoutes } from '../modules/statements/routes.js';
import { registerAuthRoutes } from '../modules/auth/routes.js';
import { registerHealthRoutes } from '../modules/health/routes.js';
import { registerCorrelationId } from './correlation.js';
import { classify, notFound, rateLimited, toErrorResponse } from './errors.js';
import './types.js';

/**
 * Largest request body accepted.
 *
 * One megabyte. Every endpoint in this API takes a small JSON document; file
 * uploads, when they arrive, get their own multipart route with its own limit.
 * Without a cap, an unauthenticated caller can make the server buffer whatever
 * it chooses to send.
 */
const MAXIMUM_BODY_BYTES = 1_048_576;

export interface ServerDependencies {
  readonly environment: Environment;
  readonly database: Database;
  readonly redis: Redis;
  readonly sessions: SessionRepository;
  readonly clients: ClientRepository;
  readonly loans: LoanRepository;
  readonly payments: PaymentRepository;
  readonly reports: ReportRepository;
  readonly finance: FinanceRepository;
  readonly statements: StatementRepository;
  readonly filings: FilingRepository;
  readonly complaints: ComplaintRepository;
  readonly savings: SavingsRepository;
  readonly penalties: PenaltyRepository;
  readonly settings: SettingsRepository;
  readonly exports: ExportRepository;
  readonly cellMaps: CellMapRepository;
  readonly tokens: AccessTokenService;
  readonly now?: () => Date;
}

/**
 * Build the HTTP server.
 *
 * Everything it needs is passed in. Nothing here reads `process.env`, opens a
 * connection or constructs a dependency — that is `composition.ts`'s job, and
 * keeping it out of here is what lets a test build a real server against a real
 * database with its own clock and its own signing key.
 *
 * The plugin order below is the request pipeline, and it is deliberate:
 * correlation first so every later failure has an identifier, then the security
 * headers, then CORS, then the rate limiter, then routes.
 */
export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const {
    environment,
    database,
    redis,
    sessions,
    clients,
    loans,
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
    tokens,
  } = dependencies;
  const now = dependencies.now ?? ((): Date => new Date());

  const app = Fastify({
    logger: {
      level: environment.LOG_LEVEL,
      redact: {
        // Belt and braces. No handler logs these, but a future one logging a
        // whole request object would otherwise put a password or a bearer token
        // into the log store, where it outlives the request by the retention
        // period and is readable by anyone with log access.
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'res.headers["set-cookie"]',
          'password',
          'refreshToken',
          'accessToken',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: MAXIMUM_BODY_BYTES,
    // Behind a load balancer or ingress, the socket address is the proxy's. The
    // rate limiter keys on the caller's address, so without this every request
    // shares one key and the per-caller limit becomes a global one.
    trustProxy: true,
  });

  registerCorrelationId(app);

  await app.register(helmet, {
    // No inline anything. This API returns JSON exclusively, so the strictest
    // policy costs nothing here; a browser that somehow renders a response
    // executes none of it.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Two years, and only in production — an HSTS header from a development
    // server pins localhost to HTTPS in the developer's browser and is
    // tedious to undo.
    hsts:
      environment.NODE_ENV === 'production'
        ? { maxAge: 63_072_000, includeSubDomains: true, preload: true }
        : false,
  });

  await app.register(cors, {
    origin: environment.CORS_ORIGINS,
    // Required for the refresh cookie to be sent at all. It is also why the
    // origin list may not be a wildcard: browsers refuse `*` with credentials,
    // and reflecting arbitrary origins would leave no boundary.
    credentials: true,
    // PUT belongs here and was missing. The statements screen has issued PUT
    // since it was built, and the suites never caught it because Fastify's
    // `inject` bypasses CORS entirely — a browser would have failed the
    // preflight while every test passed.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-Id'],
    maxAge: 600,
  });

  await app.register(cookie);

  await app.register(rateLimit, {
    // Redis-backed rather than in-memory, so the limit is the limit across
    // every instance. An in-memory counter multiplies the effective allowance
    // by the number of running processes, which is exactly wrong for the login
    // endpoint it most needs to protect.
    redis,
    global: true,
    max: 300,
    timeWindow: '1 minute',
    /**
     * What happens when Redis itself is unreachable.
     *
     * The plugin's default is `false`: any store error propagates and the
     * request fails. That means a Redis outage returns 500 for *every* request
     * — the whole institution unable to record a payment or look up a client
     * because a cache is down. A rate limiter is a protective control, not an
     * authentication control, and taking the system offline to preserve it
     * inverts what it is for.
     *
     * So the global default is to continue unlimited, and `/auth/login`
     * overrides it back to failing closed. Login is the one endpoint where the
     * limit *is* the control rather than a protection around one, and refusing
     * new sign-ins during an outage is both visible and recoverable — where
     * silently losing brute-force protection is neither.
     */
    skipOnError: true,
    // Per user where there is one, per address otherwise. Keying only by
    // address punishes an institution behind one NAT gateway, where every
    // member of staff shares a source address.
    keyGenerator: (request) => request.principal?.userId ?? request.ip,
    // Returns an ApiError rather than a response body, because the plugin
    // *throws* what this returns. The thrown value lands in the error handler
    // below, where a typed one is rendered as a 429 and anything else is
    // correctly treated as an unrecognised fault and becomes a 500.
    errorResponseBuilder: (_request, context) =>
      rateLimited(Math.max(1, Math.ceil(context.ttl / 1000))),
  });

  /**
   * The one place a thrown value becomes a response.
   *
   * Anything not deliberately classified becomes a 500 with a fixed message,
   * and the real error goes to the log against the correlation id. That
   * direction — deny by default, disclose by decision — is what stops a driver
   * error naming a table and a constraint from being handed to the caller.
   */
  app.setErrorHandler((error, request, reply) => {
    const classified = classify(error);

    if (classified.status >= 500) {
      request.log.error(
        { err: error, correlationId: request.correlationId },
        'Request failed with an unhandled error.',
      );
    } else {
      // The original message, not the classified one. They differ exactly where
      // it matters: an invalid token is refused with "authentication is
      // required" while the log keeps "signature verification failed" — which
      // is the detail an operator needs and a caller must not be handed.
      request.log.info(
        {
          code: classified.code,
          correlationId: request.correlationId,
          reason: error instanceof Error ? error.message : 'non-error thrown',
        },
        'Request refused.',
      );
    }

    void reply.status(classified.status).send(toErrorResponse(classified, request.correlationId));
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).send(toErrorResponse(notFound(), request.correlationId));
  });

  registerHealthRoutes(app, { database });
  registerAuthRoutes(app, {
    sessions,
    tokens,
    refreshTtlSeconds: environment.REFRESH_TOKEN_TTL_SECONDS,
    cookieSecure: environment.COOKIE_SECURE,
    now,
  });
  registerClientRoutes(app, { clients, tokens });
  registerLoanRoutes(app, { loans, tokens });
  registerPaymentRoutes(app, { payments, tokens });
  registerFinanceRoutes(app, { finance, tokens });
  registerStatementRoutes(app, { statements, reports, tokens });
  registerReportRoutes(app, { reports, tokens, now });
  registerFilingRoutes(app, { filings, reports, tokens, now });
  registerComplaintRoutes(app, { complaints, tokens, now });
  registerSavingsRoutes(app, { savings, tokens, now });
  registerPenaltyRoutes(app, { penalties, tokens, now });
  registerSettingsRoutes(app, { settings, tokens });
  registerExportRoutes(app, { filings, exports, cellMaps, tokens });

  return app;
}
