import { type ReactNode } from 'react';

/**
 * A pending state that says what it is waiting for.
 *
 * The label is required rather than optional: an unlabelled spinner tells a
 * user that something is happening and not whether it is their action, a page
 * load, or a request that has hung.
 */
export function Spinner({ label }: { label: string }): ReactNode {
  return (
    <div className="spinner" role="status" aria-live="polite">
      <span className="spinner__mark" aria-hidden="true" />
      <span className="spinner__label">{label}…</span>
    </div>
  );
}
