import { type ReactNode } from 'react';

import { formatStatus } from '../lib/format.js';

/** The five tones the stylesheet defines, named so a caller cannot invent a sixth. */
export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** Tone for each status the system shows, so colour carries the same meaning everywhere. */
const TONES: Record<string, BadgeTone> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  rejected: 'danger',
  active: 'success',
  completed: 'neutral',
  written_off: 'danger',
  // Closed, and not a loss: the debt moved to a successor loan rather than
  // being given up on. Given its own tone because the default is `neutral`,
  // which is `completed`'s — and a restructured loan rendering exactly like a
  // repaid one is the confusion the two separate statuses exist to prevent.
  restructured: 'info',
  inactive: 'neutral',
};

/**
 * A short label in one of the five tones.
 *
 * The text is always rendered, never colour alone — a reader who cannot
 * distinguish the tones still sees the word. That is the rule this component
 * exists to make unavoidable, so nothing renders a bare coloured dot.
 */
export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}): ReactNode {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

/**
 * A status, shown as a label.
 *
 * A {@link Badge} whose tone comes from the status rather than from the caller,
 * so one status is never two colours in two places.
 */
export function StatusBadge({ status }: { status: string }): ReactNode {
  return <Badge tone={TONES[status] ?? 'neutral'}>{formatStatus(status)}</Badge>;
}
