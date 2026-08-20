import { AUDIT_OPERATIONS, type AuditEntry, type AuditOperation } from '@mfi/contracts';
import { useQuery } from '@tanstack/react-query';
import { Fragment, useState, type ReactNode } from 'react';

import { audit as auditApi } from '../../shared/api/endpoints.js';
import { formatTimestamp } from '../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';

/**
 * The audit trail.
 *
 * Every row on this screen was written by a database trigger, not by the code
 * that made the change. That is what makes it worth reading: nothing here
 * depended on a developer remembering to record anything, so a write path added
 * later appears without anyone having thought about this page.
 *
 * The screen reads and never writes, which is not a UI decision — the API has
 * no write route for the trail and the application's database role holds no
 * privilege that would let one work. There is deliberately no "delete entry"
 * and no "add note".
 *
 * The list carries which columns moved; the values either side are fetched only
 * when a row is opened. Browsing a quarter of activity should not stream every
 * row of the loan book through the browser, and most rows are never opened.
 */

const OPERATION_TONES: Record<AuditOperation, BadgeTone> = {
  INSERT: 'success',
  UPDATE: 'info',
  DELETE: 'danger',
};

const OPERATION_LABELS: Record<AuditOperation, string> = {
  INSERT: 'Created',
  UPDATE: 'Changed',
  DELETE: 'Removed',
};

/**
 * A table name as a reader would say it.
 *
 * Presentation only, and only here. The value the API filters on is the name
 * Postgres uses, so what goes over the wire is always `loan_products` even when
 * the screen says "Loan products".
 */
function tableLabel(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A column name as a reader would say it. */
function columnLabel(name: string): string {
  return name.replace(/_/g, ' ');
}

/**
 * One stored value, as text.
 *
 * The payloads are whole table rows from every table in the schema, so a value
 * is whatever that column holds — a string, a number, a date, a nested JSON
 * document. Rendering an object as JSON is the honest option: summarising it
 * would hide part of the evidence, which is the one thing this screen must not
 * do.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) {
    return '—';
  }
  if (typeof value === 'string') {
    return value === '' ? '(empty)' : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export function AuditPage(): ReactNode {
  const [tableName, setTableName] = useState('');
  const [operation, setOperation] = useState<AuditOperation | ''>('');
  const [actor, setActor] = useState<{ id: string; name: string } | null>(null);
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [opened, setOpened] = useState<string | null>(null);

  const cursor = cursors[cursors.length - 1];

  const tables = useQuery({
    queryKey: ['audited-tables'],
    queryFn: () => auditApi.tables(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const list = useQuery({
    queryKey: ['audit', { tableName, operation, actorId: actor?.id ?? null, cursor }],
    queryFn: () =>
      auditApi.list({
        ...(tableName === '' ? {} : { tableName }),
        ...(operation === '' ? {} : { operation }),
        ...(actor === null ? {} : { actorUserId: actor.id }),
        ...(cursor === undefined ? {} : { cursor }),
      }),
  });

  /**
   * Any change of filter restarts the sequence.
   *
   * A cursor names the last row of a result set. Carrying one across a filter
   * change points it into a set that no longer exists, and the page that comes
   * back is not the page after the one just read.
   */
  const refilter = (apply: () => void): void => {
    apply();
    setCursors([undefined]);
    setOpened(null);
  };

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Audit trail</h1>
          <p className="page__subtitle">
            Every change to every business record, written by the database itself as it happened.
          </p>
        </div>
      </div>

      <Panel
        title="Recorded changes"
        actions={
          <>
            <Field id="audit-table" label="Table">
              {(props) => (
                <select
                  {...props}
                  className="input"
                  value={tableName}
                  onChange={(event) => {
                    refilter(() => {
                      setTableName(event.target.value);
                    });
                  }}
                >
                  <option value="">All tables</option>
                  {(tables.data ?? []).map((table) => (
                    <option key={table.name} value={table.name}>
                      {tableLabel(table.name)}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field id="audit-operation" label="Change">
              {(props) => (
                <select
                  {...props}
                  className="input"
                  value={operation}
                  onChange={(event) => {
                    refilter(() => {
                      setOperation(event.target.value as AuditOperation | '');
                    });
                  }}
                >
                  <option value="">Any</option>
                  {AUDIT_OPERATIONS.map((value) => (
                    <option key={value} value={value}>
                      {OPERATION_LABELS[value]}
                    </option>
                  ))}
                </select>
              )}
            </Field>
          </>
        }
      >
        {actor !== null && (
          <p className="muted">
            Showing changes made by {actor.name}.{' '}
            <button
              className="link-button"
              type="button"
              onClick={() => {
                refilter(() => {
                  setActor(null);
                });
              }}
            >
              Show everyone
            </button>
          </p>
        )}

        {tables.error !== null && <ErrorNotice error={tables.error} />}
        {list.isPending && <Spinner label="Loading the audit trail" />}
        {list.error !== null && <ErrorNotice error={list.error} />}

        {list.data !== undefined &&
          (list.data.items.length === 0 ? (
            <EmptyState title="Nothing matches">
              The trail records every change to every business table. An empty result here means no
              change matched these filters, not that nothing was recorded.
            </EmptyState>
          ) : (
            <>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Record</th>
                      <th scope="col">Change</th>
                      <th scope="col">By</th>
                      <th scope="col">Fields</th>
                      <th scope="col">
                        <span className="visually-hidden">Detail</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.items.map((entry) => (
                      <Fragment key={entry.id}>
                        <tr>
                          <td>{formatTimestamp(entry.changedAt)}</td>
                          <td>{tableLabel(entry.tableName)}</td>
                          <td>
                            <Badge tone={OPERATION_TONES[entry.operation]}>
                              {OPERATION_LABELS[entry.operation]}
                            </Badge>
                          </td>
                          <td>
                            <ActorCell
                              entry={entry}
                              onSelect={(selected) => {
                                refilter(() => {
                                  setActor(selected);
                                });
                              }}
                            />
                          </td>
                          <td>
                            {entry.changedColumns.length === 0
                              ? '—'
                              : entry.changedColumns.map(columnLabel).join(', ')}
                          </td>
                          <td>
                            <button
                              className="button button--small"
                              type="button"
                              aria-expanded={opened === entry.id}
                              onClick={() => {
                                setOpened((current) => (current === entry.id ? null : entry.id));
                              }}
                            >
                              {opened === entry.id ? 'Hide' : 'Show'}
                            </button>
                          </td>
                        </tr>
                        {opened === entry.id && (
                          <tr>
                            <td colSpan={6}>
                              <EntryDetail entry={entry} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
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
                    setOpened(null);
                    setCursors((current) => current.slice(0, -1));
                  }}
                >
                  Previous
                </button>
                <button
                  className="button"
                  type="button"
                  disabled={list.data.nextCursor === null}
                  onClick={() => {
                    const next = list.data.nextCursor;
                    if (next !== null) {
                      setOpened(null);
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

/**
 * Who made the change.
 *
 * A great many entries have no actor, and that is not a gap in the record: a
 * migration, the nightly classification run and the signup that creates an
 * institution all change rows before or without any user. Naming what did it is
 * more useful than an empty cell.
 */
function ActorCell({
  entry,
  onSelect,
}: {
  entry: AuditEntry;
  onSelect: (actor: { id: string; name: string }) => void;
}): ReactNode {
  if (entry.actorUserId === null) {
    return <span className="muted">System</span>;
  }

  const name = entry.actorName ?? 'Unknown user';
  const id = entry.actorUserId;

  return (
    <button
      className="link-button"
      type="button"
      onClick={() => {
        onSelect({ id, name });
      }}
    >
      {name}
    </button>
  );
}

/**
 * The row either side of one change.
 *
 * Fetched when the row is opened rather than with the list. An update shows the
 * columns that moved; a creation and a removal show the whole row, because on
 * those the whole row is what changed.
 */
function EntryDetail({ entry }: { entry: AuditEntry }): ReactNode {
  const detail = useQuery({
    queryKey: ['audit-entry', entry.id],
    queryFn: () => auditApi.get(entry.id),
    // The trail is append-only: an entry that has been read once cannot change.
    staleTime: Number.POSITIVE_INFINITY,
  });

  if (detail.isPending) {
    return <Spinner label="Loading the change" />;
  }
  if (detail.error !== null) {
    return <ErrorNotice error={detail.error} />;
  }

  // Neither pending nor failed, so the query has data — TanStack's discriminated
  // result says so, and a further guard here would be a branch that cannot run.
  const { before, after, changedColumns } = detail.data;
  const columns =
    changedColumns.length > 0
      ? changedColumns
      : [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();

  if (columns.length === 0) {
    return (
      <p className="muted">
        This entry records a change in which no column moved — an update that set every column to
        the value it already held.
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <table className="table table--nested">
        <caption className="visually-hidden">
          Values before and after this change, with secrets removed
        </caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {columns.map((column) => (
            <tr key={column}>
              <th scope="row">{columnLabel(column)}</th>
              <td>{renderValue(before?.[column])}</td>
              <td>{renderValue(after?.[column])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
