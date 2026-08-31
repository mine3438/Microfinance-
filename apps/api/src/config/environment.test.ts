import { describe, expect, it } from 'vitest';

import { ConfigurationError, MINIMUM_SECRET_LENGTH, loadEnvironment } from './environment.js';

const valid = {
  DATABASE_URL: 'postgresql://postgres@localhost:5432/mfi',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'a'.repeat(MINIMUM_SECRET_LENGTH),
  CORS_ORIGINS: 'https://app.example.test',
};

describe('loadEnvironment', () => {
  it('accepts a complete configuration and applies the documented defaults', () => {
    const environment = loadEnvironment(valid);

    expect(environment.NODE_ENV).toBe('development');
    expect(environment.PORT).toBe(3000);
    expect(environment.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(environment.REFRESH_TOKEN_TTL_SECONDS).toBe(2_592_000);
    expect(environment.COOKIE_SECURE).toBe(true);
  });

  it.each(['DATABASE_URL', 'REDIS_URL', 'JWT_SECRET', 'CORS_ORIGINS'] as const)(
    'refuses to start without %s',
    (key) => {
      const incomplete = Object.fromEntries(Object.entries(valid).filter(([name]) => name !== key));

      expect(() => loadEnvironment(incomplete)).toThrow(ConfigurationError);
    },
  );

  it('reports every problem at once rather than one per restart', () => {
    // An operator bringing up a new environment should learn all four missing
    // variables in one attempt.
    try {
      loadEnvironment({});
      expect.unreachable('expected a ConfigurationError');
    } catch (error: unknown) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('CORS_ORIGINS');
    }
  });

  it('rejects a signing secret shorter than the hash it keys', () => {
    // HS256 is HMAC-SHA-256. A short key is brute-forceable offline by anyone
    // holding one issued token, and a forged token is any user in any
    // institution.
    expect(() =>
      loadEnvironment({ ...valid, JWT_SECRET: 'a'.repeat(MINIMUM_SECRET_LENGTH - 1) }),
    ).toThrow(/at least 32 characters/);
  });

  it('has no fallback secret to accidentally ship with', () => {
    // The pattern this design exists to prevent is `process.env.JWT_SECRET ??
    // 'dev'`, which is how a development secret reaches production. There is
    // nothing to fall back to, so it cannot happen.
    const withoutSecret = Object.fromEntries(
      Object.entries(valid).filter(([name]) => name !== 'JWT_SECRET'),
    );

    expect(() => loadEnvironment(withoutSecret)).toThrow(ConfigurationError);
  });

  it('refuses a wildcard origin, which cannot carry credentials', () => {
    expect(() => loadEnvironment({ ...valid, CORS_ORIGINS: '*' })).toThrow(/may not be/);
  });

  it('splits and trims a comma-separated origin list', () => {
    const environment = loadEnvironment({
      ...valid,
      CORS_ORIGINS: ' https://a.example.test , https://b.example.test ',
    });

    expect(environment.CORS_ORIGINS).toEqual(['https://a.example.test', 'https://b.example.test']);
  });

  it('refuses an insecure cookie in production', () => {
    expect(() =>
      loadEnvironment({ ...valid, NODE_ENV: 'production', COOKIE_SECURE: 'false' }),
    ).toThrow(/refused in production/);
  });

  it('permits an insecure cookie outside production, where there is no TLS', () => {
    expect(
      loadEnvironment({ ...valid, NODE_ENV: 'test', COOKIE_SECURE: 'false' }).COOKIE_SECURE,
    ).toBe(false);
  });

  it('refuses an access token that outlives the refresh token renewing it', () => {
    // Rotation would be pointless: revoking the session would leave the access
    // token valid for longer than the session it belonged to.
    expect(() =>
      loadEnvironment({
        ...valid,
        ACCESS_TOKEN_TTL_SECONDS: '3600',
        REFRESH_TOKEN_TTL_SECONDS: '600',
      }),
    ).toThrow(/must be\s+shorter than/);
  });

  it.each([
    ['zero', '0'],
    ['negative', '-60'],
    ['fractional', '1.5'],
    ['not a number', 'fifteen minutes'],
  ])('refuses a %s token lifetime', (_label, value) => {
    expect(() => loadEnvironment({ ...valid, ACCESS_TOKEN_TTL_SECONDS: value })).toThrow(
      ConfigurationError,
    );
  });

  it('refuses a port outside the addressable range', () => {
    expect(() => loadEnvironment({ ...valid, PORT: '70000' })).toThrow(ConfigurationError);
  });
});
