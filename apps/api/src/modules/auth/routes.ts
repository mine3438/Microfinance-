import {
  acknowledgementSchema,
  loginRequestSchema,
  loginResponseSchema,
  refreshResponseSchema,
  sessionUserSchema,
} from '@mfi/contracts';
import { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import { type AccessTokenService } from '../../auth/access-token.js';
import { authenticate, principalOf } from '../../http/authentication.js';
import { unauthenticated, validationFailed } from '../../http/errors.js';
import { login } from './login.js';
import { logout, refresh } from './refresh.js';
import { type SessionRepository } from './session-repository.js';

/**
 * Name of the cookie carrying the refresh token.
 *
 * `__Host-` is not decorative. Browsers enforce that a cookie with that prefix
 * is `Secure`, has no `Domain` attribute and is pathed at `/` — which means a
 * subdomain cannot set or overwrite it. Without the prefix, a compromised
 * subdomain can plant a refresh cookie on the parent domain, and session
 * fixation is back.
 */
export const REFRESH_COOKIE = '__Host-mfi_refresh';

/**
 * Where the refresh cookie is sent.
 *
 * Scoped to the two endpoints that consume it, so it is not attached to every
 * ordinary API call. A credential that travels only when it is needed is a
 * credential with fewer chances to leak into a log, a proxy or a referrer.
 *
 * `__Host-` requires `Path=/`, so the scoping cannot be done by path here — it
 * is done by not reading the cookie anywhere else, and by `SameSite=Strict`.
 */
const COOKIE_PATH = '/';

export interface AuthRouteOptions {
  readonly sessions: SessionRepository;
  readonly tokens: AccessTokenService;
  readonly refreshTtlSeconds: number;
  readonly cookieSecure: boolean;
  readonly now: () => Date;
}

/** Cookie attributes, in one place so no route sets a weaker variant. */
function cookieOptions(options: AuthRouteOptions, expires: Date): Record<string, unknown> {
  return {
    path: COOKIE_PATH,
    // Unreadable to script. This is what makes an XSS payload unable to
    // exfiltrate the long-lived credential, which is the entire reason the
    // refresh token is not in the response body beside the access token.
    httpOnly: true,
    secure: options.cookieSecure,
    // Strict, not Lax. A refresh is a credential exchange and never needs to
    // work as a result of following a link from another site; Strict means a
    // cross-site request cannot carry the cookie at all, which is what removes
    // classic CSRF from this endpoint rather than mitigating it.
    sameSite: 'strict',
    expires,
  };
}

/** Read the caller's address, preferring what the proxy reports if trusted. */
function clientAddress(request: FastifyRequest): string | null {
  return request.ip.length > 0 ? request.ip : null;
}

function userAgent(request: FastifyRequest): string | null {
  const header = request.headers['user-agent'];
  return typeof header === 'string' && header.length > 0 ? header.slice(0, 512) : null;
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const { sessions, tokens, refreshTtlSeconds, now } = options;

  app.post(
    '/auth/login',
    {
      config: {
        // The strictest tier in the system. Login is where an attacker with a
        // password list spends its requests, and argon2 makes each attempt
        // expensive for us as well as for them — so the limit protects the
        // accounts and the server's CPU at once.
        //
        // `skipOnError: false` overrides the global default: if the rate-limit
        // store is unreachable this endpoint refuses rather than serving
        // unlimited attempts. Everywhere else continues unlimited, because a
        // cache outage must not stop an institution recording payments. Here it
        // must, because here the limit is the control.
        rateLimit: { max: 5, timeWindow: '1 minute', skipOnError: false },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = loginRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        throw validationFailed(parsed.error, 'Enter your email address and password.');
      }

      const result = await login(
        parsed.data,
        { userAgent: userAgent(request), ipAddress: clientAddress(request) },
        { sessions, tokens, refreshTtlSeconds, now },
      );

      void reply.setCookie(
        REFRESH_COOKIE,
        result.refreshToken,
        cookieOptions(options, result.refreshTokenExpiresAt),
      );

      return loginResponseSchema.parse(result.response);
    },
  );

  app.post(
    '/auth/refresh',
    {
      config: {
        // Looser than login — a legitimate client refreshes on a timer and may
        // have several tabs — but still bounded, because this endpoint is what
        // a stolen refresh token is used against.
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const presented = request.cookies[REFRESH_COOKIE];
      if (typeof presented !== 'string' || presented.length === 0) {
        throw unauthenticated('Your session has ended. Please sign in again.');
      }

      const result = await refresh(
        presented,
        { userAgent: userAgent(request), ipAddress: clientAddress(request) },
        {
          sessions,
          tokens,
          refreshTtlSeconds,
          now,
          onReuseDetected: ({ familyId, userId }) => {
            // Logged at warn, with no token material. A replayed refresh token
            // is a security event an operator should see, and the family and
            // user are what an investigation needs.
            request.log.warn(
              { familyId, userId, correlationId: request.correlationId },
              'Refresh token reuse detected; token family revoked.',
            );
          },
        },
      );

      void reply.setCookie(
        REFRESH_COOKIE,
        result.refreshToken,
        cookieOptions(options, result.refreshTokenExpiresAt),
      );

      return refreshResponseSchema.parse(result.response);
    },
  );

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const presented = request.cookies[REFRESH_COOKIE];

    if (typeof presented === 'string' && presented.length > 0) {
      await logout(presented, { sessions, now });
    }

    // Cleared whether or not a session was found, so a client holding a stale
    // or unparseable cookie is not left with it after asking to sign out.
    void reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });

    return acknowledgementSchema.parse({ ok: true });
  });

  app.get(
    '/auth/me',
    { preHandler: authenticate(tokens) },
    async (request: FastifyRequest): Promise<unknown> => {
      const principal = principalOf(request);

      // Re-read rather than reflected from the token. The token's permissions
      // are up to one lifetime stale by design; this endpoint is what a client
      // calls to find out its authority, so it answers from the database.
      const session = await sessions.resolveSession(principal.institutionId, principal.userId);
      if (session === null) {
        throw unauthenticated();
      }

      return sessionUserSchema.parse(session.user);
    },
  );
}
