import { type ReactNode } from 'react';

export type PanelTone = 'neutral' | 'warning' | 'danger' | 'success';

/**
 * A titled block of content.
 *
 * Lives in `shared/ui` rather than beside the first feature that needed it —
 * the UX brief records generic primitives having ended up inside the auth
 * feature folder in the previous build, where nothing else could find them
 * (§3), so the second screen reimplemented them.
 */
export function Panel({
  title,
  tone = 'neutral',
  actions,
  children,
}: {
  title?: string;
  tone?: PanelTone;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <section className={`panel panel--${tone}`}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel__header">
          {title !== undefined && <h2 className="panel__title">{title}</h2>}
          {actions !== undefined && <div className="panel__actions">{actions}</div>}
        </header>
      )}
      <div className="panel__body">{children}</div>
    </section>
  );
}
