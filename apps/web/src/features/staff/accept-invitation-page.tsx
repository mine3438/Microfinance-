import { MINIMUM_PASSWORD_LENGTH, type RoleCode } from '@mfi/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { invitations as invitationsApi } from '../../shared/api/endpoints.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Spinner } from '../../shared/ui/spinner.js';

/**
 * Accepting an invitation.
 *
 * The only screen in the app reachable without a session, apart from sign-in.
 * The person here has no account yet — that is what they are about to create —
 * so nothing on this page may assume one.
 *
 * The token is read from the URL and sent in a request body, never appended to
 * an API URL. It stays in this browser's history because it arrived that way,
 * which is unavoidable for a link; what is avoidable is copying it into the
 * server's access log and into the `Referer` of every subsequent request, and
 * that is what posting it prevents.
 */

const ROLE_LABELS: Record<RoleCode, string> = {
  institution_admin: 'Administrator',
  branch_manager: 'Branch manager',
  loan_officer: 'Loan officer',
  accountant: 'Accountant',
  auditor: 'Auditor',
};

export function AcceptInvitationPage(): ReactNode {
  const [parameters] = useSearchParams();
  const token = parameters.get('token') ?? '';

  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [accepted, setAccepted] = useState(false);

  const preview = useQuery({
    queryKey: ['invitation-preview', token],
    queryFn: () => invitationsApi.preview(token),
    enabled: token !== '',
    // The invitation is single-use and its state can change under the invitee —
    // an administrator may withdraw it while this page is open — so a retry
    // that silently re-reads a dead link helps nobody.
    retry: false,
  });

  const accept = useMutation({
    mutationFn: () => invitationsApi.accept({ token, password }),
    onSuccess: () => {
      setAccepted(true);
    },
  });

  if (token === '') {
    return (
      <Frame>
        <p>
          This page needs the link from your invitation email or message. Open that link rather than
          this page directly.
        </p>
      </Frame>
    );
  }

  if (accepted) {
    return (
      <Frame title="Your account is ready">
        <p>Your password is set. Sign in with your email address to start.</p>
        <Link className="button button--primary" to="/sign-in">
          Go to sign in
        </Link>
      </Frame>
    );
  }

  if (preview.isPending) {
    return (
      <Frame>
        <Spinner label="Checking your invitation" />
      </Frame>
    );
  }

  if (preview.error !== null) {
    return (
      <Frame title="This link cannot be used">
        <ErrorNotice error={preview.error} />
        <p className="muted">
          Invitations last seven days and can be used once. Ask whoever invited you for a new one.
        </p>
      </Frame>
    );
  }

  const mismatch = confirmation !== '' && confirmation !== password;

  return (
    <Frame title={`Join ${preview.data.institutionName}`}>
      <dl className="details">
        <div>
          <dt>Name</dt>
          <dd>{preview.data.fullName}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{preview.data.email}</dd>
        </div>
        <div>
          <dt>Role</dt>
          <dd>{ROLE_LABELS[preview.data.roleCode]}</dd>
        </div>
        <div>
          <dt>Branch</dt>
          <dd>{preview.data.branchName ?? 'Institution-wide'}</dd>
        </div>
      </dl>

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!mismatch) {
            accept.mutate();
          }
        }}
      >
        {accept.error !== null && <ErrorNotice error={accept.error} />}

        <Field
          id="accept-password"
          label="Choose a password"
          hint={`At least ${String(MINIMUM_PASSWORD_LENGTH)} characters. A passphrase of a few words is easier to remember and harder to guess.`}
          error={
            accept.error instanceof ApiRequestError
              ? accept.error.fieldError('password')
              : undefined
          }
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
              required
            />
          )}
        </Field>

        <Field
          id="accept-confirmation"
          label="Type it again"
          error={mismatch ? 'The two passwords do not match.' : undefined}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => {
                setConfirmation(event.target.value);
              }}
              required
            />
          )}
        </Field>

        <button
          className="button button--primary"
          type="submit"
          disabled={accept.isPending || mismatch}
        >
          {accept.isPending ? 'Setting up…' : 'Accept and set password'}
        </button>
      </form>
    </Frame>
  );
}

/**
 * The signed-out frame.
 *
 * The sign-in screen's own classes, not new ones. This page is the second of
 * exactly two screens reachable without a session, and the pair should not look
 * like they came from different applications.
 */
function Frame({ title, children }: { title?: string; children: ReactNode }): ReactNode {
  return (
    <main className="sign-in">
      <div className="sign-in__card">
        <h1 className="sign-in__title">MFI Manager</h1>
        {title !== undefined && <p className="sign-in__subtitle">{title}</p>}
        {children}
      </div>
    </main>
  );
}
