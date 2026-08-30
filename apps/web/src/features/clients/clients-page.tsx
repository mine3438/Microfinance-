import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { clients as clientsApi } from '../../shared/api/endpoints.js';
import { formatDate } from '../../shared/lib/format.js';
import { StatusBadge } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * The borrower list.
 *
 * Paged by cursor, because that is what the API offers and for the reason it
 * offers it: a client registered while someone is paging shifts every later row
 * under offset pagination, so a record is seen twice or missed. The cursor is
 * opaque and passed back as given.
 */
export function ClientsPage(): ReactNode {
  const session = useSession();
  const [search, setSearch] = useState('');
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);

  const cursor = cursors[cursors.length - 1];

  const query = useQuery({
    queryKey: ['clients', { search, cursor }],
    queryFn: () => clientsApi.list({ search: search === '' ? undefined : search, cursor }),
  });

  const onSearch = (value: string): void => {
    setSearch(value);
    // A new search starts a new sequence: a cursor from the previous filter
    // points into a result set that no longer exists.
    setCursors([undefined]);
  };

  return (
    <div className="page">
      <div className="page__header">
        <h1 className="page__title">Borrowers</h1>
        {session.can('client.create') && (
          <Link className="button button--primary" to="/clients/new">
            Register a borrower
          </Link>
        )}
      </div>

      <Panel>
        <label className="search" htmlFor="client-search">
          <span className="visually-hidden">Search borrowers</span>
          <input
            id="client-search"
            className="input"
            type="search"
            placeholder="Search by name or client code"
            value={search}
            onChange={(event) => {
              onSearch(event.target.value);
            }}
          />
        </label>

        {query.isPending && <Spinner label="Loading borrowers" />}
        {query.error !== null && <ErrorNotice error={query.error} />}

        {query.data !== undefined &&
          (query.data.items.length === 0 ? (
            <EmptyState
              title={search === '' ? 'No borrowers yet' : 'Nothing matched that search'}
              action={
                search !== '' ? (
                  <button
                    className="button"
                    type="button"
                    onClick={() => {
                      onSearch('');
                    }}
                  >
                    Clear the search
                  </button>
                ) : undefined
              }
            >
              {search === ''
                ? 'Borrowers you register will appear here.'
                : 'Try part of a name, or a client code.'}
            </EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Code</th>
                      <th scope="col">Name</th>
                      <th scope="col">Phone</th>
                      <th scope="col">Branch</th>
                      <th scope="col">Registered</th>
                      <th scope="col">Status</th>
                      <th scope="col">Groups</th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.items.map((client) => (
                      <tr key={client.id}>
                        <td>
                          <code>{client.clientCode}</code>
                        </td>
                        <td>{client.fullName}</td>
                        <td>{client.phone}</td>
                        <td>{client.branchName}</td>
                        <td>{formatDate(client.createdAt.slice(0, 10))}</td>
                        <td>
                          <StatusBadge status={client.status} />
                        </td>
                        <td>
                          <Link to={`/clients/${client.id}/groups`}>Groups</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <nav className="pager" aria-label="Pagination">
                <button
                  className="button"
                  type="button"
                  disabled={cursors.length === 1}
                  onClick={() => {
                    setCursors((current) => current.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={query.data.nextCursor === null}
                  onClick={() => {
                    const next = query.data.nextCursor;
                    if (next !== null) {
                      setCursors((current) => [...current, next]);
                    }
                  }}
                >
                  Next
                </button>
              </nav>
            </>
          ))}
      </Panel>
    </div>
  );
}
