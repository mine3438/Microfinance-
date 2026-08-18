import { type Database } from '@mfi/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runForEveryInstitution } from '../src/jobs/run-for-every-institution.js';
import { PostgresPenaltyRepository } from '../src/modules/penalties/penalty-repository.js';
import { PostgresClassificationRepository } from '../src/modules/portfolio/classification-repository.js';
import { seedUser, startHarness, type Harness, type SeededUser } from './harness.js';

/**
 * The scheduled jobs.
 *
 * What matters here is not the work — each job's own work is tested where it
 * lives — but the failure semantics around it, which are the part that made the
 * system being replaced dangerous. Its classification job was scheduled by a
 * `pg_cron` line left commented out and nothing ever said so
 * (00-PROJECT-ANALYSIS.md R5).
 *
 * So: one institution failing must not stop the others, the process must still
 * end unsuccessfully, and every run must say what it did — including a run that
 * found nothing to do.
 */

let harness: Harness;
let institution: SeededUser;

beforeAll(async () => {
  harness = await startHarness();
  institution = await seedUser(harness.database, { roles: ['accountant'] });
});

afterAll(async () => {
  await harness.close();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Capture what a run wrote, without it reaching the test output. */
function captureOutput(): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  return { out, err };
}

describe('runForEveryInstitution', () => {
  it('carries on when one institution fails, and still exits non-zero', async () => {
    // Both halves matter. A cluster where one tenant has a broken book must
    // still have the rest of its work done; and a scheduler that cannot tell
    // success from failure is the commented-out cron line in a different
    // costume.
    const { out, err } = captureOutput();
    const seen: string[] = [];

    const code = await runForEveryInstitution(
      {
        name: 'Test job',
        institutionIds: () => Promise.resolve(['a', 'b', 'c']),
        forInstitution: (institutionId: string) => {
          seen.push(institutionId);
          if (institutionId === 'b') {
            return Promise.reject(new Error('book is broken'));
          }
          return Promise.resolve({ summary: `did ${institutionId}` });
        },
      },
      harness.database,
    );

    expect(seen).toEqual(['a', 'b', 'c']);
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('book is broken');
    expect(out.join('\n')).toContain('2 of 3 institution(s) processed');
  });

  it('exits zero when every institution succeeds', async () => {
    captureOutput();

    const code = await runForEveryInstitution(
      {
        name: 'Test job',
        institutionIds: () => Promise.resolve(['a']),
        forInstitution: () => Promise.resolve({ summary: 'done' }),
      },
      harness.database,
    );

    expect(code).toBe(0);
  });

  it('says so when it found nothing to do, rather than saying nothing', async () => {
    // A job whose only output is silence gives an operator nothing to notice
    // the absence of, which is how the original defect stayed invisible.
    const { out } = captureOutput();

    const code = await runForEveryInstitution(
      {
        name: 'Test job',
        institutionIds: () => Promise.resolve([]),
        forInstitution: () => Promise.resolve({ summary: 'unreachable' }),
      },
      harness.database,
    );

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('no institutions to process');
  });

  it('reports institutions that still need attention after a successful run', async () => {
    // Distinct from failure: a classification run leaving loans no band covers
    // has succeeded and still not made the return fileable.
    const { out } = captureOutput();

    const code = await runForEveryInstitution(
      {
        name: 'Test job',
        institutionIds: () => Promise.resolve(['a', 'b']),
        forInstitution: (institutionId: string) =>
          Promise.resolve({
            summary: `did ${institutionId}`,
            needsAttention: institutionId === 'a',
          }),
      },
      harness.database,
    );

    expect(code).toBe(0);
    expect(out.join('\n')).toContain('1 institution(s) still need attention');
  });
});

describe('what the jobs enumerate', () => {
  const idsFor = async (read: (database: Database) => Promise<string[]>): Promise<string[]> =>
    read(harness.database);

  it('both jobs cover the same institutions', async () => {
    // Penalty accrual and classification must not disagree about which tenants
    // exist; a book classified but never accrued is a book with wrong arrears.
    const classification = await idsFor((database) =>
      new PostgresClassificationRepository(database).listInstitutionIds(),
    );
    const penalties = await idsFor((database) =>
      new PostgresPenaltyRepository(database).listInstitutionIds(),
    );

    expect(penalties).toEqual(classification);
    expect(classification).toContain(institution.institutionId);
  });
});
