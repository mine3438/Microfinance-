/** Base class so callers can catch every identity failure with one clause. */
export class IdentityError extends Error {
  public override readonly name: string = 'IdentityError';

  public constructor(message: string) {
    super(message);
  }
}

/** A password did not meet the policy. */
export class WeakPasswordError extends IdentityError {
  public override readonly name = 'WeakPasswordError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * A refresh token was presented that had already been consumed.
 *
 * Not an ordinary expiry. Rotation means the legitimate holder has moved past
 * this token, so a second presentation is evidence the value was captured. The
 * response is to revoke the whole token family and end the session rather than
 * to issue a fresh pair.
 */
export class TokenReuseDetectedError extends IdentityError {
  public override readonly name = 'TokenReuseDetectedError';

  public constructor(public readonly familyId: string) {
    super(
      `Refresh token family ${familyId} was presented after it had already been rotated. ` +
        'The family has been revoked: a replayed token indicates the value was captured.',
    );
  }
}
