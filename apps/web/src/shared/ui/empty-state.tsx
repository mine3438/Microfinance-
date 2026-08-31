import { type ReactNode } from 'react';

/**
 * Nothing to show, and why.
 *
 * Distinguishing "no records yet" from "nothing matched your filter" matters:
 * the first is answered by adding a record, the second by clearing a search
 * box, and a single blank table cannot tell a user which they are looking at.
 */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      <p className="empty-state__title">{title}</p>
      {children !== undefined && <p className="empty-state__body">{children}</p>}
      {action !== undefined && <div className="empty-state__action">{action}</div>}
    </div>
  );
}
