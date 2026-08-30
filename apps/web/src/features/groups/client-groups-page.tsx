import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';

import { clients as clientsApi, groups as groupsApi } from '../../shared/api/endpoints.js';
import { formatDate } from '../../shared/lib/format.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { GroupLendingNotice } from './groups-page.js';

/**
 * Which groups one borrower belongs to.
 *
 * The reverse of the roster, and the direction staff usually ask in: somebody
 * is standing at the counter and the question is what they are part of, not who
 * else is in a group already named.
 *
 * Like the roster it reads as at a date, because membership is an interval on
 * both sides of the relation.
 */
export function ClientGroupsPage(): ReactNode {
  const { id } = useParams<{ id: string }>();
  const clientId = id ?? '';
  const [asAt, setAsAt] = useState('');

  const client = useQuery({
    queryKey: ['client', clientId],
    queryFn: () => clientsApi.get(clientId),
    enabled: clientId !== '',
  });

  const memberships = useQuery({
    queryKey: ['client-groups', clientId, asAt],
    queryFn: () => groupsApi.forClient(clientId, asAt === '' ? undefined : asAt),
    enabled: clientId !== '',
  });

  /**
   * Group names for the rows.
   *
   * A membership carries the group's identifier and not its name, so the list
   * is fetched to label the rows. This is a display join and nothing more —
   * a row whose name has not arrived yet still renders, with its code, rather
   * than waiting on a second request to show anything at all.
   */
  const groups = useQuery({ queryKey: ['groups'], queryFn: () => groupsApi.list() });
  const nameOf = (groupId: string): string | undefined =>
    groups.data?.find((group) => group.id === groupId)?.name;

  const historical = asAt !== '';

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">
            {client.data === undefined ? 'Groups' : `${client.data.fullName} — groups`}
          </h1>
          <p className="page__subtitle">
            <Link to="/clients">Borrowers</Link> · <Link to="/groups">All groups</Link>
          </p>
        </div>
      </div>

      {client.error !== null && <ErrorNotice error={client.error} />}

      <Panel title="Memberships">
        <Field
          id="client-groups-as-at"
          label="Membership as at"
          hint="Leave blank for the groups they belong to today."
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

        {memberships.isPending && <Spinner label="Loading memberships" />}
        {memberships.error !== null && <ErrorNotice error={memberships.error} />}

        {memberships.data !== undefined &&
          (memberships.data.length === 0 ? (
            <EmptyState
              title={
                historical ? 'They were in no group that day' : 'This borrower is not in any group'
              }
            >
              {historical
                ? 'Try another date, or clear it to see current memberships.'
                : 'Add them to a group from that group’s page.'}
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Group</th>
                    <th scope="col">Joined</th>
                    <th scope="col">Left</th>
                  </tr>
                </thead>
                <tbody>
                  {memberships.data.map((membership) => (
                    <tr
                      key={membership.id}
                      className={membership.leftOn !== null ? 'row--muted' : ''}
                    >
                      <td>
                        <Link to={`/groups/${membership.groupId}`}>
                          {nameOf(membership.groupId) ?? 'View group'}
                        </Link>
                      </td>
                      <td>{formatDate(membership.joinedOn)}</td>
                      <td>
                        {membership.leftOn === null
                          ? 'Still a member'
                          : formatDate(membership.leftOn)}
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
