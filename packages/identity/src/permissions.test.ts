import { describe, expect, it } from 'vitest';

import {
  PERMISSIONS,
  ROLES,
  can,
  canActOnBranch,
  canAll,
  canAny,
  canApproveWorkOf,
  isPermission,
  isRoleCode,
  type Permission,
  type Principal,
} from './permissions.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  userId: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa',
  institutionId: '11111111-1111-7111-8111-111111111111',
  branchId: null,
  roles: ['loan_officer'],
  permissions: new Set<Permission>(['loan.read', 'loan.create']),
  ...overrides,
});

describe('the catalogue', () => {
  it('has no duplicate permissions', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it('has no duplicate roles', () => {
    expect(new Set(ROLES).size).toBe(ROLES.length);
  });

  it('names every permission as resource.action', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('narrows a known permission and rejects an unknown one', () => {
    expect(isPermission('loan.approve')).toBe(true);
    expect(isPermission('loan.obliterate')).toBe(false);
  });

  it('narrows a known role and rejects an unknown one', () => {
    expect(isRoleCode('branch_manager')).toBe(true);
    expect(isRoleCode('superuser')).toBe(false);
  });
});

describe('permission checks', () => {
  it('grants what the principal holds', () => {
    expect(can(principal(), 'loan.create')).toBe(true);
  });

  it('denies what the principal does not hold', () => {
    expect(can(principal(), 'loan.approve')).toBe(false);
  });

  it('requires every permission for canAll', () => {
    expect(canAll(principal(), ['loan.read', 'loan.create'])).toBe(true);
    expect(canAll(principal(), ['loan.read', 'loan.approve'])).toBe(false);
  });

  it('requires only one permission for canAny', () => {
    expect(canAny(principal(), ['loan.approve', 'loan.create'])).toBe(true);
    expect(canAny(principal(), ['loan.approve', 'settings.manage'])).toBe(false);
  });

  it('denies everything to a principal with no permissions', () => {
    const stripped = principal({ permissions: new Set() });

    expect(PERMISSIONS.every((permission) => !can(stripped, permission))).toBe(true);
    expect(canAny(stripped, [...PERMISSIONS])).toBe(false);
  });

  it('treats canAll over an empty list as vacuously true', () => {
    expect(canAll(principal(), [])).toBe(true);
  });

  it('treats canAny over an empty list as false', () => {
    // Nothing was asked for, so nothing was granted. The opposite convention
    // would let an empty requirement list authorise an action by accident.
    expect(canAny(principal(), [])).toBe(false);
  });
});

describe('branch scope', () => {
  const BRANCH_A = 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb';
  const BRANCH_B = 'cccccccc-cccc-7ccc-8ccc-cccccccccccc';

  it('lets an institution-wide principal act on any branch', () => {
    const admin = principal({ branchId: null });

    expect(canActOnBranch(admin, BRANCH_A)).toBe(true);
    expect(canActOnBranch(admin, BRANCH_B)).toBe(true);
    expect(canActOnBranch(admin, null)).toBe(true);
  });

  it('confines a branch-assigned principal to their own branch', () => {
    // Row-level security scopes by institution, not by branch, so this is the
    // only layer enforcing the narrower boundary.
    const officer = principal({ branchId: BRANCH_A });

    expect(canActOnBranch(officer, BRANCH_A)).toBe(true);
    expect(canActOnBranch(officer, BRANCH_B)).toBe(false);
  });

  it('denies a branch-assigned principal access to unbranched data', () => {
    const officer = principal({ branchId: BRANCH_A });

    expect(canActOnBranch(officer, null)).toBe(false);
  });
});

describe('segregation of duties', () => {
  const MAKER = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
  const APPROVER = 'eeeeeeee-eeee-7eee-8eee-eeeeeeeeeeee';

  const approver = (userId: string): Principal =>
    principal({
      userId,
      roles: ['branch_manager'],
      permissions: new Set<Permission>(['loan.approve']),
    });

  it('lets a different user with the permission approve', () => {
    expect(canApproveWorkOf(approver(APPROVER), MAKER)).toBe(true);
  });

  it('refuses to let a user approve their own work', () => {
    // The control that makes maker-checker a control. Enforced in the domain
    // rather than in a controller, because the interface is not the only way in.
    expect(canApproveWorkOf(approver(MAKER), MAKER)).toBe(false);
  });

  it('refuses a different user who lacks the approval permission', () => {
    const officer = principal({ userId: APPROVER });

    expect(canApproveWorkOf(officer, MAKER)).toBe(false);
  });

  it('refuses even an administrator approving their own application', () => {
    // Holding every permission does not exempt someone from segregation of
    // duties: the point is that two people looked at it, not that one person
    // was senior enough.
    const admin = principal({
      userId: MAKER,
      roles: ['institution_admin'],
      permissions: new Set<Permission>([...PERMISSIONS]),
    });

    expect(canApproveWorkOf(admin, MAKER)).toBe(false);
  });
});
