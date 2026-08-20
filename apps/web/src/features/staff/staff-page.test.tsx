import {
  type Branch,
  type CreateInvitationRequest,
  type CreatedInvitation,
  type Invitation,
  type StaffMember,
  type UpdateStaffRequest,
} from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Staff management.
 *
 * Two things matter most here and neither is layout. The invitation link is
 * shown once and must actually be readable — it is the delivery mechanism, not
 * a debugging aid. And an administrator must not be offered a control that
 * would lock them out of their own institution.
 */

const list = vi.fn<() => Promise<StaffMember[]>>();
const invitations = vi.fn<() => Promise<Invitation[]>>();
const invite = vi.fn<(request: CreateInvitationRequest) => Promise<CreatedInvitation>>();
const revoke = vi.fn<(id: string) => Promise<Invitation>>();
const update = vi.fn<(id: string, request: UpdateStaffRequest) => Promise<StaffMember>>();
const listBranches = vi.fn<() => Promise<Branch[]>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  staff: {
    list: (): Promise<StaffMember[]> => list(),
    invitations: (): Promise<Invitation[]> => invitations(),
    invite: (request: CreateInvitationRequest): Promise<CreatedInvitation> => invite(request),
    revoke: (id: string): Promise<Invitation> => revoke(id),
    update: (id: string, request: UpdateStaffRequest): Promise<StaffMember> => update(id, request),
  },
  branches: {
    list: (): Promise<Branch[]> => listBranches(),
  },
}));

let permissions = new Set<string>(['user.read', 'user.invite', 'user.manage']);
const SELF_ID = '018f0000-0000-7000-8000-00000000aaaa';

vi.mock('../auth/session.js', () => ({
  useSession: (): {
    can: (permission: string) => boolean;
    user: { id: string; branch: { id: string; name: string } | null } | null;
  } => ({
    can: (permission: string) => permissions.has(permission),
    user: { id: SELF_ID, branch: null },
  }),
}));

const { StaffPage } = await import('./staff-page.js');

const member = (overrides: Partial<StaffMember> = {}): StaffMember => ({
  id: '018f0000-0000-7000-8000-00000000bbbb',
  fullName: 'Asha Mrema',
  email: 'asha@example.test',
  branchId: null,
  branchName: 'Moshi Branch',
  roles: ['loan_officer'],
  status: 'active',
  lastLoginAt: '2026-08-01T09:00:00.000Z',
  createdAt: '2026-07-01T09:00:00.000Z',
  ...overrides,
});

const invitation = (overrides: Partial<Invitation> = {}): Invitation => ({
  id: '018f0000-0000-7000-8000-00000000cccc',
  email: 'neema@example.test',
  fullName: 'Neema Joseph',
  roleCode: 'loan_officer',
  branchId: null,
  branchName: null,
  state: 'pending',
  invitedBy: SELF_ID,
  invitedByName: 'Grace Mwita',
  expiresAt: '2026-09-01T00:00:00.000Z',
  acceptedAt: null,
  revokedAt: null,
  createdAt: '2026-08-20T00:00:00.000Z',
  ...overrides,
});

function renderPage(): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <StaffPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  permissions = new Set(['user.read', 'user.invite', 'user.manage']);
  list.mockResolvedValue([member()]);
  invitations.mockResolvedValue([invitation()]);
  listBranches.mockResolvedValue([]);
  update.mockResolvedValue(member({ status: 'suspended' }));
  revoke.mockResolvedValue(invitation({ state: 'revoked' }));
  invite.mockResolvedValue({
    invitation: invitation(),
    delivery: 'manual',
    link: 'http://localhost:5173/accept-invitation?token=THE-TOKEN',
  });
});

describe('the staff list', () => {
  it('shows who works here and how they stand', async () => {
    renderPage();

    expect(await screen.findByRole('cell', { name: 'Asha Mrema' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Active' })).toBeInTheDocument();
  });

  it('says institution-wide rather than leaving the branch blank', async () => {
    list.mockResolvedValue([member({ branchName: null })]);
    renderPage();

    expect(await screen.findByRole('cell', { name: 'Institution-wide' })).toBeInTheDocument();
  });

  it('offers no suspend control for the signed-in administrator', async () => {
    // A name that appears nowhere else on the screen: "Invited by" also renders
    // names, and a collision would make this assertion pass for the wrong row.
    list.mockResolvedValue([member({ id: SELF_ID, fullName: 'Signed In Administrator' })]);
    renderPage();

    await screen.findByRole('cell', { name: 'Signed In Administrator' });

    // The server refuses it too. Offering a button whose only outcome is a
    // refusal teaches the user that refusals are noise.
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });

  it('suspends somebody else', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Suspend' }));

    expect(update).toHaveBeenCalledWith(member().id, { status: 'suspended' });
  });

  it('offers restore rather than suspend for a suspended account', async () => {
    list.mockResolvedValue([member({ status: 'suspended' })]);
    renderPage();

    expect(await screen.findByRole('button', { name: 'Restore' })).toBeInTheDocument();
  });

  it('offers nothing to act on for somebody who has not accepted yet', async () => {
    list.mockResolvedValue([member({ status: 'invited', lastLoginAt: null })]);
    renderPage();

    expect(await screen.findByRole('cell', { name: 'Invited' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Suspend' })).not.toBeInTheDocument();
  });
});

describe('inviting', () => {
  it('shows the link once, because that is how the invitation is delivered', async () => {
    renderPage();
    await screen.findByRole('cell', { name: 'Asha Mrema' });

    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    await userEvent.type(screen.getByLabelText('Full name'), 'Neema Joseph');
    await userEvent.type(screen.getByLabelText('Email'), 'neema@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    // No supplied document names an email provider, so the API's default
    // mechanism hands the link back to the administrator to convey. If the
    // screen did not show it, nothing would have been delivered at all.
    expect(
      await screen.findByText('http://localhost:5173/accept-invitation?token=THE-TOKEN'),
    ).toBeInTheDocument();
  });

  it('sends a null branch for institution-wide rather than omitting the field', async () => {
    renderPage();
    await screen.findByRole('cell', { name: 'Asha Mrema' });

    await userEvent.click(screen.getByRole('button', { name: 'Invite someone' }));
    await userEvent.type(screen.getByLabelText('Full name'), 'Neema Joseph');
    await userEvent.type(screen.getByLabelText('Email'), 'neema@example.test');
    await userEvent.click(screen.getByRole('button', { name: 'Create invitation' }));

    expect(invite).toHaveBeenCalledWith({
      email: 'neema@example.test',
      fullName: 'Neema Joseph',
      roleCode: 'loan_officer',
      branchId: null,
    });
  });

  it('does not offer the panel to somebody who cannot invite', async () => {
    permissions = new Set(['user.read']);
    renderPage();

    await screen.findByRole('cell', { name: 'Asha Mrema' });
    expect(screen.queryByRole('button', { name: 'Invite someone' })).not.toBeInTheDocument();
  });
});

describe('invitations', () => {
  it('lists who was asked, by whom, and how it stands', async () => {
    renderPage();

    const row = await screen.findByRole('row', { name: /Neema Joseph/ });
    expect(within(row).getByText('Awaiting acceptance')).toBeInTheDocument();
    expect(within(row).getByRole('cell', { name: 'Grace Mwita' })).toBeInTheDocument();
  });

  it('withdraws a pending invitation', async () => {
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: 'Withdraw' }));

    expect(revoke).toHaveBeenCalledWith(invitation().id);
  });

  it('offers no withdrawal once an invitation is spent', async () => {
    invitations.mockResolvedValue([invitation({ state: 'accepted' })]);
    renderPage();

    await screen.findByRole('row', { name: /Neema Joseph/ });
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });

  it('distinguishes withdrawn from expired, because one was a decision', async () => {
    invitations.mockResolvedValue([
      invitation({ state: 'revoked' }),
      invitation({ id: 'other', fullName: 'Rehema Paul', state: 'expired' }),
    ]);
    renderPage();

    expect(await screen.findByText('Withdrawn')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
  });
});
