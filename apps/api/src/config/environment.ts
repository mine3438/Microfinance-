import { z } from 'zod';

/**
 * Configuration, validated once at startup.
 *
 * The rule this file exists to enforce: **the server refuses to start rather
 * than start wrong.** Every default here is a value that is safe in every
 * environment; anything whose wrong value would be a security problem — the
 * signing secret, the database URL, the allowed origins — has no default at
 * all, so a missing one is a boot failure with a message naming the variable.
 *
 * The alternative pattern, a fallback like `process.env.JWT_SECRET ?? 'dev'`,
 * is how a development secret reaches production. It cannot happen here because
 * there is nothing to fall back to.
 */

/**
 * Shortest signing secret accepted.
 *
 * HS256 is HMAC-SHA-256, whose security rests on the key having at least as
 * much entropy as the hash is wide. A shorter secret is brute-forceable
 * offline by anyone holding one issued token, and forging a token means
 * becoming any user in any institution. Thirty-two bytes, and the check is on
 * the secret's length rather than a warning in a README.
 */
export const MINIMUM_SECRET_LENGTH = 32;

const durationSeconds = (label: string, fallback: number): z.ZodDefault<z.ZodCoercedNumber> =>
  z.coerce
    .number({ error: `${label} must be a whole number of seconds.` })
    .int(`${label} must be a whole number of seconds.`)
    .positive(`${label} must be positive.`)
    .default(fallback);

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),

  /**
   * Postgres connection string.
   *
   * No default. A default would point somewhere, and somewhere is either wrong
   * (the server starts and serves an empty or foreign database) or right by
   * accident.
   */
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required.'),

  /**
   * Role adopted for the duration of every tenant transaction.
   *
   * Configurable because the connecting role differs between production, where
   * the application connects as `mfi_app` directly, and CI, where it connects
   * as a role that owns the schema and must step down to one row-level security
   * actually applies to.
   */
  DATABASE_APPLICATION_ROLE: z.string().min(1).default('mfi_app'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required.'),

  /**
   * Secret the access tokens are signed with.
   *
   * Symmetric (HS256) rather than a key pair, because this API is the only
   * issuer and the only verifier. Asymmetric signing buys the ability to let a
   * third party verify without being able to forge, and there is no third
   * party; it would add key distribution and rotation for a property nothing
   * needs. If a second service ever verifies these tokens, this becomes EdDSA
   * and the change is contained to `access-token.ts`.
   */
  JWT_SECRET: z
    .string()
    .min(
      MINIMUM_SECRET_LENGTH,
      `JWT_SECRET must be at least ${String(MINIMUM_SECRET_LENGTH)} characters. ` +
        'HS256 is HMAC-SHA-256: a shorter key is brute-forceable offline by anyone holding ' +
        'one issued token, and a forged token is any user in any institution.',
    ),

  /**
   * Access token lifetime.
   *
   * Fifteen minutes. It bounds how long a revoked user, a changed permission or
   * a suspended institution stays effective, because none of those is consulted
   * again until the token expires and the refresh path re-reads them.
   */
  ACCESS_TOKEN_TTL_SECONDS: durationSeconds('ACCESS_TOKEN_TTL_SECONDS', 15 * 60),

  /**
   * Refresh token lifetime — the real session length.
   *
   * Thirty days, and long only because rotation makes it safe: each use issues
   * a new token and consumes the old one, so a captured token is detectable the
   * moment either party presents a consumed one.
   */
  REFRESH_TOKEN_TTL_SECONDS: durationSeconds('REFRESH_TOKEN_TTL_SECONDS', 30 * 24 * 60 * 60),

  /**
   * Origins permitted to call this API from a browser.
   *
   * Comma-separated, no default, and no wildcard accepted. `*` cannot be
   * combined with credentials, and an API that reflects arbitrary origins has
   * no cross-origin boundary left.
   */
  CORS_ORIGINS: z
    .string()
    .min(1, 'CORS_ORIGINS is required — list the origins permitted to call this API.')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0),
    )
    .refine((origins) => origins.length > 0, 'CORS_ORIGINS must list at least one origin.')
    .refine(
      (origins) => !origins.includes('*'),
      'CORS_ORIGINS may not be "*". A wildcard cannot carry credentials and leaves no ' +
        'cross-origin boundary; list the origins explicitly.',
    ),

  /**
   * Whether the refresh cookie carries the `Secure` attribute.
   *
   * Defaults on. It may only be turned off outside production, because a
   * refresh cookie without `Secure` is sent over plain HTTP, and that is the
   * one credential in this system with a thirty-day life.
   */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Environment = z.infer<typeof environmentSchema>;

/** Raised when configuration is missing or unusable. */
export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Read and validate configuration.
 *
 * @throws {ConfigurationError} listing every problem at once.
 *
 * Every problem, not the first: an operator bringing up a new environment
 * should learn all four variables they are missing in one attempt rather than
 * in four restarts.
 */
export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new ConfigurationError(
      `Configuration is invalid, so the server will not start:\n${problems}`,
    );
  }

  const environment = result.data;

  if (environment.NODE_ENV === 'production' && !environment.COOKIE_SECURE) {
    throw new ConfigurationError(
      'COOKIE_SECURE=false is refused in production. The refresh cookie is the ' +
        'longest-lived credential in the system; without Secure it travels over plain HTTP.',
    );
  }

  if (environment.ACCESS_TOKEN_TTL_SECONDS >= environment.REFRESH_TOKEN_TTL_SECONDS) {
    throw new ConfigurationError(
      `ACCESS_TOKEN_TTL_SECONDS (${String(environment.ACCESS_TOKEN_TTL_SECONDS)}) must be ` +
        `shorter than REFRESH_TOKEN_TTL_SECONDS (${String(environment.REFRESH_TOKEN_TTL_SECONDS)}). ` +
        'An access token outliving the refresh token that renews it makes rotation pointless: ' +
        'revoking the session would leave the access token valid.',
    );
  }

  return environment;
}
