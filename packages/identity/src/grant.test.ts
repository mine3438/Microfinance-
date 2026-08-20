import { describe, expect, it } from 'vitest';

import { canGrantRole } from './permissions.js';
import type { Permission, Principal } from './permissions.js';

/**
 * The no-escalation invariant.
 *
 * Without it, `user.invite` is silently equal to every permission in the
 * catalogue: anybody holding it could mint an account with more authority than
 * their own and then sign in as it. That makes this one of the few checks in
 * the system whose absence would not show up as a bug in any feature — only as
 * an attack.
 */

const principalWith = (permissions: Permission[]): Principal => ({
  userId: '018f0000-0000-7000-8000-000000000001',
  institutionId: '018f0000-0000-7000-8000-0000000000ff',
  branchId: null,
  roles: [],
  permissions: new Set(permissions),
});

describe('canGrantRole', () => {
  it('permits a role whose permissions the granter already holds', () => {
    const granter = principalWith(['user.invite', 'client.read', 'loan.read']);

    expect(canGrantRole(granter, ['client.read', 'loan.read'])).toBe(true);
  });

  it('permits a role identical to the granter’s own authority', () => {
    const granter = principalWith(['client.read', 'loan.read']);

    expect(canGrantRole(granter, ['client.read', 'loan.read'])).toBe(true);
  });

  it('refuses a role carrying one permission the granter lacks', () => {
    const granter = principalWith(['user.invite', 'client.read']);

    // The single missing permission is the whole point: a subset check that
    // passed on "mostly overlaps" would grant loan approval to someone who
    // cannot approve a loan.
    expect(canGrantRole(granter, ['client.read', 'loan.approve'])).toBe(false);
  });

  it('refuses a strictly greater role even when the granter may invite', () => {
    // The escalation this exists to stop, stated directly: a branch manager
    // holding user.invite must not be able to create an administrator and use
    // it to become one.
    const branchManager = principalWith(['user.invite', 'client.read', 'loan.approve']);
    const administrator: Permission[] = ['client.read', 'loan.approve', 'settings.manage'];

    expect(canGrantRole(branchManager, administrator)).toBe(false);
  });

  it('permits a role that grants nothing', () => {
    // Vacuous truth, and correct: a role conferring no permission confers no
    // authority the granter could fail to hold.
    expect(canGrantRole(principalWith([]), [])).toBe(true);
  });

  it('refuses everything when the granter holds nothing', () => {
    expect(canGrantRole(principalWith([]), ['client.read'])).toBe(false);
  });
});
