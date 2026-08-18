import {
  REFERRAL_DESTINATIONS,
  RESOLUTION_ROUTES,
  type Complaint,
  type ComplaintNature,
  type ComplaintState,
  type ReferralDestination,
  type ResolutionRoute,
} from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiRequestError } from '../../shared/api/client.js';
import {
  branches as branchesApi,
  complaints as complaintsApi,
} from '../../shared/api/endpoints.js';
import { formatDate, formatMoney, today } from '../../shared/lib/format.js';
import { Badge } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Field } from '../../shared/ui/field.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * Customer complaints.
 *
 * MSP2-06 is compiled entirely from these records — opening, received, resolved
 * by two routes, closing, and four referral lines — and every one of those is a
 * question about dates. So this screen records dated facts and never a tally:
 * there is no "number resolved this quarter" to type, because the return
 * derives it from when each complaint was received and when it was resolved.
 *
 * Two vocabularies here are BOT's, not this system's. The **nature** is one of
 * their six categories (their form has a column per category and no room for a
 * seventh) and the **resolution route** is one of the two lines by which a
 * complaint leaves the unresolved population. Neither is free text, and neither
 * is offered from a list this app holds — both are fetched.
 */

const DESTINATION_LABELS: Record<ReferralDestination, string> = {
  bank_of_tanzania: 'Bank of Tanzania',
  fair_competition_commission: 'Fair Competition Commission',
  courts: 'Courts',
  other_parties: 'Other parties',
};

const ROUTE_LABELS: Record<ResolutionRoute, string> = {
  institution: 'By the institution',
  other_party: 'By another party',
};

export function ComplaintsPage(): ReactNode {
  const session = useSession();
  const [state, setState] = useState<ComplaintState | ''>('open');
  const [logging, setLogging] = useState(false);

  const natures = useQuery({
    queryKey: ['complaint-natures'],
    queryFn: () => complaintsApi.natures(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const list = useQuery({
    queryKey: ['complaints', state],
    queryFn: () => complaintsApi.list(state === '' ? {} : { state }),
  });

  const manageable = session.can('complaint.manage');

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Complaints</h1>
          <p className="page__subtitle">
            Every line of MSP2-06 is derived from these records and the dates on them.
          </p>
        </div>
      </div>

      {manageable && (
        <Panel
          title="Log a complaint"
          actions={
            <button
              className="button button--small"
              type="button"
              onClick={() => {
                setLogging((open) => !open);
              }}
            >
              {logging ? 'Cancel' : 'Log one'}
            </button>
          }
        >
          {logging ? (
            <LogComplaintForm
              natures={natures.data ?? []}
              onLogged={() => {
                setLogging(false);
              }}
            />
          ) : (
            <p className="muted">
              A complaint is recorded on the day it was received, not the day it is typed. The
              received date is what puts it in the right quarter.
            </p>
          )}
        </Panel>
      )}

      <Panel
        title="Recorded complaints"
        actions={
          <Field id="complaint-state" label="Showing">
            {(props) => (
              <select
                {...props}
                className="input"
                value={state}
                onChange={(event) => {
                  setState(event.target.value as ComplaintState | '');
                }}
              >
                <option value="open">Unresolved</option>
                <option value="resolved">Resolved</option>
                <option value="">All</option>
              </select>
            )}
          </Field>
        }
      >
        {list.isPending && <Spinner label="Loading complaints" />}
        {list.error !== null && <ErrorNotice error={list.error} />}

        {list.data !== undefined &&
          (list.data.items.length === 0 ? (
            <EmptyState title="Nothing recorded">
              MSP2-06 reports zero on every line for a quarter with no complaints, which is a
              legitimate return rather than a missing one.
            </EmptyState>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Complainant</th>
                    <th scope="col">Nature</th>
                    <th scope="col" className="numeric">
                      Amount
                    </th>
                    <th scope="col">Received</th>
                    <th scope="col">State</th>
                    {manageable && <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((complaint) => (
                    <ComplaintRow
                      key={complaint.id}
                      complaint={complaint}
                      manageable={manageable}
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

/** One complaint, with the two actions that move it through MSP2-06. */
function ComplaintRow({
  complaint,
  manageable,
}: {
  complaint: Complaint;
  manageable: boolean;
}): ReactNode {
  const [acting, setActing] = useState<'resolve' | 'refer' | null>(null);
  const resolved = complaint.resolvedOn !== null;

  return (
    <>
      <tr>
        <td>{complaint.complaintCode}</td>
        <td>
          {complaint.complainantName}
          {complaint.clientName !== null && <span className="muted"> · on the books</span>}
        </td>
        <td>{complaint.natureName}</td>
        <td className="numeric">{formatMoney(complaint.amount)}</td>
        <td>{formatDate(complaint.receivedOn)}</td>
        <td>
          {resolved ? (
            <Badge tone="success">
              {complaint.resolvedBy === null ? 'Resolved' : ROUTE_LABELS[complaint.resolvedBy]}
            </Badge>
          ) : complaint.referredTo !== null ? (
            <Badge tone="warning">Referred · {DESTINATION_LABELS[complaint.referredTo]}</Badge>
          ) : (
            <Badge tone="neutral">Unresolved</Badge>
          )}
        </td>
        {manageable && (
          <td>
            {!resolved && (
              <>
                <button
                  className="button button--small"
                  type="button"
                  onClick={() => {
                    setActing((current) => (current === 'resolve' ? null : 'resolve'));
                  }}
                >
                  {acting === 'resolve' ? 'Cancel' : 'Resolve'}
                </button>{' '}
                {complaint.referredTo === null && (
                  <button
                    className="button button--small"
                    type="button"
                    onClick={() => {
                      setActing((current) => (current === 'refer' ? null : 'refer'));
                    }}
                  >
                    {acting === 'refer' ? 'Cancel' : 'Refer'}
                  </button>
                )}
              </>
            )}
          </td>
        )}
      </tr>

      {acting !== null && (
        <tr>
          <td colSpan={manageable ? 7 : 6}>
            {acting === 'resolve' ? (
              <ResolveForm
                complaint={complaint}
                onDone={() => {
                  setActing(null);
                }}
              />
            ) : (
              <ReferForm
                complaint={complaint}
                onDone={() => {
                  setActing(null);
                }}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ResolveForm({
  complaint,
  onDone,
}: {
  complaint: Complaint;
  onDone: () => void;
}): ReactNode {
  const queryClient = useQueryClient();
  const [resolvedOn, setResolvedOn] = useState(today());
  const [resolvedBy, setResolvedBy] = useState<ResolutionRoute>('institution');
  const [resolutionNote, setResolutionNote] = useState('');

  const resolve = useMutation({
    mutationFn: () =>
      complaintsApi.resolve(complaint.id, { resolvedOn, resolvedBy, resolutionNote }),
    onSuccess: async () => {
      onDone();
      await queryClient.invalidateQueries({ queryKey: ['complaints'] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    resolve.error instanceof ApiRequestError ? resolve.error.fieldError(field) : undefined;

  return (
    <>
      <form
        className="report-controls"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          resolve.mutate();
        }}
      >
        <Field
          id={`resolved-on-${complaint.id}`}
          label="Resolved on"
          hint={`Cannot precede ${formatDate(complaint.receivedOn)}, the day it was received.`}
          error={fieldError('resolvedOn')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={resolvedOn}
              required
              onChange={(event) => {
                setResolvedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id={`resolved-by-${complaint.id}`}
          label="Resolved by"
          hint="MSP2-06 accounts for a resolution on one of these two lines and no other."
          error={fieldError('resolvedBy')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={resolvedBy}
              onChange={(event) => {
                setResolvedBy(event.target.value as ResolutionRoute);
              }}
            >
              {RESOLUTION_ROUTES.map((route) => (
                <option key={route} value={route}>
                  {ROUTE_LABELS[route]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id={`resolution-note-${complaint.id}`}
          label="What was done"
          error={fieldError('resolutionNote')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              value={resolutionNote}
              required
              maxLength={2000}
              onChange={(event) => {
                setResolutionNote(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="report-controls__action">
          <button className="button button--primary" type="submit" disabled={resolve.isPending}>
            {resolve.isPending ? 'Saving…' : 'Record resolution'}
          </button>
        </div>
      </form>

      {resolve.error !== null && <ErrorNotice error={resolve.error} />}
    </>
  );
}

function ReferForm({ complaint, onDone }: { complaint: Complaint; onDone: () => void }): ReactNode {
  const queryClient = useQueryClient();
  const [referredTo, setReferredTo] = useState<ReferralDestination>('bank_of_tanzania');
  const [referredOn, setReferredOn] = useState(today());

  const refer = useMutation({
    mutationFn: () => complaintsApi.refer(complaint.id, { referredTo, referredOn }),
    onSuccess: async () => {
      onDone();
      await queryClient.invalidateQueries({ queryKey: ['complaints'] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    refer.error instanceof ApiRequestError ? refer.error.fieldError(field) : undefined;

  return (
    <>
      <form
        className="report-controls"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          refer.mutate();
        }}
      >
        <Field
          id={`referred-to-${complaint.id}`}
          label="Referred to"
          hint="BOT names these four and no others."
          error={fieldError('referredTo')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={referredTo}
              onChange={(event) => {
                setReferredTo(event.target.value as ReferralDestination);
              }}
            >
              {REFERRAL_DESTINATIONS.map((destination) => (
                <option key={destination} value={destination}>
                  {DESTINATION_LABELS[destination]}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id={`referred-on-${complaint.id}`}
          label="Referred on"
          error={fieldError('referredOn')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={referredOn}
              required
              onChange={(event) => {
                setReferredOn(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="report-controls__action">
          <button className="button button--primary" type="submit" disabled={refer.isPending}>
            {refer.isPending ? 'Saving…' : 'Record referral'}
          </button>
        </div>
      </form>

      {refer.error !== null && <ErrorNotice error={refer.error} />}
    </>
  );
}

/**
 * Logging one.
 *
 * The branch comes from a served list rather than from the session, because a
 * user with institution-wide authority has no branch on their session and would
 * otherwise be unable to log anything.
 */
function LogComplaintForm({
  natures,
  onLogged,
}: {
  natures: readonly ComplaintNature[];
  onLogged: () => void;
}): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const branchList = useQuery({
    queryKey: ['branches'],
    queryFn: () => branchesApi.list(),
    staleTime: Number.POSITIVE_INFINITY,
  });

  const [complainantName, setComplainantName] = useState('');
  const [branchId, setBranchId] = useState(session.user?.branch?.id ?? '');
  const [natureCode, setNatureCode] = useState('');
  const [summary, setSummary] = useState('');
  const [amount, setAmount] = useState('');
  const [receivedOn, setReceivedOn] = useState(today());

  const log = useMutation({
    mutationFn: () =>
      complaintsApi.log({
        complainantName,
        branchId,
        natureCode,
        summary,
        receivedOn,
        // Omitted rather than sent as '' — the amount in dispute is optional,
        // and zero is a different answer from "not stated".
        ...(amount === '' ? {} : { amount }),
      }),
    onSuccess: async () => {
      setComplainantName('');
      setNatureCode('');
      setSummary('');
      setAmount('');
      onLogged();
      await queryClient.invalidateQueries({ queryKey: ['complaints'] });
    },
  });

  const fieldError = (field: string): string | undefined =>
    log.error instanceof ApiRequestError ? log.error.fieldError(field) : undefined;

  const openBranches = (branchList.data ?? []).filter((branch) => branch.status === 'active');

  return (
    <>
      <form
        className="product-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          log.mutate();
        }}
      >
        <Field
          id="complainant-name"
          label="Complainant"
          hint="A complainant need not be a client on the books."
          error={fieldError('complainantName')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              value={complainantName}
              required
              maxLength={200}
              onChange={(event) => {
                setComplainantName(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="complaint-branch" label="Branch" error={fieldError('branchId')}>
          {(props) => (
            <select
              {...props}
              className="input"
              value={branchId}
              required
              onChange={(event) => {
                setBranchId(event.target.value);
              }}
            >
              <option value="">Choose a branch…</option>
              {openBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="complaint-nature"
          label="Nature"
          hint="One of BOT's six categories. Their form has a column for each and no room for a seventh."
          error={fieldError('natureCode')}
        >
          {(props) => (
            <select
              {...props}
              className="input"
              value={natureCode}
              required
              onChange={(event) => {
                setNatureCode(event.target.value);
              }}
            >
              <option value="">Choose a category…</option>
              {natures.map((nature) => (
                <option key={nature.code} value={nature.code}>
                  {nature.name}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id="complaint-received-on"
          label="Received on"
          hint="The quarter is taken from this date, never typed separately."
          error={fieldError('receivedOn')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              type="date"
              value={receivedOn}
              required
              onChange={(event) => {
                setReceivedOn(event.target.value);
              }}
            />
          )}
        </Field>

        <Field
          id="complaint-amount"
          label="Amount in dispute"
          hint="Leave blank where no amount is in dispute. Zero is a different answer."
          error={fieldError('amount')}
        >
          {(props) => (
            <input
              {...props}
              className="input"
              inputMode="decimal"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
              }}
            />
          )}
        </Field>

        <Field id="complaint-summary" label="Summary" error={fieldError('summary')}>
          {(props) => (
            <input
              {...props}
              className="input"
              value={summary}
              required
              maxLength={2000}
              onChange={(event) => {
                setSummary(event.target.value);
              }}
            />
          )}
        </Field>

        <div className="form-actions">
          <button className="button button--primary" type="submit" disabled={log.isPending}>
            {log.isPending ? 'Recording…' : 'Record complaint'}
          </button>
        </div>
      </form>

      {log.error !== null && <ErrorNotice error={log.error} />}
    </>
  );
}
