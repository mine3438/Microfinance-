import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DuplicateMigrationVersionError, MalformedMigrationNameError } from './errors.js';

/**
 * `<version>_<name>.sql` — four or more digits, then lower snake_case.
 *
 * Four digits rather than a timestamp because these are reviewed in pull
 * requests: a human comparing `0007` to `0008` sees the order immediately,
 * where two 14-digit timestamps have to be read carefully.
 */
const MIGRATION_FILENAME_PATTERN = /^(?<version>\d{4,})_(?<name>[a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

/**
 * Marker opting a migration out of the wrapping transaction.
 *
 * Some statements cannot run inside one — `CREATE INDEX CONCURRENTLY` and
 * `ALTER TYPE ... ADD VALUE` being the ones this project is most likely to
 * need. Such a migration is not atomic: if it fails midway it leaves partial
 * state that must be cleaned up by hand, so the marker has to be written
 * deliberately.
 */
const NO_TRANSACTION_MARKER = '-- mfi:no-transaction';

/** A migration as it exists on disk. */
export interface MigrationFile {
  /** Zero-padded numeric version, e.g. `0001`. Sorts lexicographically. */
  readonly version: string;
  /** Descriptive portion of the filename, e.g. `core_schema`. */
  readonly name: string;
  /** Full filename, e.g. `0001_core_schema.sql`. */
  readonly filename: string;
  /** Raw SQL. Executed verbatim. */
  readonly sql: string;
  /** SHA-256 of the SQL, hex encoded. Detects edits to applied migrations. */
  readonly checksum: string;
  /** True when the file opts out of the wrapping transaction. */
  readonly runOutsideTransaction: boolean;
}

/** Hash migration SQL. Exported so tests and tooling agree on the algorithm. */
export function checksumOf(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

/** Parse a filename into its version and name, or reject it. */
export function parseMigrationFilename(filename: string): { version: string; name: string } {
  const match = MIGRATION_FILENAME_PATTERN.exec(filename);
  const groups = match?.groups;
  if (groups?.['version'] === undefined || groups['name'] === undefined) {
    throw new MalformedMigrationNameError(filename);
  }
  return { version: groups['version'], name: groups['name'] };
}

/**
 * Compare two versions numerically, falling back to string order for versions
 * too large for a safe integer.
 *
 * Padding widths may differ across a project's lifetime (`0009` then `00010`),
 * so lexicographic comparison alone would order them wrongly.
 */
export function compareVersions(a: string, b: string): number {
  const numA = Number(a);
  const numB = Number(b);
  if (Number.isSafeInteger(numA) && Number.isSafeInteger(numB) && numA !== numB) {
    return numA - numB;
  }
  return a.localeCompare(b);
}

/**
 * Load every migration in `directory`, in apply order.
 *
 * Non-`.sql` files are ignored so a directory README can sit alongside the
 * migrations. Every `.sql` file must parse — a malformed name is an error
 * rather than a skip, because silently ignoring a migration someone wrote is
 * exactly the failure this runner exists to prevent.
 */
export async function loadMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const sqlFilenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name);

  const migrations: MigrationFile[] = [];
  const seenVersions = new Map<string, string[]>();

  for (const filename of sqlFilenames) {
    const { version, name } = parseMigrationFilename(filename);
    const claimants = seenVersions.get(version) ?? [];
    claimants.push(filename);
    seenVersions.set(version, claimants);

    const sql = await readFile(join(directory, filename), 'utf8');
    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum: checksumOf(sql),
      runOutsideTransaction: sql.includes(NO_TRANSACTION_MARKER),
    });
  }

  for (const [version, claimants] of seenVersions) {
    if (claimants.length > 1) {
      throw new DuplicateMigrationVersionError(version, claimants.sort());
    }
  }

  return migrations.sort((a, b) => compareVersions(a.version, b.version));
}
