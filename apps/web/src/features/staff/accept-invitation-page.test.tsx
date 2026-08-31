import { type InvitationPreview } from '@mfi/contracts';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Accepting an invitation.
 *
 * The screen is unauthenticated, so what is asserted here is mostly that it
 * refuses to guess: no token means no request, a dead link says so plainly
 * rather than showing an empty form, and the token never leaves the request
 * body.
 */

const preview = vi.fn<(token: string) => Promise<InvitationPreview>>();
const accept = vi.fn<(request: { token: string; password: string }) => Promise<void>>();

vi.mock('../../shared/api/endpoints.js', () => ({
  invitations: {
    preview: (token: string): Promise<InvitationPreview> => preview(token),
    accept: (request: { token: string; password: string }): Promise<void> => accept(request),
  },
}));

const { AcceptInvitationPage } = await import('./accept-invitation-page.js');

const invitation = (overrides: Partial<InvitationPreview> = {}): InvitationPreview => ({
  institutionName: 'Kilimanjaro Microfinance',
  fullName: 'Asha Mrema',
  email: 'asha@example.test',
  roleCode: 'loan_officer',
  branchName: 'Moshi Branch',
  expiresAt: '2026-09-01T00:00:00.000Z',
  ...overrides,
});

function renderPage(search: string): void {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/accept-invitation${search}`]}>
        <AcceptInvitationPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  preview.mockResolvedValue(invitation());
  accept.mockResolvedValue(undefined);
});

describe('before accepting', () => {
  it('shows what the invitee is joining', async () => {
    renderPage('?token=GOOD-TOKEN');

    expect(await screen.findByText('Join Kilimanjaro Microfinance')).toBeInTheDocument();
    expect(screen.getByText('Loan officer')).toBeInTheDocument();
    expect(screen.getByText('Moshi Branch')).toBeInTheDocument();
    expect(screen.getByText('asha@example.test')).toBeInTheDocument();
  });

  it('says so when the branch is institution-wide rather than showing a blank', async () => {
    preview.mockResolvedValue(invitation({ branchName: null }));
    renderPage('?token=GOOD-TOKEN');

    expect(await screen.findByText('Institution-wide')).toBeInTheDocument();
  });

  it('asks for the link rather than calling the API with no token', async () => {
    renderPage('');

    expect(await screen.findByText(/needs the link from your invitation/)).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });

  it('explains a dead link instead of offering a form that cannot work', async () => {
    preview.mockRejectedValue(new Error('That invitation link is no longer valid.'));
    renderPage('?token=DEAD-TOKEN');

    expect(await screen.findByText('This link cannot be used')).toBeInTheDocument();
    expect(screen.queryByLabelText('Choose a password')).not.toBeInTheDocument();
  });
});

describe('accepting', () => {
  it('sends the token from the URL with the chosen password', async () => {
    renderPage('?token=GOOD-TOKEN');
    await screen.findByText('Join Kilimanjaro Microfinance');

    await userEvent.type(screen.getByLabelText('Choose a password'), 'a good long passphrase');
    await userEvent.type(screen.getByLabelText('Type it again'), 'a good long passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Accept and set password' }));

    expect(accept).toHaveBeenCalledWith({
      token: 'GOOD-TOKEN',
      password: 'a good long passphrase',
    });
  });

  it('refuses to submit while the two passwords differ', async () => {
    renderPage('?token=GOOD-TOKEN');
    await screen.findByText('Join Kilimanjaro Microfinance');

    await userEvent.type(screen.getByLabelText('Choose a password'), 'a good long passphrase');
    await userEvent.type(screen.getByLabelText('Type it again'), 'a good long passphras');

    // Caught here rather than by the server, because the server cannot see the
    // second box — and a mistyped password on an account with no other way in
    // strands the invitee behind a password reset that does not exist yet.
    expect(screen.getByText('The two passwords do not match.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept and set password' })).toBeDisabled();
    expect(accept).not.toHaveBeenCalled();
  });

  it('sends them to sign in afterwards rather than pretending they have a session', async () => {
    renderPage('?token=GOOD-TOKEN');
    await screen.findByText('Join Kilimanjaro Microfinance');

    await userEvent.type(screen.getByLabelText('Choose a password'), 'a good long passphrase');
    await userEvent.type(screen.getByLabelText('Type it again'), 'a good long passphrase');
    await userEvent.click(screen.getByRole('button', { name: 'Accept and set password' }));

    // Acceptance issues no token: one code path issues every session in the
    // system, and it is the login endpoint.
    expect(await screen.findByText('Your account is ready')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/sign-in');
  });
});
