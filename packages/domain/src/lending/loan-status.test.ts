import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  LOAN_STATUSES,
  LOAN_TRANSITIONS,
  TERMINAL_LOAN_STATUSES,
  assertTransition,
  canTransition,
  isDisbursed,
  isLoanStatus,
  isOutstanding,
  type LoanStatus,
} from './loan-status.js';

describe('the transition table', () => {
  it('covers every status', () => {
    expect(Object.keys(LOAN_TRANSITIONS).sort()).toEqual([...LOAN_STATUSES].sort());
  });

  it('only ever points at statuses that exist', () => {
    for (const targets of Object.values(LOAN_TRANSITIONS)) {
      for (const target of targets) {
        expect(isLoanStatus(target)).toBe(true);
      }
    }
  });

  it('reaches every status from draft, so none is stranded', () => {
    // A status nothing can reach is dead code in the schema and a trap for a
    // future reader who assumes it is used.
    const reached = new Set<LoanStatus>(['draft']);
    let grew = true;
    while (grew) {
      grew = false;
      for (const status of [...reached]) {
        for (const next of LOAN_TRANSITIONS[status]) {
          if (!reached.has(next)) {
            reached.add(next);
            grew = true;
          }
        }
      }
    }

    expect([...reached].sort()).toEqual([...LOAN_STATUSES].sort());
  });

  it('identifies the terminal statuses', () => {
    expect([...TERMINAL_LOAN_STATUSES].sort()).toEqual(['completed', 'rejected', 'written_off']);
  });
});

describe('permitted moves', () => {
  it.each([
    ['draft', 'pending_approval'],
    ['pending_approval', 'approved'],
    ['pending_approval', 'rejected'],
    ['approved', 'active'],
    ['active', 'completed'],
    ['active', 'written_off'],
  ] as [LoanStatus, LoanStatus][])('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(() => {
      assertTransition(from, to);
    }).not.toThrow();
  });
});

describe('refused moves', () => {
  it('refuses skipping approval entirely', () => {
    // The whole point of the workflow: money cannot be advanced on an
    // application nobody sanctioned.
    expect(canTransition('draft', 'active')).toBe(false);
    expect(canTransition('pending_approval', 'active')).toBe(false);
  });

  it('refuses disbursing a rejected application', () => {
    expect(canTransition('rejected', 'active')).toBe(false);
  });

  it('refuses reviving a terminal status', () => {
    for (const terminal of TERMINAL_LOAN_STATUSES) {
      for (const target of LOAN_STATUSES) {
        expect(canTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('refuses returning a rejected application to draft, for now', () => {
    // Terminal by decision, not by oversight. Whether a declined application
    // may be reworked is unanswered (§13.3); keeping it terminal preserves the
    // rejection on the record and makes re-application a fresh case with its
    // own approval trail.
    expect(canTransition('rejected', 'draft')).toBe(false);
  });

  it('refuses writing off a loan that was never disbursed', () => {
    expect(canTransition('approved', 'written_off')).toBe(false);
  });

  it('names the legal alternatives when it refuses', () => {
    expect(() => {
      assertTransition('draft', 'active');
    }).toThrow(/only become pending_approval/);
    expect(() => {
      assertTransition('completed', 'active');
    }).toThrow(/terminal/);
  });

  it('throws a domain error rather than a bare Error', () => {
    expect(() => {
      assertTransition('draft', 'completed');
    }).toThrow(DomainValidationError);
  });
});

describe('portfolio classification', () => {
  it('counts only active loans as outstanding', () => {
    // MSP2-01's loans-to-clients line and MSP2-03's sectoral classification
    // both report what is still owed. An approved but undisbursed loan must not
    // appear — no money has left the institution.
    expect(isOutstanding('active')).toBe(true);
    for (const status of LOAN_STATUSES.filter((value) => value !== 'active')) {
      expect(isOutstanding(status)).toBe(false);
    }
  });

  it('treats every post-disbursement status as disbursed', () => {
    const disbursed: LoanStatus[] = ['active', 'completed', 'written_off'];
    const notDisbursed: LoanStatus[] = ['draft', 'pending_approval', 'approved', 'rejected'];

    expect(disbursed.every(isDisbursed)).toBe(true);
    expect(notDisbursed.some(isDisbursed)).toBe(false);
  });

  it('narrows an arbitrary string', () => {
    expect(isLoanStatus('active')).toBe(true);
    expect(isLoanStatus('paid')).toBe(false);
  });
});
