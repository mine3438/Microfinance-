import { PERMISSIONS, type Permission, type Principal } from '@mfi/identity';
import { Money } from '@mfi/money';
import { describe, expect, it } from 'vitest';

import { assessApproval, type ApprovalRequest } from './approval.js';

const OFFICER = 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa';
const MANAGER = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
const BRANCH_A = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';
const BRANCH_B = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: MANAGER,
  institutionId: '11111111-1111-7111-8111-111111111111',
  branchId: null,
  roles: ['branch_manager'],
  permissions: new Set<Permission>(['loan.approve']),
  ...overrides,
});

const request = (overrides: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  approver: principal(),
  submittedByUserId: OFFICER,
  branchId: BRANCH_A,
  principal: Money.of('1000000.00'),
  authority: { maxPrincipal: Money.of('5000000.00') },
  ...overrides,
});

describe('permitting an approval', () => {
  it('permits a different user with authority for the amount', () => {
    expect(assessApproval(request())).toEqual({ permitted: true });
  });

  it('permits an amount exactly at the limit', () => {
    const assessment = assessApproval(
      request({
        principal: Money.of('5000000.00'),
        authority: { maxPrincipal: Money.of('5000000.00') },
      }),
    );

    expect(assessment.permitted).toBe(true);
  });

  it('permits a branch-scoped approver within their own branch', () => {
    const assessment = assessApproval(
      request({ approver: principal({ branchId: BRANCH_A }), branchId: BRANCH_A }),
    );

    expect(assessment.permitted).toBe(true);
  });
});

describe('refusing an approval', () => {
  it('refuses a role without loan.approve', () => {
    const assessment = assessApproval(
      request({ approver: principal({ permissions: new Set<Permission>(['loan.create']) }) }),
    );

    expect(assessment).toMatchObject({ permitted: false, reason: 'lacks_permission' });
  });

  it('refuses the person who submitted the application', () => {
    const assessment = assessApproval(
      request({ approver: principal({ userId: OFFICER }), submittedByUserId: OFFICER }),
    );

    expect(assessment).toMatchObject({ permitted: false, reason: 'self_approval' });
  });

  it('refuses self-approval even by an administrator holding every permission', () => {
    // Seniority is not a substitute for a second pair of eyes.
    const assessment = assessApproval(
      request({
        approver: principal({
          userId: OFFICER,
          roles: ['institution_admin'],
          permissions: new Set<Permission>([...PERMISSIONS]),
        }),
        submittedByUserId: OFFICER,
      }),
    );

    expect(assessment).toMatchObject({ permitted: false, reason: 'self_approval' });
  });

  it('refuses self-approval before considering the amount', () => {
    // Ordering matters for the message the officer sees: no threshold makes it
    // acceptable for the maker to be the checker, so that is the reason given.
    const assessment = assessApproval(
      request({
        approver: principal({ userId: OFFICER }),
        submittedByUserId: OFFICER,
        principal: Money.of('99999999.00'),
      }),
    );

    expect(assessment).toMatchObject({ reason: 'self_approval' });
  });

  it('refuses a branch-scoped approver reaching into another branch', () => {
    const assessment = assessApproval(
      request({ approver: principal({ branchId: BRANCH_A }), branchId: BRANCH_B }),
    );

    expect(assessment).toMatchObject({ permitted: false, reason: 'outside_branch' });
  });

  it('refuses an amount above the approver’s limit', () => {
    const assessment = assessApproval(
      request({
        principal: Money.of('5000000.01'),
        authority: { maxPrincipal: Money.of('5000000.00') },
      }),
    );

    expect(assessment).toMatchObject({ permitted: false, reason: 'exceeds_authority' });
  });

  it('states both figures, so the officer knows who to escalate to', () => {
    const assessment = assessApproval(
      request({
        principal: Money.of('9000000.00'),
        authority: { maxPrincipal: Money.of('5000000.00') },
      }),
    );

    expect(assessment.permitted).toBe(false);
    if (!assessment.permitted) {
      expect(assessment.message).toContain('5000000.00');
      expect(assessment.message).toContain('9000000.00');
    }
  });
});

describe('an unconfigured limit grants nothing', () => {
  it('refuses any amount when no threshold is set', () => {
    // Failing closed. The opposite reading — that an unconfigured limit means
    // unlimited — hands every role the power to sanction any amount the moment
    // someone forgets to configure one.
    const assessment = assessApproval(request({ authority: { maxPrincipal: null } }));

    expect(assessment).toMatchObject({ permitted: false, reason: 'exceeds_authority' });
  });

  it('refuses even the smallest amount when no threshold is set', () => {
    const assessment = assessApproval(
      request({ principal: Money.of('0.01'), authority: { maxPrincipal: null } }),
    );

    expect(assessment.permitted).toBe(false);
  });

  it('says how to fix it rather than only that it failed', () => {
    const assessment = assessApproval(request({ authority: { maxPrincipal: null } }));

    expect(assessment.permitted).toBe(false);
    if (!assessment.permitted) {
      expect(assessment.message).toMatch(/No approval limit is configured/);
    }
  });
});
