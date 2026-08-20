import {
  ROLES,
  type CreatedInvitation,
  type Invitation,
  type InvitationState,
  type RoleCode,
  type StaffMember,
} from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import { branches as branchesApi, staff as staffApi } from '../../shared/api/endpoints.js';
import { formatTimestamp } from '../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Staff management.
 *
 * The screen that did not exist. Until this was built an institution could not
 * add a member of staff at all — every account came from a seed script, which
 * meant the loan-officer persona the product is designed around could not be
 * created by the people who need it.
 *
 * The invitation link is shown once, on the panel, after it is created. That is
 * not a development shortcut: no supplied document names an email provider, so
 * the API's default mechanism hands the link back to the administrator to
 * convey. Showing it is the delivery.
 */

const ROLE_LABELS: Record<RoleCode, string> = {
  institution_admin: 'Administrator',
  branch_manager: 'Branch manager',
  loan_officer: 'Loan officer',
  accountant: 'Accountant',
  auditor: 'Auditor',
};

const STATE_TONES: Record<InvitationState, BadgeTone> = {
  pending: 'info',
  accepted: 'success',
  expired: 'neutral',
  revoked: 'danger',
};

const STATE_LABELS: Record<InvitationState, string> = {
  pending: 'Awaiting acceptance',
  accepted: 'Accepted',
  expired: 'Expired',
  revoked: 'Withdrawn',
};

const STATUS_TONES: Record<string, BadgeTone> = {
  invited: 'info',
  active: 'success',
  suspended: 'danger',
};

export function StaffPage(): ReactNode {
  const session = useSession();
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<CreatedInvitation | null>(null);

  const people = useQuery({ queryKey: ['staff'], queryFn: () => staffApi.list() });
  const invitations = useQuery({
    queryKey: ['staff-invitations'],
    queryFn: () => staffApi.invitations(),
  });

  const canInvite = session.can('user.invite');
  const canManage = session.can('user.manage');

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Staff</h1>
          <p className="page__subtitle">
            Who works here, and who has been asked to. An invitation creates the account; accepting
            it sets the password.
          </p>
        </div>
      </div>

      {canInvite && (
        <Panel
          title="Invite a member of staff"
          actions={
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                setInviting((open) => !open);
                setIssued(null);
              }}
            >
              {inviting ? 'Cancel' : 'Invite someone'}
            </button>
          }
        >
          {issued !== null && <IssuedInvitation created={issued} />}

          {inviting ? (
            <InviteForm
              onInvited={(created) => {
                setInviting(false);
                setIssued(created);
              }}
            />
          ) : (
            issued === null && (
              <p className="muted">
                You can only grant a role whose authority you hold yourself. An invitation lasts
                seven days and can be withdrawn before it is accepted.
              </p>
            )
          )}
        </Panel>
      )}

      <Panel title="Staff">
        {people.isPending && <Spinner label="Loading staff" />}
        {people.error !== null && <ErrorNotice error={people.error} />}
        {people.data !== undefined && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Email</th>
                  <th scope="col">Role</th>
                  <th scope="col">Branch</th>
                  <th scope="col">Status</th>
                  <th scope="col">Last signed in</th>
                  {canManage && (
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {people.data.map((member) => (
                  <StaffRow
                    key={member.id}
                    member={member}
                    manageable={canManage && member.id !== session.user?.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Invitations">
        {invitations.isPending && <Spinner label="Loading invitations" />}
        {invitations.error !== null && <ErrorNotice error={invitations.error} />}
        {invitations.data !== undefined &&
          (invitations.data.length === 0 ? (
            <EmptyState title="None yet">
              Nobody has been invited. Staff accounts are created by invitation, so this list is
              also the record of who was asked and by whom.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Email</th>
                    <th scope="col">Role</th>
                    <th scope="col">State</th>
                    <th scope="col">Invited by</th>
                    <th scope="col">Expires</th>
                    <th scope="col">
                      <span className="visually-hidden">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invitations.data.map((invitation) => (
                    <InvitationRow
                      key={invitation.id}
                      invitation={invitation}
                      revocable={canInvite}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>
    </div>
  );
}

/**
 * The link, shown once.
 *
 * Deliberately not stored anywhere in this app and not re-fetchable: the server
 * keeps only a hash, so this is the single moment the token exists in readable
 * form. If it is lost, the invitation is withdrawn and a new one issued, which
 * is the correct outcome — a link that can be retrieved later is a credential
 * sitting in a database.
 */
function IssuedInvitation({ created }: { created: CreatedInvitation }): ReactNode {
  if (created.link === null) {
    return <p className="muted">Invitation created and sent to {created.invitation.email}.</p>;
  }

  return (
    <div className="notice notice--info">
      <p>
        Send this link to {created.invitation.fullName}. It works once, expires{' '}
        {formatTimestamp(created.invitation.expiresAt)}, and is shown only now — the server keeps
        only a hash of it.
      </p>
      <p>
        <code className="invitation-link">{created.link}</code>
      </p>
    </div>
  );
}

function StaffRow({ member, manageable }: { member: StaffMember; manageable: boolean }): ReactNode {
  const queryClient = useQueryClient();

  const change = useMutation({
    mutationFn: (status: 'active' | 'suspended') => staffApi.update(member.id, { status }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
    },
  });

  return (
    <tr>
      <td>{member.fullName}</td>
      <td>{member.email}</td>
      <td>{member.roles.map((role) => ROLE_LABELS[role]).join(', ')}</td>
      <td>{member.branchName ?? 'Institution-wide'}</td>
      <td>
        <Badge tone={STATUS_TONES[member.status] ?? 'neutral'}>
          {member.status === 'invited'
            ? 'Invited'
            : member.status === 'active'
              ? 'Active'
              : 'Suspended'}
        </Badge>
      </td>
      <td>{member.lastLoginAt === null ? 'Never' : formatTimestamp(member.lastLoginAt)}</td>
      {manageable && (
        <td>
          {member.status === 'invited' ? (
            <span className="muted">Awaiting acceptance</span>
          ) : (
            <button
              className="button button--small"
              type="button"
              disabled={change.isPending}
              onClick={() => {
                change.mutate(member.status === 'suspended' ? 'active' : 'suspended');
              }}
            >
              {member.status === 'suspended' ? 'Restore' : 'Suspend'}
            </button>
          )}
          {change.error !== null && <ErrorNotice error={change.error} />}
        </td>
      )}
      {!manageable && <td />}
    </tr>
  );
}

function InvitationRow({
  invitation,
  revocable,
}: {
  invitation: Invitation;
  revocable: boolean;
}): ReactNode {
  const queryClient = useQueryClient();

  const revoke = useMutation({
    mutationFn: () => staffApi.revoke(invitation.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['staff-invitations'] });
    },
  });

  return (
    <tr>
      <td>{invitation.fullName}</td>
      <td>{invitation.email}</td>
      <td>{ROLE_LABELS[invitation.roleCode]}</td>
      <td>
        <Badge tone={STATE_TONES[invitation.state]}>{STATE_LABELS[invitation.state]}</Badge>
      </td>
      <td>{invitation.invitedByName ?? 'Unknown'}</td>
      <td>{formatTimestamp(invitation.expiresAt)}</td>
      <td>
        {revocable && invitation.state === 'pending' && (
          <button
            className="button button--small"
            type="button"
            disabled={revoke.isPending}
            onClick={() => {
              revoke.mutate();
            }}
          >
            Withdraw
          </button>
        )}
        {revoke.error !== null && <ErrorNotice error={revoke.error} />}
      </td>
    </tr>
  );
}

function InviteForm({ onInvited }: { onInvited: (created: CreatedInvitation) => void }): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [roleCode, setRoleCode] = useState<RoleCode>('loan_officer');
  const [branchId, setBranchId] = useState('');

  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  const invite = useMutation({
    mutationFn: () =>
      staffApi.invite({
        email,
        fullName,
        roleCode,
        // An empty selection means institution-wide, which is what a null
        // branch means on a user record. Sent explicitly rather than omitted,
        // so "no branch" is a stated answer rather than a missing field.
        branchId: branchId === '' ? null : branchId,
      }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['staff'] });
      void queryClient.invalidateQueries({ queryKey: ['staff-invitations'] });
      onInvited(created);
    },
  });

  const fieldError = (path: string): string | undefined =>
    invite.error instanceof ApiRequestError ? invite.error.fieldError(path) : undefined;

  // A branch-scoped administrator has nothing to choose: the server fills their
  // own branch in and refuses any other, so offering a picker would present a
  // choice that cannot be made.
  const scoped = session.user?.branch != null;

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        invite.mutate();
      }}
    >
      {invite.error !== null && <ErrorNotice error={invite.error} />}

      <Field id="invite-name" label="Full name" error={fieldError('fullName')}>
        {(props) => (
          <input
            {...props}
            className="input"
            value={fullName}
            onChange={(event) => {
              setFullName(event.target.value);
            }}
            required
          />
        )}
      </Field>

      <Field
        id="invite-email"
        label="Email"
        hint="They sign in with this address, and it must not already have an account."
        error={fieldError('email')}
      >
        {(props) => (
          <input
            {...props}
            className="input"
            type="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
            required
          />
        )}
      </Field>

      <Field
        id="invite-role"
        label="Role"
        hint="You can only grant a role whose authority you hold yourself."
        error={fieldError('roleCode')}
      >
        {(props) => (
          <select
            {...props}
            className="input"
            value={roleCode}
            onChange={(event) => {
              setRoleCode(event.target.value as RoleCode);
            }}
          >
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        )}
      </Field>

      {!scoped && (
        <Field
          id="invite-branch"
          label="Branch"
          hint="Leave blank for institution-wide authority."
          error={fieldError('branchId')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={branchId}
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            >
              <option value="">Institution-wide</option>
              {(branches.data ?? []).map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      <button className="button button--primary" type="submit" disabled={invite.isPending}>
        {invite.isPending ? 'Creating…' : 'Create invitation'}
      </button>
    </form>
  );
}
