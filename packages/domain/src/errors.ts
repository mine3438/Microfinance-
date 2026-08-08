/** Base class so callers can catch every domain rule violation with one clause. */
export class DomainError extends Error {
  public override readonly name: string = 'DomainError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * A value did not satisfy a domain invariant.
 *
 * Distinct from a transport-level validation failure: this is raised where the
 * rule lives, so a value that reaches the domain by any route — an HTTP
 * request, an import, a scheduled job — is held to the same standard.
 */
export class DomainValidationError extends DomainError {
  public override readonly name = 'DomainValidationError';

  public constructor(message: string) {
    super(message);
  }
}
