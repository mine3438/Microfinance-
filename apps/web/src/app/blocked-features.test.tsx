import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The two operations that must not be reachable from this application.
 *
 * These are source-level assertions rather than rendering ones, and that is
 * deliberate. A test that renders one screen proves that screen has no button;
 * it proves nothing about the screen somebody adds next week. What must hold is
 * a property of the whole client — *nowhere* calls these operations — and the
 * only way to check "nowhere" is to look at everywhere.
 *
 * Neither of these is a security control. The API is the boundary: group
 * lending has no endpoint at all, and restructuring's endpoints are not
 * mounted unless `RESTRUCTURING_ENABLED` is set, which production leaves off.
 * These tests exist so that a UI change cannot quietly become the first half of
 * exposing an operation whose reporting treatment nobody has decided.
 */

/**
 * `src/`, from the working directory rather than from `import.meta.url`.
 *
 * These tests run in the jsdom environment, where `import.meta.url` is an
 * `http:` URL served by Vite and carries no filesystem path at all. Vitest runs
 * with the package root as its working directory, and the first test below
 * fails loudly if that assumption ever stops holding.
 */
const SOURCE_ROOT = join(process.cwd(), 'src');

/** Every TypeScript source file in the client, excluding the tests themselves. */
function sourceFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }

    if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }

  return found;
}

const FILES = sourceFiles(SOURCE_ROOT);

function offendingFiles(pattern: RegExp): string[] {
  return FILES.filter((path) => pattern.test(readFileSync(path, 'utf8'))).map((path) =>
    path.slice(SOURCE_ROOT.length),
  );
}

describe('the client is worth checking at all', () => {
  it('found the source tree it means to search', () => {
    // Guards the two suites below: if the walk returned nothing, every
    // assertion in this file would pass vacuously and prove the opposite of
    // what it claims.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.some((path) => path.endsWith('routes.tsx'))).toBe(true);
  });
});

/**
 * RESTRUCT-06 — unresolved.
 *
 * A restructuring successor carries a disbursement date, and MSP2-09 counts
 * every loan disbursed in the quarter, while no cash moves in a restructuring.
 * Until BOT's treatment of a refinanced facility is decided, an institution
 * using this could file a return overstating disbursements.
 */
describe('restructuring is not exposed', () => {
  it('is not called from anywhere in the client', () => {
    expect(offendingFiles(/\brestructuring\s*[(:]/i)).toEqual([]);
  });

  it('has no endpoint binding, so there is nothing for a screen to call', () => {
    const endpoints = readFileSync(join(SOURCE_ROOT, 'shared/api/endpoints.ts'), 'utf8');

    expect(endpoints).not.toMatch(/loans\/\$\{[^}]*\}\/restructuring/);
    expect(endpoints).not.toMatch(/restructureLoan|loanRestructuringSchema/);
  });

  it('has no route', () => {
    expect(readFileSync(join(SOURCE_ROOT, 'app/routes.tsx'), 'utf8')).not.toMatch(/restructur/i);
  });

  it('has no navigation entry', () => {
    expect(readFileSync(join(SOURCE_ROOT, 'app/shell.tsx'), 'utf8')).not.toMatch(/restructur/i);
  });
});

/**
 * GROUP-05 — unresolved.
 *
 * Every MSP2 exposure query reaches a borrower's sector, gender, age and
 * district through `loans.client_id`. A group has none of them, so a group loan
 * would drop out of MSP2-03, 09 and 10 without saying so.
 */
describe('group lending is not exposed', () => {
  it('never sends a group identifier to a loan endpoint', () => {
    expect(offendingFiles(/groupId\s*:[^,\n]*\n?[^)]*\/loans/)).toEqual([]);
  });

  it('has no group-lending call in the endpoint bindings', () => {
    const endpoints = readFileSync(join(SOURCE_ROOT, 'shared/api/endpoints.ts'), 'utf8');

    expect(endpoints).not.toMatch(/groups\/\$\{[^}]*\}\/loans/);
    expect(endpoints).not.toMatch(/groupLoan/i);
  });

  it('has no group-lending route', () => {
    const routes = readFileSync(join(SOURCE_ROOT, 'app/routes.tsx'), 'utf8');

    expect(routes).not.toMatch(/groups\/:id\/loans/);
    expect(routes).not.toMatch(/GroupLoan/);
  });

  /**
   * The loan module knows nothing about groups.
   *
   * If a group identifier ever reaches loan code, the reporting problem
   * GROUP-05 describes has already been created regardless of what the screen
   * shows.
   */
  it('keeps groups out of the loan feature entirely', () => {
    const loanFiles = FILES.filter((path) => path.includes(join('features', 'loans')));

    expect(loanFiles.length).toBeGreaterThan(0);
    for (const path of loanFiles) {
      expect(readFileSync(path, 'utf8')).not.toMatch(/\bgroup/i);
    }
  });
});
