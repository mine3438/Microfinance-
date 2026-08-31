import { type RefreshResponse } from '@mfi/contracts';
import { hashToken, isExpired, issueToken } from '@mfi/identity';

import { type AccessTokenService } from '../../auth/access-token.js';
import { forbidden, unauthenticated } from '../../http/errors.js';
import { ConcurrentRotationError, type SessionRepository } from './session-repository.js';

/**
 * What a failed refresh says.
 *
 * Uniform for the same reason login's is: a client cannot tell an unknown token
 * from an expired one from a revoked family, and there is nothing useful it
 * would do differently. In every case it signs in again.
 */
const REJECTED = 'Your session has ended. Please sign in again.';

/** Recorded on the family when a replayed token is detected. */
export const REUSE_REVOCATION_REASON = 'refresh_token_reuse_detected';

/** Recorded when a session is ended deliberately. */
export const LOGOUT_REVOCATION_REASON = 'signed_out';

export interface RefreshContext {
  readonly userAgent: string | null;
  readonly ipAddress: string | null;
}

export interface RefreshResult {
  readonly response: RefreshResponse;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
}

export interface RefreshDependencies {
  readonly sessions: SessionRepository;
  readonly tokens: AccessTokenService;
  readonly refreshTtlSeconds: number;
  readonly now: () => Date;
  /** Called when a replayed token revokes a family, so the event can be logged. */
  readonly onReuseDetected?: (details: { familyId: string; userId: string }) => void;
}

/**
 * Exchange a refresh token for a new access token, rotating the refresh token.
 *
 * **Rotation with reuse detection.** Every refresh consumes the presented token
 * and issues a new one in the same family. So a token presented twice is
 * evidence: the legitimate holder has already rotated past it, and the only way
 * a second party still holds it is capture. The response is to revoke the whole
 * family rather than to issue a fresh pair — which ends the session for the
 * attacker *and* for the legitimate user, who signs in again and, in doing so,
 * finds out something happened.
 *
 * Without this, a stolen refresh token is indistinguishable from a legitimate
 * one and grants access for its full thirty days. It is what makes a long-lived
 * refresh token defensible at all.
 *
 * Status is re-read here and nowhere else on the hot path. That is what bounds
 * a suspension to one access-token lifetime rather than to the refresh token's
 * life.
 */
export async function refresh(
  presentedToken: string,
  context: RefreshContext,
  dependencies: RefreshDependencies,
): Promise<RefreshResult> {
  const { sessions, tokens, refreshTtlSeconds, now } = dependencies;

  const record = await sessions.findRefreshToken(hashToken(presentedToken));
  if (record === null) {
    throw unauthenticated(REJECTED);
  }

  const at = now();

  if (record.usedAt !== null) {
    // The detection. Revoke the family before refusing, so the refusal cannot
    // be retried into a working session.
    await sessions.revokeFamily(record.institutionId, record.familyId, REUSE_REVOCATION_REASON, at);
    dependencies.onReuseDetected?.({ familyId: record.familyId, userId: record.userId });
    throw unauthenticated(REJECTED);
  }

  if (record.revokedAt !== null || isExpired(record.expiresAt, at)) {
    throw unauthenticated(REJECTED);
  }

  if (record.institutionStatus !== 'active' || record.userStatus !== 'active') {
    // Ends the session rather than refusing this one request: an account
    // suspended mid-session should not keep refreshing until its token expires.
    await sessions.revokeFamily(record.institutionId, record.familyId, 'account_not_active', at);
    throw forbidden('Your account is no longer active. Contact an administrator.');
  }

  const session = await sessions.resolveSession(record.institutionId, record.userId);
  if (session === null) {
    throw unauthenticated(REJECTED);
  }

  const replacement = issueToken(refreshTtlSeconds, at);

  try {
    await sessions.rotateRefreshToken(
      record.institutionId,
      record.tokenId,
      {
        hash: replacement.hash,
        // Same family: the chain is what links a rotation to the session it
        // continues, and what a revocation follows.
        familyId: record.familyId,
        expiresAt: replacement.expiresAt,
        userAgent: context.userAgent,
        ipAddress: context.ipAddress,
      },
      at,
    );
  } catch (error: unknown) {
    if (error instanceof ConcurrentRotationError) {
      // Another request consumed this token between the lookup and the update.
      // At this layer that is indistinguishable from a replay, and is treated
      // as one rather than guessed at.
      throw unauthenticated(REJECTED);
    }
    throw error;
  }

  return {
    response: {
      accessToken: await tokens.issue(session.principal),
      expiresIn: tokens.lifetimeSeconds,
    },
    refreshToken: replacement.token,
    refreshTokenExpiresAt: replacement.expiresAt,
  };
}

/**
 * End a session.
 *
 * Revokes the family rather than the single token, so signing out on a device
 * cannot be undone by replaying an earlier token from the same chain.
 *
 * Succeeds silently for a token that does not resolve. Signing out is not an
 * operation a caller should be able to fail: an error here leaves a user
 * looking at a screen that says they are still signed in, and there is nothing
 * they could do about it.
 */
export async function logout(
  presentedToken: string,
  dependencies: Pick<RefreshDependencies, 'sessions' | 'now'>,
): Promise<void> {
  const record = await dependencies.sessions.findRefreshToken(hashToken(presentedToken));
  if (record === null) {
    return;
  }

  await dependencies.sessions.revokeFamily(
    record.institutionId,
    record.familyId,
    LOGOUT_REVOCATION_REASON,
    dependencies.now(),
  );
}
