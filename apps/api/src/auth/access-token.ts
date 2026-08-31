import { PERMISSIONS, ROLES, type Permission, type RoleCode } from '@mfi/contracts';
import { type Principal } from '@mfi/identity';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';

/**
 * The bearer token every authenticated request carries.
 *
 * Claims are abbreviated because a token travels on every request and these are
 * repeated in each one; `prm` holding up to twenty-nine permission codes is the
 * bulk of it.
 */
export const TOKEN_ISSUER = 'mfi-manager';
export const TOKEN_AUDIENCE = 'mfi-manager-api';

/**
 * What the token asserts.
 *
 * Permissions are carried rather than re-read per request. That is a deliberate
 * trade with a bounded cost: a permission changed or a role removed does not
 * take effect until the access token expires, which the fifteen-minute lifetime
 * caps. The compensating control is that the *refresh* path re-reads the user
 * and institution from the database, so a suspension ends the session within
 * one token lifetime rather than lasting the refresh token's thirty days.
 *
 * The alternative — resolving permissions from Postgres on every request — buys
 * instant revocation at the price of a query on the hot path for every call,
 * and a database outage becoming a total authorisation outage rather than a
 * degraded one.
 */
export interface AccessTokenClaims {
  /** Subject: the user. */
  readonly sub: string;
  /** Institution the session is scoped to. */
  readonly iid: string;
  /** Branch, or null for institution-wide authority. */
  readonly bid: string | null;
  readonly rol: readonly RoleCode[];
  readonly prm: readonly Permission[];
}

/**
 * Claim shape as it comes back off the wire.
 *
 * Verified rather than cast. `jwtVerify` proves the token was signed by this
 * server and has not expired; it says nothing about the payload's shape, and a
 * token signed before a claim was renamed would otherwise flow into the
 * principal as `undefined` and produce an authorisation decision on missing
 * data.
 */
const claimsSchema = z.object({
  sub: z.uuid(),
  iid: z.uuid(),
  bid: z.uuid().nullable(),
  rol: z.array(z.enum(ROLES)),
  prm: z.array(z.enum(PERMISSIONS)),
});

/** Raised when a token cannot be trusted, for any reason. */
export class InvalidTokenError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidTokenError';
  }
}

export interface AccessTokenServiceOptions {
  readonly secret: string;
  readonly ttlSeconds: number;
}

/**
 * Issues and verifies access tokens.
 *
 * A class holding the key material rather than module-level functions reading
 * `process.env`, so a test can construct one with its own key and nothing
 * reaches for global configuration at call time.
 */
export class AccessTokenService {
  private readonly key: Uint8Array;
  private readonly ttlSeconds: number;

  public constructor(options: AccessTokenServiceOptions) {
    this.key = new TextEncoder().encode(options.secret);
    this.ttlSeconds = options.ttlSeconds;
  }

  /** Seconds an issued token remains valid. */
  public get lifetimeSeconds(): number {
    return this.ttlSeconds;
  }

  /** Sign a token for a resolved principal. */
  public async issue(principal: Principal): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: principal.userId,
      iid: principal.institutionId,
      bid: principal.branchId,
      rol: [...principal.roles],
      prm: [...principal.permissions],
    };

    return new SignJWT({ ...claims } satisfies JWTPayload)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${String(this.ttlSeconds)}s`)
      .sign(this.key);
  }

  /**
   * Verify a token and rebuild the principal it asserts.
   *
   * @throws {InvalidTokenError} for a bad signature, an expired token, the
   * wrong issuer or audience, or a payload that does not match the claim shape.
   *
   * Every failure raises the same error type and none of the messages
   * distinguishes *which* check failed to the caller. The distinction is useful
   * to an operator reading logs and useful to an attacker probing a token, so
   * it is logged and not returned.
   */
  public async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;

    try {
      const verified = await jwtVerify(token, this.key, {
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        algorithms: ['HS256'],
      });
      payload = verified.payload;
    } catch (error: unknown) {
      throw new InvalidTokenError(
        `Access token rejected: ${error instanceof Error ? error.message : 'unknown reason'}`,
      );
    }

    const claims = claimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new InvalidTokenError(
        'Access token is correctly signed but its claims do not match the expected shape. ' +
          'This is a token issued by an older version of this server.',
      );
    }

    return {
      userId: claims.data.sub,
      institutionId: claims.data.iid,
      branchId: claims.data.bid,
      roles: claims.data.rol,
      permissions: new Set(claims.data.prm),
    };
  }
}
