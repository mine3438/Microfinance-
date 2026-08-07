import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DuplicateMigrationVersionError, MalformedMigrationNameError } from './errors.js';
import {
  checksumOf,
  compareVersions,
  loadMigrations,
  parseMigrationFilename,
} from './migration-file.js';

describe('parseMigrationFilename', () => {
  it.each([
    ['0001_core_schema.sql', '0001', 'core_schema'],
    ['0042_add_branches.sql', '0042', 'add_branches'],
    ['00010_wider_version_pad.sql', '00010', 'wider_version_pad'],
    ['0007_msp2_03_provisioning.sql', '0007', 'msp2_03_provisioning'],
  ])('parses %s', (filename, version, name) => {
    expect(parseMigrationFilename(filename)).toEqual({ version, name });
  });

  it.each([
    ['001_too_few_digits.sql', 'fewer than four version digits'],
    ['0001-hyphen-separated.sql', 'hyphens instead of underscores'],
    ['0001_MixedCase.sql', 'uppercase in the name'],
    ['0001_trailing_underscore_.sql', 'a trailing underscore'],
    ['0001_double__underscore.sql', 'a doubled underscore'],
    ['core_schema.sql', 'no version prefix'],
    ['0001_core_schema.txt', 'the wrong extension'],
  ])('rejects %s (%s)', (filename) => {
    expect(() => parseMigrationFilename(filename)).toThrow(MalformedMigrationNameError);
  });
});

describe('checksumOf', () => {
  it('is stable for identical content', () => {
    expect(checksumOf('CREATE TABLE x ();')).toBe(checksumOf('CREATE TABLE x ();'));
  });

  it('changes when a single character changes', () => {
    expect(checksumOf('CREATE TABLE x ();')).not.toBe(checksumOf('CREATE TABLE y ();'));
  });

  it('is sensitive to whitespace, so reformatting an applied migration is detected', () => {
    expect(checksumOf('CREATE TABLE x ();')).not.toBe(checksumOf('CREATE TABLE  x ();'));
  });

  it('produces a 64-character hex digest', () => {
    expect(checksumOf('anything')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('compareVersions', () => {
  it('orders numerically rather than lexicographically across padding widths', () => {
    // Plain string comparison would put '00010' before '0009'.
    expect(compareVersions('0009', '00010')).toBeLessThan(0);
  });

  it('treats equal versions as equal', () => {
    expect(compareVersions('0005', '0005')).toBe(0);
  });

  it('orders ordinary same-width versions', () => {
    expect(compareVersions('0002', '0001')).toBeGreaterThan(0);
  });
});

describe('loadMigrations', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mfi-migrations-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const write = async (filename: string, sql: string): Promise<void> => {
    await writeFile(join(dir, filename), sql, 'utf8');
  };

  it('returns migrations in version order regardless of directory order', async () => {
    await write('0003_third.sql', 'SELECT 3;');
    await write('0001_first.sql', 'SELECT 1;');
    await write('0002_second.sql', 'SELECT 2;');

    const migrations = await loadMigrations(dir);

    expect(migrations.map((migration) => migration.version)).toEqual(['0001', '0002', '0003']);
  });

  it('orders across differing padding widths', async () => {
    await write('00010_tenth.sql', 'SELECT 10;');
    await write('0009_ninth.sql', 'SELECT 9;');

    const migrations = await loadMigrations(dir);

    expect(migrations.map((migration) => migration.version)).toEqual(['0009', '00010']);
  });

  it('ignores non-SQL files so a directory README can sit alongside migrations', async () => {
    await write('0001_first.sql', 'SELECT 1;');
    await writeFile(join(dir, 'README.md'), '# Migrations', 'utf8');

    const migrations = await loadMigrations(dir);

    expect(migrations).toHaveLength(1);
  });

  it('rejects a malformed SQL filename rather than silently skipping it', async () => {
    await write('0001_first.sql', 'SELECT 1;');
    await write('oops.sql', 'SELECT 2;');

    await expect(loadMigrations(dir)).rejects.toThrow(MalformedMigrationNameError);
  });

  it('rejects duplicate versions, since apply order would be ambiguous', async () => {
    await write('0001_first.sql', 'SELECT 1;');
    await write('0001_also_first.sql', 'SELECT 2;');

    await expect(loadMigrations(dir)).rejects.toThrow(DuplicateMigrationVersionError);
  });

  it('computes a checksum over the file contents', async () => {
    await write('0001_first.sql', 'SELECT 1;');

    const [migration] = await loadMigrations(dir);

    expect(migration?.checksum).toBe(checksumOf('SELECT 1;'));
  });

  it('detects the no-transaction opt-out marker', async () => {
    await write('0001_plain.sql', 'SELECT 1;');
    await write(
      '0002_concurrent.sql',
      '-- mfi:no-transaction\nCREATE INDEX CONCURRENTLY i ON t(c);',
    );

    const migrations = await loadMigrations(dir);

    expect(migrations[0]?.runOutsideTransaction).toBe(false);
    expect(migrations[1]?.runOutsideTransaction).toBe(true);
  });

  it('returns an empty list for a directory with no migrations', async () => {
    await expect(loadMigrations(dir)).resolves.toEqual([]);
  });
});
