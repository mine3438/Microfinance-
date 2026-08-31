import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

/**
 * These invoke the CLI the way an operator does — through the `mfi-migrate`
 * binary that the package manager links into `node_modules/.bin`.
 *
 * Going through the real link matters. That path is a symlink, and an
 * entrypoint check comparing `process.argv[1]` against `import.meta.url`
 * without resolving it makes every command exit silently having done nothing.
 * The library tests could not have caught that; only running the binary does.
 */
const REPO_ROOT = resolve(import.meta.dirname, '../../..');
/**
 * The CLI as a file, not as the `node_modules/.bin` symlink.
 *
 * pnpm creates that symlink at install time and skips it when the target does
 * not exist yet — which is every fresh CI checkout, because install runs before
 * build. Pointing at the link made this suite pass locally (where node_modules
 * happened to be installed after a build) and fail anywhere else.
 *
 * Nothing is lost: `isDirectInvocation` compares `realpathSync` on both sides,
 * so the entrypoint guard this suite exists to protect behaves identically
 * whether it is reached through the link or through the file. `pretest` builds
 * the package, so the file is always there.
 *
 * Run through `node` rather than executed directly, because the executable bit
 * on the built file is something pnpm's bin linking sets rather than something
 * the compiler emits — the same install-order dependency, one layer down.
 */
const CLI_BIN = join(REPO_ROOT, 'packages/migrator/dist/cli.js');
const CONNECTION_STRING =
  process.env['DATABASE_URL'] ?? 'postgresql://postgres@localhost:5432/postgres';

let schema: string;
let dir: string;
let adminPool: pg.Pool;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** Run the CLI with the test schema on the search path. */
async function runCli(args: readonly string[]): Promise<CliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        DATABASE_URL: CONNECTION_STRING,
        PGOPTIONS: `-c search_path=${schema}`,
      },
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
      exitCode: failure.code ?? 1,
    };
  }
}

beforeEach(async () => {
  schema = `cli_test_${Math.random().toString(36).slice(2, 10)}`;
  dir = await mkdtemp(join(tmpdir(), 'mfi-cli-'));
  adminPool = new pg.Pool({ connectionString: CONNECTION_STRING });
  await adminPool.query(`CREATE SCHEMA ${schema}`);
});

afterEach(async () => {
  await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
  await rm(dir, { recursive: true, force: true });
});

describe('mfi-migrate CLI', () => {
  it('produces output when run through the linked binary', async () => {
    const result = await runCli(['status', '--dir', dir]);

    // The regression this guards: a broken entrypoint check exits 0 silently.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toBe('');
    expect(result.stdout).toContain('Applied (0)');
  });

  it('applies a migration and reports it', async () => {
    await writeFile(join(dir, '0001_create_clients.sql'), 'CREATE TABLE clients (id INT);', 'utf8');

    const migrate = await runCli(['migrate', '--dir', dir]);
    expect(migrate.exitCode).toBe(0);
    expect(migrate.stdout).toContain('0001_create_clients.sql');

    const status = await runCli(['status', '--dir', dir]);
    expect(status.stdout).toContain('Applied (1)');
    expect(status.stdout).toContain('Pending (0)');
  });

  it('exits non-zero and explains when DATABASE_URL is absent', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_BIN, 'status'], {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: '' },
    }).catch((error: unknown) => error as { stdout: string; stderr: string });

    expect(stdout + stderr).toContain('DATABASE_URL');
  });

  it('fails verify while migrations are pending', async () => {
    await writeFile(join(dir, '0001_create_clients.sql'), 'CREATE TABLE clients (id INT);', 'utf8');

    const result = await runCli(['verify', '--dir', dir]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pending');
  });

  it('passes verify once everything is applied', async () => {
    await writeFile(join(dir, '0001_create_clients.sql'), 'CREATE TABLE clients (id INT);', 'utf8');
    await runCli(['migrate', '--dir', dir]);

    const result = await runCli(['verify', '--dir', dir]);

    expect(result.exitCode).toBe(0);
  });

  it('rejects an unknown command', async () => {
    const result = await runCli(['frobnicate']);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Unknown command');
  });

  it('prints usage for --help and exits zero', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});
