#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { MigrationError } from './errors.js';
import { Migrator, type MigrationLogger } from './migrator.js';

const USAGE = `mfi-migrate — forward-only SQL migration runner

Usage:
  mfi-migrate <command> [--dir <path>] [--table <name>]

Commands:
  migrate   Apply every pending migration, in version order
  status    List applied and pending migrations
  verify    Check the repository against the registry; apply nothing

Options:
  --dir <path>     Migrations directory (default: ./db/migrations)
  --table <name>   Registry table name (default: schema_migrations)
  -h, --help       Show this message

Environment:
  DATABASE_URL     Postgres connection string (required)
`;

type Command = 'migrate' | 'status' | 'verify';

interface ParsedArgs {
  readonly command: Command;
  readonly dir: string;
  readonly table: string | undefined;
}

const write = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const consoleLogger: MigrationLogger = {
  info: write,
  warn: (message) => {
    process.stderr.write(`warning: ${message}\n`);
  },
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;

  if (command === undefined || command === '-h' || command === '--help') {
    write(USAGE);
    process.exit(command === undefined ? 1 : 0);
  }

  if (command !== 'migrate' && command !== 'status' && command !== 'verify') {
    throw new Error(`Unknown command "${command}". Run with --help for usage.`);
  }

  let dir = 'db/migrations';
  let table: string | undefined;

  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (value === undefined) {
      throw new Error(`Option ${String(flag)} requires a value.`);
    }
    if (flag === '--dir') {
      dir = value;
    } else if (flag === '--table') {
      table = value;
    } else {
      throw new Error(`Unknown option "${String(flag)}". Run with --help for usage.`);
    }
  }

  return { command, dir, table };
}

function formatStatusLine(version: string, filename: string, suffix: string): string {
  return `  ${version}  ${filename.padEnd(48)} ${suffix}`;
}

async function main(): Promise<void> {
  const { command, dir, table } = parseArgs(process.argv.slice(2));

  const connectionString = process.env['DATABASE_URL'];
  if (connectionString === undefined || connectionString === '') {
    throw new Error('DATABASE_URL is not set. It must point at the target Postgres database.');
  }

  const pool = new pg.Pool({ connectionString });
  const migrator = new Migrator(pool, {
    migrationsDir: dir,
    logger: consoleLogger,
    ...(table === undefined ? {} : { registryTable: table }),
  });

  try {
    if (command === 'migrate') {
      const results = await migrator.migrate();
      if (results.length > 0) {
        const total = results.reduce((sum, result) => sum + result.executionMs, 0);
        write(`Applied ${String(results.length)} migration(s) in ${String(total)}ms.`);
      }
      return;
    }

    const { applied, pending } = await migrator.status();

    write(`Applied (${String(applied.length)}):`);
    if (applied.length === 0) {
      write('  none');
    }
    for (const record of applied) {
      write(formatStatusLine(record.version, record.filename, record.appliedAt.toISOString()));
    }

    write(`\nPending (${String(pending.length)}):`);
    if (pending.length === 0) {
      write('  none');
    }
    for (const file of pending) {
      write(formatStatusLine(file.version, file.filename, ''));
    }

    // `verify` is a gate: a repository with unapplied migrations is not verified.
    if (command === 'verify' && pending.length > 0) {
      throw new Error(
        `${String(pending.length)} migration(s) pending. Run \`mfi-migrate migrate\` to apply them.`,
      );
    }
  } finally {
    await pool.end();
  }
}

/**
 * True when this module was executed rather than imported.
 *
 * Both sides are resolved through `realpath` because package managers install
 * CLIs as symlinks in `node_modules/.bin`: `process.argv[1]` is then the link
 * while `import.meta.url` is its target, and comparing them directly makes the
 * command silently do nothing.
 */
function isDirectInvocation(): boolean {
  const invokedPath = process.argv[1];
  if (invokedPath === undefined) {
    return false;
  }
  try {
    return realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main().catch((error: unknown) => {
    const message =
      error instanceof MigrationError || error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}

export { isDirectInvocation, main, parseArgs };
export type { Command, ParsedArgs };
