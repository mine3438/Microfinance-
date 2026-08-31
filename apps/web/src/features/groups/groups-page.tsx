import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ApiRequestError } from '../../shared/api/client.js';
import { branches as branchesApi, groups as groupsApi } from '../../shared/api/endpoints.js';
import { formatDate, today } from '../../shared/lib/format.js';
import { StatusBadge } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Lending groups.
 *
 * A group is a borrower-side administrative record: who belongs to it, since
 * when, and which branch keeps it. It is **not** a thing that can hold a loan,
 * and this screen offers no way to make one — see {@link GroupLendingNotice}.
 *
 * Guarded by the borrower permissions rather than a `group.*` set, matching the
 * API. Deciding which roles hold a new permission is policy nobody has stated,
 * and `client.read`/`client.create` already name the people who may see and
 * register borrowers.
 */
export function GroupsPage(): ReactNode {
  const session = useSession();
  const [creating, setCreating] = useState(false);

  const query = useQuery({ queryKey: ['groups'], queryFn: () => groupsApi.list() });

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Groups</h1>
        {session.can('client.create') && !creating && (
          <button
            className="button button--primary"
            type="button"
            onClick={() => {
              setCreating(true);
            }}
          >
            Form a group
          </button>
        )}
      </div>

      {creating && (
        <NewGroupForm
          onDone={() => {
            setCreating(false);
          }}
        />
      )}

      <Panel>
        {query.isPending && <Spinner label="Loading groups" />}
        {query.error !== null && <ErrorNotice error={query.error} />}

        {query.data !== undefined &&
          (query.data.length === 0 ? (
            <EmptyState title="No groups yet">
              Groups you form will appear here, with their members.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Code</th>
                    <th scope="col">Name</th>
                    <th scope="col">Branch</th>
                    <th scope="col">Formed</th>
                    <th scope="col" className="numeric">
                      Members
                    </th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((group) => (
                    <tr key={group.id}>
                      <td>
                        <code>{group.code}</code>
                      </td>
                      <td>
                        <Link to={`/groups/${group.id}`}>{group.name}</Link>
                      </td>
                      <td>{group.branchName ?? '—'}</td>
                      <td>{formatDate(group.formedOn)}</td>
                      <td className="numeric">{group.currentMemberCount}</td>
                      <td>
                        <StatusBadge status={group.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
      </Panel>

      <GroupLendingNotice />
    </div>
  );
}

/**
 * That groups exist and cannot borrow.
 *
 * Stated plainly, without a reason. The reason is a Bank of Tanzania reporting
 * question (GROUP-05) that staff cannot act on and should not have to weigh at
 * a counter; inventing an explanation for them would be inventing regulatory
 * guidance. What they need to know is that the operation is unavailable, so
 * they do not go looking for a button that is not there.
 */
export function GroupLendingNotice(): ReactNode {
  return (
    <Panel tone="neutral" title="Lending to a group">
      <p className="muted">
        Group lending is not available in this system. Groups here record membership only; a loan is
        made to an individual borrower.
      </p>
    </Panel>
  );
}

function NewGroupForm({ onDone }: { onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const session = useSession();

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [branchId, setBranchId] = useState('');
  const [formedOn, setFormedOn] = useState(today());

  // Branch-scoped staff have theirs filled in by the server and are refused if
  // they name another, so the control is only offered to someone unscoped.
  const scopedBranch = session.user?.branch ?? null;

  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    enabled: scopedBranch === null,
  });

  const create = useMutation({
    mutationFn: () =>
      groupsApi.create({
        code,
        name,
        formedOn,
        ...(scopedBranch === null && branchId !== '' ? { branchId } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['groups'] });
      onDone();
    },
  });

  const fieldError = (field: string): string | undefined =>
    create.error instanceof ApiRequestError ? create.error.fieldError(field) : undefined;

  return (
    <Panel title="Form a group">
      {create.error !== null && <ErrorNotice error={create.error} />}

      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate();
        }}
      >
        <Field
          id="group-code"
          label="Group code"
          hint="How staff will refer to this group."
          error={fieldError('code')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="group-name" label="Group name" error={fieldError('name')}>
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

        {scopedBranch === null && (
          <Field id="group-branch" label="Branch" error={fieldError('branchId')}>
            {(props) => (
              <select
                {...props}
                className="input"
                value={branchId}
                onChange={(event) => {
                  setBranchId(event.target.value);
                }}
              >
                <option value="">Choose a branch</option>
                {(branches.data ?? [])
                  .filter((branch) => branch.status === 'active')
                  .map((branch) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            )}
          </Field>
        )}

        <Field
          id="group-formed-on"
          label="Formed on"
          hint="When the group was formed, which need not be today."
          error={fieldError('formedOn')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={formedOn}
              onChange={(event) => {
                setFormedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={create.isPending}>
            {create.isPending ? 'Forming…' : 'Form the group'}
          </button>
          <button className="button" type="button" onClick={onDone} disabled={create.isPending}>
            Cancel
          </button>
        </div>
      </form>
    </Panel>
  );
}
