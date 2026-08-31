import { type ErrorResponse } from '@mfi/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CORRELATION_HEADER } from '../src/http/correlation.js';
import { freshAddress, seedUser, startHarness, type Harness } from './harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  await harness.close();
});

describe('security headers', () => {
  it('sets the headers helmet is registered for', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
    });

    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
    // The API returns JSON only, so a content policy that permits nothing costs
    // nothing — and a response somehow rendered as a document executes none of
    // it.
    expect(response.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('does not advertise the framework', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
    });

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('omits HSTS outside production, where it would pin localhost to HTTPS', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
    });

    expect(response.headers['strict-transport-security']).toBeUndefined();
  });
});

describe('CORS', () => {
  const preflight = async (origin: string) =>
    harness.server.inject({
      method: 'OPTIONS',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

  it('allows a configured origin, with credentials', async () => {
    const response = await preflight('https://app.example.test');

    expect(response.headers['access-control-allow-origin']).toBe('https://app.example.test');
    // Without this the browser will not send the refresh cookie at all.
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not reflect an unconfigured origin', async () => {
    const response = await preflight('https://attacker.example');

    // Reflecting the caller's origin is the failure that makes a credentialed
    // API readable from any site the user visits.
    expect(response.headers['access-control-allow-origin']).not.toBe('https://attacker.example');
  });

  it('never answers with a wildcard, which cannot carry credentials', async () => {
    const response = await preflight('https://app.example.test');

    expect(response.headers['access-control-allow-origin']).not.toBe('*');
  });
});

describe('rate limiting', () => {
  it('refuses a sixth login attempt from one address within the window', async () => {
    // The production configuration, not a loosened one. Login is where an
    // attacker with a password list spends its requests, and each attempt costs
    // the server an argon2 computation.
    const address = freshAddress();
    const attempt = async () =>
      harness.server.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: address,
        payload: { email: 'nobody@seed.test', password: 'wrong password guess' },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await attempt()).statusCode);
    }

    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses[5]).toBe(429);
  });

  it('answers a rate limit in the standard envelope, with a retry delay', async () => {
    const address = freshAddress();
    const attempt = async () =>
      harness.server.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: address,
        payload: { email: 'nobody@seed.test', password: 'wrong password guess' },
      });

    let last = await attempt();
    for (let i = 0; i < 6 && last.statusCode !== 429; i += 1) {
      last = await attempt();
    }

    const body = last.json<ErrorResponse>();
    expect(last.statusCode).toBe(429);
    // The limiter throws whatever its response builder returns. A plain object
    // there lands in the error handler unrecognised and becomes a 500 — a rate
    // limit reported as a server fault, with no retry delay for the caller.
    expect(body.error.code).toBe('rate_limited');
    expect(body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(last.headers['retry-after']).toBeDefined();
  });

  it('counts separately per caller, so one address cannot exhaust another', async () => {
    const noisy = freshAddress();
    for (let i = 0; i < 6; i += 1) {
      await harness.server.inject({
        method: 'POST',
        url: '/auth/login',
        remoteAddress: noisy,
        payload: { email: 'nobody@seed.test', password: 'wrong password guess' },
      });
    }

    const seeded = await seedUser(harness.database);
    const quiet = await harness.server.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      payload: { email: seeded.email, password: seeded.password },
    });

    expect(quiet.statusCode).toBe(200);
  });
});

describe('when the rate-limit store is unreachable', () => {
  let degraded: Harness;

  beforeAll(async () => {
    // Nothing listens on this port. The plugin's own default would propagate
    // the store error and fail the request, so this suite is what proves the
    // override is in effect rather than merely written down.
    degraded = await startHarness({ REDIS_URL: 'redis://127.0.0.1:6399' }, { waitForRedis: false });
  });

  afterAll(async () => {
    await degraded.close();
  });

  it('keeps serving ordinary requests rather than failing them all', async () => {
    const response = await degraded.server.inject({
      method: 'GET',
      url: '/auth/me',
      remoteAddress: freshAddress(),
      headers: { authorization: 'Bearer not-a-real-token' },
    });

    // 401 because the token is nonsense — not 500 because the cache is down.
    // An institution must not lose the ability to record a payment because
    // Redis is unavailable.
    expect(response.statusCode).toBe(401);
  });

  it('refuses login rather than serving it unlimited', async () => {
    const seeded = await seedUser(degraded.database);

    const response = await degraded.server.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      payload: { email: seeded.email, password: seeded.password },
    });

    // Login fails closed, alone among the routes. Here the limit is the control
    // rather than a protection around one, and losing it silently would leave
    // password guessing unbounded for the length of the outage.
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });
});

describe('correlation identifiers', () => {
  it('returns one on every response', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
    });

    expect(response.headers[CORRELATION_HEADER]).toBeTruthy();
  });

  it('honours a caller-supplied identifier so a trace spans client and server', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
      headers: { [CORRELATION_HEADER]: 'client-trace-123' },
    });

    expect(response.headers[CORRELATION_HEADER]).toBe('client-trace-123');
  });

  it.each([
    ['a newline, which would forge a second log entry', 'abc\ndef'],
    ['a carriage return', 'abc\rdef'],
    ['JSON, which would restructure a log record', '{"level":"fatal"}'],
    ['an over-long value', 'x'.repeat(200)],
  ])('replaces %s rather than echoing it', async (_label, supplied) => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/health',
      remoteAddress: freshAddress(),
      headers: { [CORRELATION_HEADER]: supplied },
    });

    // This value is written into structured logs and returned in a header.
    // Echoing it unvalidated is log injection and response splitting handed to
    // us by the caller. Replaced rather than rejected: a malformed trace header
    // should not fail an otherwise valid request.
    expect(response.headers[CORRELATION_HEADER]).not.toBe(supplied);
    expect(response.statusCode).toBe(200);
  });

  it('ties an error response to the header, so a user can quote it to support', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/no-such-route',
      remoteAddress: freshAddress(),
    });

    const body = response.json<ErrorResponse>();
    expect(body.error.correlationId).toBe(response.headers[CORRELATION_HEADER]);
  });
});

describe('error disclosure', () => {
  it('answers an unknown route in the standard envelope', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/no-such-route',
      remoteAddress: freshAddress(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorResponse>().error.code).toBe('not_found');
  });

  it('refuses a body larger than the limit', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      payload: { email: 'a@b.co.tz', password: 'x'.repeat(2_000_000) },
    });

    // Without a cap, an unauthenticated caller decides how much the server
    // buffers.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(response.statusCode).not.toBe(200);
  });

  it('discloses no stack trace, SQL or driver detail on a malformed request', async () => {
    const response = await harness.server.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      payload: 'not json at all',
      headers: { 'content-type': 'application/json' },
    });

    const raw = response.body;
    expect(raw).not.toMatch(/at .*\.ts:\d+/);
    expect(raw).not.toMatch(/SELECT |INSERT |pg_|relation "/i);
  });

  it('never carries a set-cookie for the refresh token on a failed login', async () => {
    const seeded = await seedUser(harness.database);
    const response = await harness.server.inject({
      method: 'POST',
      url: '/auth/login',
      remoteAddress: freshAddress(),
      payload: { email: seeded.email, password: 'wrong' },
    });

    expect(response.headers['set-cookie']).toBeUndefined();
  });
});

describe('readiness', () => {
  it('reports ready when the schema is migrated and tenancy resolves', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/ready',
      remoteAddress: freshAddress(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready' });
  });

  it('says nothing beyond ready or unready', async () => {
    const response = await harness.server.inject({
      method: 'GET',
      url: '/ready',
      remoteAddress: freshAddress(),
    });

    // No version, no dependency hostname, no error detail. A readiness probe
    // that reports why it is unready is a reconnaissance endpoint.
    expect(Object.keys(response.json())).toEqual(['status']);
  });
});
