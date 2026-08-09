import { type ReactNode } from 'react';

import { formatStatus } from '../lib/format.js';

/** Tone for each status the system shows, so colour carries the same meaning everywhere. */
const TONES: Record<string, string> = {
  draft: 'neutral',
  pending_approval: 'warning',
  approved: 'info',
  rejected: 'danger',
  active: 'success',
  completed: 'neutral',
  written_off: 'danger',
  inactive: 'neutral',
};

/**
 * A status, shown as a label.
 *
 * The text is always rendered, never colour alone — a reader who cannot
 * distinguish the tones still sees the word.
 */
export function StatusBadge({ status }: { status: string }): ReactNode {
  const tone = TONES[status] ?? 'neutral';
  return <span className={`badge badge--${tone}`}>{formatStatus(status)}</span>;
}
