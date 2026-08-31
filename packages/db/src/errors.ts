/** Base class so callers can catch every database-layer failure with one clause. */
export class DatabaseError extends Error {
  public override readonly name: string = 'DatabaseError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * The driver is configured in a way that would corrupt monetary values.
 *
 * Raised when the `NUMERIC` type parser has been replaced with something that
 * returns a JavaScript number. Every balance in the institution's loan book
 * would silently become a binary double, with no error and no symptom until
 * figures stopped reconciling.
 */
export class UnsafeDriverConfigurationError extends DatabaseError {
  public override readonly name = 'UnsafeDriverConfigurationError';

  public constructor(message: string) {
    super(message);
  }
}

/**
 * A tenant-scoped operation was attempted without a valid tenant.
 *
 * Refused before any statement runs. Row-level security would already fail
 * closed and return nothing, but an empty result is indistinguishable from
 * "this institution has no data" — which is precisely the silent failure mode
 * recorded as R4 in the analysis. Throwing makes it legible.
 */
export class MissingTenantContextError extends DatabaseError {
  public override readonly name = 'MissingTenantContextError';

  public constructor(message: string) {
    super(message);
  }
}

/** The database is not at the schema version the application expects. */
export class SchemaVersionError extends DatabaseError {
  public override readonly name = 'SchemaVersionError';

  public constructor(message: string) {
    super(message);
  }
}
