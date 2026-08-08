import { randomUUID } from 'node:crypto';

import { type LoginRequest, type LoginResponse } from '@mfi/contracts';
import { dummyHash, issueToken, verifyPassword } from '@mfi/identity';

import { type AccessTokenService } from '../../auth/access-token.js';
import { ApiError, forbidden, unauthenticated } from '../../http/errors.js';
import { type SessionRepository } from './session-repository.js';

/**
 * What a failed login says, whatever the reason.
 *
 * One message for an unknown email and for a wrong password, because
 * distinguishing them turns this endpoint into an account-existence oracle.
 * That matters more here than on a consumer product: the accounts are named
 * staff at a named financial institution, and confirming which addresses exist
 * is the first step of a credible phishing campaign against them.
 */
const REJECTED = 'Email or password is incorrect.';

export interface LoginContext {
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export interface LoginResult {
  readonly response: LoginResponse;
  /** The refresh token, to be set as a cookie. Never in the response body. */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface LoginDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: AccessTokenService;
  readonly refreshTtlSeconds: number;
  readonly now: () => Date;
}

/**
 * Authenticate a user and open a session.
 *
 * The order of checks is the security design, not an implementation detail:
 *
 * 1. Resolve the email. A miss does **not** return early — it verifies the
 *    supplied password against a throwaway hash first, so an unknown address
 *    costs the same argon2 computation as a known one. Returning immediately
 *    would make the two distinguishable by response time alone, which defeats
 *    the shared message above.
 * 2. Verify the password.
 * 3. *Only then* check account and institution status.
 *
 * Step 3 comes last so its refusals can be specific. A caller who has already
 * proved they know the password is not learning anything by being told the
 * account is suspended — and "your account is suspended, contact your
 * administrator" is the difference between a user who knows what to do and a
 * user who tries the same password five more times and locks themselves out.
 */
export async function login(
  request: LoginRequest,
  context: LoginContext,
  dependencies: LoginDependencies,
): Promise<LoginResult> {
  const { sessions, tokens, refreshTtlSeconds, now } = dependencies;

  const identity = await sessions.findLoginIdentity(request.email);

  // A user with no password (invited, never accepted) verifies against the
  // dummy hash too, so an invitation that has not been accepted is not
  // detectable by timing either.
  const hashToVerify = identity?.passwordHash ?? (await dummyHash());
  const passwordMatches = await verifyPassword(hashToVerify, request.password);

  if (identity?.passwordHash == null || !passwordMatches) {
    throw unauthenticated(REJECTED);
  }

  if (identity.institutionStatus !== 'active') {
    throw forbidden(
      'Your institution’s account is not active. Contact the Bank of Tanzania supervision ' +
        'contact for your institution, or your system administrator.',
    );
  }

  if (identity.userStatus !== 'active') {
    throw forbidden(
      `Your account is ${identity.userStatus} and cannot sign in. Ask an administrator at your ` +
        'institution to restore it.',
    );
  }

  const session = await sessions.resolveSession(identity.institutionId, identity.userId);
  if (session === null) {
    // The identity lookup found the user, so a miss here means the same read
    // through row-level security returned nothing — the tenant setting did not
    // take effect. That is R4, the failure that presents as empty screens, and
    // it must not be reported as a login problem.
    throw new ApiError(
      'internal_error',
      'Something went wrong on our side. Quote the reference below if you contact support.',
    );
  }

  const at = now();
  const refresh = issueToken(refreshTtlSeconds, at);

  await sessions.beginSession(
    identity.institutionId,
    identity.userId,
    {
      hash: refresh.hash,
      // A new family per login, so signing out of one device — which revokes a
      // family — cannot end a session established from another.
      familyId: randomUUID(),
      expiresAt: refresh.expiresAt,
      userAgent: context.userAgent,
      ipAddress: context.ipAddress,
    },
    at,
  );

  return {
    response: {
      accessToken: await tokens.issue(session.principal),
      expiresIn: tokens.lifetimeSeconds,
      user: session.user,
    },
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}
