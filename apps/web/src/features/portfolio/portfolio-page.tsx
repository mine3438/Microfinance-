import { type OverdueClassification, type PortfolioSummary } from '@mfi/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';

import { portfolio as portfolioApi } from '../../shared/api/endpoints.js';
import { formatMoney } from '../../shared/lib/format.js';
import { Badge, type BadgeTone } from '../../shared/ui/badge.js';
import { EmptyState } from '../../shared/ui/empty-state.js';
import { ErrorNotice } from '../../shared/ui/error-notice.js';
import { Panel } from '../../shared/ui/panel.js';
import { Spinner } from '../../shared/ui/spinner.js';
import { useSession } from '../auth/session.js';

/**
 * The loan book by BOT's classifications.
 *
 * This is the screen the classification job was always for, and until it
 * existed the job wrote three columns nothing read. The MSP2 compilers
 * deliberately do not read them: a return for a quarter that closed six weeks
 * ago must describe the book as it stood then, so they reconstruct
 * classification point-in-time. These figures are today's.
 *
 * **How old they are is part of the figure, not a footnote.** The defect this
 * whole system replaces was a classification job that silently stopped running
 * while the dashboard kept showing its last answer as though it were current —
 * a loan forty days overdue reading "Current" to the people deciding whether to
 * lend again (00-PROJECT-ANALYSIS.md R5). So the age is stated at the top, in
 * words, and turns into a warning before it turns into a number nobody reads.
 *
 * Nothing is computed here. The counts, the totals and the non-performing ratio
 * all arrive from the server, which derives the ratio through the same domain
 * function MSP2-03 line 73 uses — a second implementation on this side could
 * disagree with the return by a shilling and nobody would know which was right.
 */

const CLASS_LABELS: Record<OverdueClassification, string> = {
  current: 'Current',
  esm: 'Especially Mentioned',
  substandard: 'Substandard',
  doubtful: 'Doubtful',
  loss: 'Loss',
};

/** BOT counts the last three as non-performing. */
const CLASS_TONES: Record<OverdueClassification, BadgeTone> = {
  current: 'success',
  esm: 'warning',
  substandard: 'danger',
  doubtful: 'danger',
  loss: 'danger',
};

/** The age beyond which the readiness gate refuses a return. */
const STALE_AFTER_HOURS = 24;

export function PortfolioPage(): ReactNode {
  const session = useSession();
  const queryClient = useQueryClient();

  const summary = useQuery({
    queryKey: ['portfolio-summary'],
    queryFn: () => portfolioApi.summary(),
  });

  const reclassify = useMutation({
    mutationFn: () => portfolioApi.reclassify(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['portfolio-summary'] });
    },
  });

  return (
    <div className="page">
      <div className="page__header">
        <div>
          <h1 className="page__title">Portfolio</h1>
          <p className="page__subtitle">
            The loan book by the Bank of Tanzania&rsquo;s five classifications, as at the last
            classification run.
          </p>
        </div>
      </div>

      {summary.isPending && <Spinner label="Loading the portfolio" />}
      {summary.error !== null && <ErrorNotice error={summary.error} />}

      {summary.data !== undefined && (
        <>
          <Freshness
            summary={summary.data}
            canRun={session.can('report.generate')}
            running={reclassify.isPending}
            onRun={() => {
              reclassify.mutate();
            }}
          />

          {reclassify.error !== null && <ErrorNotice error={reclassify.error} />}

          <Panel title="By classification">
            {summary.data.totalLoans === 0 && summary.data.unclassifiedLoanCount === 0 ? (
              <EmptyState title="No active loans">
                Classification describes the loans on the book. There are none yet.
              </EmptyState>
            ) : (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Classification</th>
                      <th scope="col" className="numeric">
                        Loans
                      </th>
                      <th scope="col" className="numeric">
                        Outstanding
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.data.classes.map((row) => (
                      <tr key={row.classification}>
                        <td>
                          <Badge tone={CLASS_TONES[row.classification]}>
                            {CLASS_LABELS[row.classification]}
                          </Badge>
                        </td>
                        <td className="numeric">{row.loanCount}</td>
                        <td className="numeric">{formatMoney(row.outstanding)}</td>
                      </tr>
                    ))}

                    {summary.data.unclassifiedLoanCount > 0 && (
                      // Never folded into Current. BOT has no column for these
                      // (§11.5), and calling them performing makes a book look
                      // healthier than it is.
                      <tr>
                        <td>
                          <Badge tone="neutral">Unclassified</Badge>
                        </td>
                        <td className="numeric">{summary.data.unclassifiedLoanCount}</td>
                        <td className="numeric">—</td>
                      </tr>
                    )}

                    <tr className="row--computed">
                      <td>Total</td>
                      <td className="numeric">{summary.data.totalLoans}</td>
                      <td className="numeric">{formatMoney(summary.data.totalOutstanding)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            )}

            <p className="hint-block">
              Non-performing ratio: <strong>{summary.data.nonPerformingRatio}%</strong> —
              Substandard, Doubtful and Loss over total outstanding, which is MSP2-03 line
              73&rsquo;s own definition.
            </p>
          </Panel>
        </>
      )}
    </div>
  );
}

/**
 * How old these figures are, said before they are shown.
 *
 * Three states rather than two, because "never run" is not a very stale run:
 * an institution that has never classified has no figures at all, and every
 * loan below would be reading as it stood at creation.
 */
function Freshness({
  summary,
  canRun,
  running,
  onRun,
}: {
  summary: PortfolioSummary;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
}): ReactNode {
  const action = canRun ? (
    <button className="button button--small" type="button" disabled={running} onClick={onRun}>
      {running ? 'Classifying…' : 'Run classification now'}
    </button>
  ) : undefined;

  if (summary.classificationsUpdatedAt === null) {
    return (
      <Panel title="These figures have never been computed" tone="danger" actions={action}>
        <p className="notice__message">
          The classification job has not run for this institution, so every loan below reads as it
          stood when it was created. Nothing here describes the book as it is today.
        </p>
      </Panel>
    );
  }

  const computedAt = new Date(summary.classificationsUpdatedAt);
  const ageHours = (Date.now() - computedAt.getTime()) / (60 * 60 * 1000);
  const stale = ageHours > STALE_AFTER_HOURS;

  return (
    <Panel
      title={stale ? 'These figures are out of date' : 'Figures are current'}
      tone={stale ? 'warning' : 'success'}
      actions={action}
    >
      <p className="notice__message">
        Classified {describeAge(ageHours)}.
        {stale
          ? ' A loan crosses from one classification into the next because a day passed, so these ' +
            'may already understate arrears. The BOT return will refuse to compile until this is rerun.'
          : ' The classification job runs daily; a return compiled now would use figures no older than these.'}
      </p>
    </Panel>
  );
}

/** Plain words rather than a timestamp, because the age is the point. */
function describeAge(ageHours: number): string {
  if (ageHours < 1) {
    return 'less than an hour ago';
  }
  if (ageHours < 2) {
    return 'an hour ago';
  }
  if (ageHours < 48) {
    return `${String(Math.floor(ageHours))} hours ago`;
  }
  return `${String(Math.floor(ageHours / 24))} days ago`;
}
