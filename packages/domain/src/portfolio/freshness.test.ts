import { describe, expect, it } from 'vitest';

import { DomainValidationError } from '../errors.js';
import {
  MAXIMUM_CLASSIFICATION_AGE_HOURS,
  assessReportingReadiness,
  type ReadinessRequest,
} from './freshness.js';

const NOW = new Date('2026-08-07T12:00:00.000Z');
const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const request = (overrides: Partial<ReadinessRequest> = {}): ReadinessRequest => ({
  classificationsUpdatedAt: hoursAgo(1),
  unclassifiableLoanCount: 0,
  now: NOW,
  ...overrides,
});

describe('ready to file', () => {
  it('permits generation when classifications are fresh and complete', () => {
    expect(assessReportingReadiness(request())).toEqual({ ready: true });
  });

  it('permits generation right up to the age limit', () => {
    const assessment = assessReportingReadiness(
      request({ classificationsUpdatedAt: hoursAgo(MAXIMUM_CLASSIFICATION_AGE_HOURS) }),
    );

    expect(assessment.ready).toBe(true);
  });
});

describe('stale classifications block generation', () => {
  it('refuses once past the age limit', () => {
    // The defect this exists to prevent: the previous system's classification
    // job was scheduled by a pg_cron line left commented out, so no loan's
    // classification ever changed after creation. A loan forty days overdue
    // kept reporting "Current" to the dashboard and to the Bank of Tanzania.
    const assessment = assessReportingReadiness(
      request({ classificationsUpdatedAt: hoursAgo(MAXIMUM_CLASSIFICATION_AGE_HOURS + 1) }),
    );

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems[0]?.problem).toBe('classifications_stale');
    }
  });

  it('blocks outright rather than warning', () => {
    // A warning beside a report is a warning somebody files anyway. A
    // compliance product that quietly files wrong numbers is worse than one
    // that refuses to file.
    const assessment = assessReportingReadiness(
      request({ classificationsUpdatedAt: hoursAgo(72) }),
    );

    expect(assessment.ready).toBe(false);
  });

  it('says how stale, so the operator knows whether the job is broken or merely late', () => {
    const assessment = assessReportingReadiness(
      request({ classificationsUpdatedAt: hoursAgo(72) }),
    );

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems[0]?.message).toContain('72 hours ago');
    }
  });

  it('refuses when classifications have never run at all', () => {
    const assessment = assessReportingReadiness(request({ classificationsUpdatedAt: null }));

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems[0]?.problem).toBe('never_classified');
    }
  });
});

describe('unclassifiable loans block generation', () => {
  it('refuses while any loan falls outside every band', () => {
    // MSP2-03 has no unclassified column, so such a loan cannot be placed on
    // the return at all.
    const assessment = assessReportingReadiness(request({ unclassifiableLoanCount: 3 }));

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems[0]?.problem).toBe('unclassifiable_loans');
      expect(assessment.problems[0]?.message).toContain('§11.5');
    }
  });

  it('reports every problem at once rather than one at a time', () => {
    // An operator fixing these should see the whole list, not discover the
    // second only after resolving the first.
    const assessment = assessReportingReadiness(
      request({ classificationsUpdatedAt: null, unclassifiableLoanCount: 2 }),
    );

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems.map((entry) => entry.problem)).toEqual([
        'never_classified',
        'unclassifiable_loans',
      ]);
    }
  });
});

describe('branches without a district', () => {
  it('permits generation while every active branch is located', () => {
    expect(assessReportingReadiness(request({ unlocatedBranchCount: 0 }))).toEqual({ ready: true });
  });

  it('refuses while any active branch has no district', () => {
    // MSP2-10 reports branches and employees per district. A branch in no
    // district is counted in none of them, so the filed branch total is short
    // by one and nothing on the form says so.
    const assessment = assessReportingReadiness(request({ unlocatedBranchCount: 2 }));

    expect(assessment.ready).toBe(false);
    if (!assessment.ready) {
      expect(assessment.problems.map((entry) => entry.problem)).toEqual(['unlocated_branches']);
      expect(assessment.problems[0]?.message).toContain('2 active branch');
    }
  });

  it('treats an absent count as none, so the loan-book checks stand alone', () => {
    expect(assessReportingReadiness(request())).toEqual({ ready: true });
  });
});

describe('rejected input', () => {
  it('refuses a non-positive age limit', () => {
    expect(() => assessReportingReadiness(request({ maximumAgeHours: 0 }))).toThrow(
      DomainValidationError,
    );
  });

  it('refuses a negative unclassifiable count', () => {
    expect(() => assessReportingReadiness(request({ unclassifiableLoanCount: -1 }))).toThrow(
      DomainValidationError,
    );
  });

  it('refuses a negative unlocated branch count', () => {
    expect(() => assessReportingReadiness(request({ unlocatedBranchCount: -1 }))).toThrow(
      DomainValidationError,
    );
  });
});
