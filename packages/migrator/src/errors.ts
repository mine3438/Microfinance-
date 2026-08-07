/**
 * Typed failures for the migration runner.
 *
 * Every one of these is a refusal to proceed. A migration runner that guesses
 * is worse than one that stops: the database it is guessing about holds the
 * institution's loan book.
 */

/** Base class so callers can catch every migration failure with one clause. */
export class MigrationError extends Error {
  public override readonly name: string = 'MigrationError';

  public constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** A file in the migrations directory does not match `NNNN_name.sql`. */
export class MalformedMigrationNameError extends MigrationError {
  public override readonly name = 'MalformedMigrationNameError';

  public constructor(public readonly filename: string) {
    super(
      `Migration filename "${filename}" is malformed. ` +
        'Expected `<version>_<name>.sql`, where version is four or more digits ' +
        'and name is lower snake_case — for example `0001_core_schema.sql`.',
    );
  }
}

/** Two files claim the same version number. Ordering would be ambiguous. */
export class DuplicateMigrationVersionError extends MigrationError {
  public override readonly name = 'DuplicateMigrationVersionError';

  public constructor(
    public readonly version: string,
    public readonly filenames: readonly string[],
  ) {
    super(
      `Migration version ${version} is claimed by more than one file: ${filenames.join(', ')}. ` +
        'Versions must be unique — apply order would otherwise depend on filesystem ordering.',
    );
  }
}

/**
 * An already-applied migration's file no longer matches the checksum recorded
 * when it ran.
 *
 * This means applied history was edited. The database in front of you is not
 * the database the current files describe, and no subsequent migration can be
 * trusted to apply onto the state it expects.
 */
export class ChecksumMismatchError extends MigrationError {
  public override readonly name = 'ChecksumMismatchError';

  public constructor(
    public readonly version: string,
    public readonly filename: string,
    public readonly appliedChecksum: string,
    public readonly currentChecksum: string,
  ) {
    super(
      `Migration ${version} (${filename}) has changed since it was applied. ` +
        `Recorded checksum ${appliedChecksum}, file is now ${currentChecksum}. ` +
        'Migrations are immutable once applied — revert the edit and write a new ' +
        'migration to make the change.',
    );
  }
}

/** A migration recorded as applied has no corresponding file. */
export class MissingMigrationFileError extends MigrationError {
  public override readonly name = 'MissingMigrationFileError';

  public constructor(
    public readonly version: string,
    public readonly filename: string,
  ) {
    super(
      `Migration ${version} (${filename}) is recorded as applied but its file is missing. ` +
        'Applied migrations must remain in the repository as the record of how the ' +
        'schema reached its current state.',
    );
  }
}

/**
 * A pending migration sorts before one that is already applied.
 *
 * Applying it would run out of order against a schema that has already moved
 * past it — typically the result of merging a branch whose migration was
 * numbered before another that landed first.
 */
export class OutOfOrderMigrationError extends MigrationError {
  public override readonly name = 'OutOfOrderMigrationError';

  public constructor(
    public readonly version: string,
    public readonly filename: string,
    public readonly latestAppliedVersion: string,
  ) {
    super(
      `Migration ${version} (${filename}) is pending but sorts before the latest applied ` +
        `migration ${latestAppliedVersion}. Renumber it to follow ${latestAppliedVersion} ` +
        'so the applied order matches the file order.',
    );
  }
}

/** A migration's SQL failed. The transaction around it has been rolled back. */
export class MigrationExecutionError extends MigrationError {
  public override readonly name = 'MigrationExecutionError';

  public constructor(
    public readonly version: string,
    public readonly filename: string,
    cause: unknown,
  ) {
    super(
      `Migration ${version} (${filename}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
