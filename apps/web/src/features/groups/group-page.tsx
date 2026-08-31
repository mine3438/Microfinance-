import { type Group, type GroupMember } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { groups as groupsApi } from '../../shared/api/endpoints.js';
import { formatDate, today } from '../../shared/lib/format.js';
import { StatusBadge } from '../../shared/ui/badge.js';
import { ClientPicker } from '../../shared/ui/client-picker.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';
import { GroupLendingNotice } from './groups-page.js';

/**
 * One group: what it is, and who is in it.
 *
 * The roster can be read as it stands or as it stood on a date. That is not a
 * reporting nicety — membership is held as intervals precisely so that "who
 * belonged when this was recorded" has an answer after people come and go, and
 * a screen that could only show today would throw that away.
 *
 * There is no financial figure anywhere on this page. Members hold no balance,
 * no sub-loan and no share of anything, because none of those exists.
 */
export function GroupPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const groupId = id ?? '';

  const query = useQuery({
    queryKey: ['group', groupId],
    queryFn: () => groupsApi.get(groupId),
    enabled: groupId !== '',
  });

  if (query.isPending) {
    return <Spinner label="Loading the group" />;
  }
  if (query.error !== null) {
    return <ErrorNotice error={query.error} />;
  }
  return <GroupDetail group={query.data} />;
}

function GroupDetail({ group }: { group: Group }): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['group', group.id] });
    await queryClient.invalidateQueries({ queryKey: ['groups'] });
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">{group.name}</h1>
          <p className="page__subtitle">
            <code>{group.code}</code> · {group.branchName ?? 'No branch'} ·{' '}
            <StatusBadge status={group.status} />
          </p>
        </div>
        {session.can('client.update') && !editing && group.status === 'active' && (
          <button
            className="button"
            type="button"
            onClick={() => {
              setEditing(true);
            }}
          >
            Edit group
          </button>
        )}
      </div>

      <div className="layout layout--split">
        <div className="stack">
          <Panel title="Details">
            <dl className="details">
              <div>
                <dt>Formed</dt>
                <dd>{formatDate(group.formedOn)}</dd>
              </div>
              <div>
                <dt>Branch</dt>
                <dd>{group.branchName ?? '—'}</dd>
              </div>
              <div>
                <dt>Current members</dt>
                <dd>{group.currentMemberCount}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={group.status} />
                </dd>
              </div>
            </dl>
          </Panel>

          {editing && (
            <EditGroupForm
              group={group}
              onDone={() => {
                setEditing(false);
              }}
              onSaved={refresh}
            />
          )}

          <GroupLendingNotice />
        </div>

        <div className="stack">
          <MembersPanel group={group} onChanged={refresh} />
        </div>
      </div>
    </div>
  );
}

/** Renaming a group, or closing it. Nothing else about a group is amendable. */
function EditGroupForm({
  group,
  onDone,
  onSaved,
}: {
  group: Group;
  onDone: () => void;
  onSaved: () => Promise<void>;
}): ReactNode {
  const [name, setName] = useState(group.name);
  const [status, setStatus] = useState<'active' | 'closed'>(group.status);

  const save = useMutation({
    mutationFn: () => groupsApi.update(group.id, { name, status }),
    onSuccess: async () => {
      await onSaved();
      onDone();
    },
  });

  const fieldError = (field: string): string | undefined =>
    save.error instanceof ApiRequestError ? save.error.fieldError(field) : undefined;

  return (
    <Panel title="Edit group">
      {save.error !== null && <ErrorNotice error={save.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <Field id="edit-group-name" label="Group name" error={fieldError('name')}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="edit-group-status"
          label="Status"
          hint="Closing a group keeps its membership history intact."
          error={fieldError('status')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value === 'closed' ? 'closed' : 'active');
              }}
            >
              <option value="active">Active</option>
              <option value="closed">Closed</option>
            </select>
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save changes'}
          </button>
          <button className="button" type="button" onClick={onDone} disabled={save.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}

function MembersPanel({ group, onChanged }: { group: Group; onChanged: () => Promise<void> }) {
  const session = useSession();
  const queryClient = useQueryClient();

  // Empty means "as things stand". A date reads the intervals open that day.
  const [asAt, setAsAt] = useState('');
  const [adding, setAdding] = useState(false);
  const [leaving, setLeaving] = useState<GroupMember | null>(null);

  const members = useQuery({
    queryKey: ['group-members', group.id, asAt],
    queryFn: () => groupsApi.members(group.id, asAt === '' ? undefined : asAt),
  });

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['group-members', group.id] });
    await onChanged();
  };

  const historical = asAt !== '';

  return (
    <Panel
      title="Members"
      actions={
        session.can('client.update') && !adding && !historical && group.status === 'active' ? (
          <button
            className="button button--small"
            type="button"
            onClick={() => {
              setAdding(true);
            }}
          >
            Add a member
          </button>
        ) : undefined
      }
    >
      <Field
        id="members-as-at"
        label="Membership as at"
        hint="Leave blank for the roster as it stands today."
      >
        {(props) => (
          <input
            {...props}
            className="input"
            type="date"
            value={asAt}
            onChange={(event) => {
              setAsAt(event.target.value);
            }}
          />
        )}
      </Field>

      {adding && (
        <AddMemberForm
          group={group}
          onDone={() => {
            setAdding(false);
          }}
          onAdded={refresh}
        />
      )}

      {leaving !== null && (
        <RecordDepartureForm
          group={group}
          member={leaving}
          onDone={() => {
            setLeaving(null);
          }}
          onRecorded={refresh}
        />
      )}

      {members.isPending && <Spinner label="Loading members" />}
      {members.error !== null && <ErrorNotice error={members.error} />}

      {members.data !== undefined &&
        (members.data.length === 0 ? (
          <EmptyState title={historical ? 'Nobody was in this group that day' : 'No members yet'}>
            {historical
              ? 'Try another date, or clear it to see the current roster.'
              : 'Add borrowers to record who belongs to this group.'}
          </EmptyState>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Member</th>
                  <th scope="col">Code</th>
                  <th scope="col">Joined</th>
                  <th scope="col">Left</th>
                  {session.can('client.update') && !historical && <th scope="col">Action</th>}
                </tr>
              </thead>
              <tbody>
                {members.data.map((member) => (
                  <tr key={member.id} className={member.leftOn !== null ? 'row--muted' : ''}>
                    <td>
                      <Link to={`/clients/${member.clientId}/groups`}>{member.clientName}</Link>
                    </td>
                    <td>{member.clientCode === null ? '—' : <code>{member.clientCode}</code>}</td>
                    <td>{formatDate(member.joinedOn)}</td>
                    <td>{member.leftOn === null ? 'Still a member' : formatDate(member.leftOn)}</td>
                    {session.can('client.update') && !historical && (
                      <td>
                        {member.leftOn === null && group.status === 'active' && (
                          <button
                            className="button button--small"
                            type="button"
                            onClick={() => {
                              setLeaving(member);
                            }}
                          >
                            Record departure
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      <p className="hint-block">
        Membership is kept as periods rather than a list, so a record written while somebody
        belonged stays legible after they leave. Departures are recorded; they are never deleted.
      </p>
    </Panel>
  );
}

function AddMemberForm({
  group,
  onDone,
  onAdded,
}: {
  group: Group;
  onDone: () => void;
  onAdded: () => Promise<void>;
}): ReactNode {
  const [clientId, setClientId] = useState('');
  const [joinedOn, setJoinedOn] = useState(today());

  const add = useMutation({
    mutationFn: () => groupsApi.addMember(group.id, { clientId, joinedOn }),
    onSuccess: async () => {
      await onAdded();
      onDone();
    },
  });

  const fieldError = (field: string): string | undefined =>
    add.error instanceof ApiRequestError ? add.error.fieldError(field) : undefined;

  return (
    <div className="stack">
      {add.error !== null && <ErrorNotice error={add.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <ClientPicker
          id="add-member-client"
          label="Borrower"
          value={clientId}
          onChange={setClientId}
          error={fieldError('clientId')}
        />

        <Field id="add-member-joined" label="Joined on" error={fieldError('joinedOn')}>
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={joinedOn}
              onChange={(event) => {
                setJoinedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button
            className="button button--primary"
            type="submit"
            disabled={clientId === '' || add.isPending}
          >
            {add.isPending ? 'Adding…' : 'Add to the group'}
          </button>
          <button className="button" type="button" onClick={onDone} disabled={add.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

function RecordDepartureForm({
  group,
  member,
  onDone,
  onRecorded,
}: {
  group: Group;
  member: GroupMember;
  onDone: () => void;
  onRecorded: () => Promise<void>;
}): ReactNode {
  const [leftOn, setLeftOn] = useState(today());

  const record = useMutation({
    mutationFn: () => groupsApi.endMembership(group.id, member.clientId, { leftOn }),
    onSuccess: async () => {
      await onRecorded();
      onDone();
    },
  });

  const fieldError = (field: string): string | undefined =>
    record.error instanceof ApiRequestError ? record.error.fieldError(field) : undefined;

  return (
    <div className="stack">
      {record.error !== null && <ErrorNotice error={record.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          record.mutate();
        }}
      >
        <p>
          Recording that <strong>{member.clientName}</strong> has left. The period they belonged is
          kept.
        </p>

        <Field id="departure-left-on" label="Left on" error={fieldError('leftOn')}>
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={leftOn}
              onChange={(event) => {
                setLeftOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={record.isPending}>
            {record.isPending ? 'Recording…' : 'Record the departure'}
          </button>
          <button className="button" type="button" onClick={onDone} disabled={record.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
