import { type Permission } from '@mfi/contracts';
import { type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';

import { useSession } from '../features/auth/session.js';
import { Panel } from '../shared/ui/panel.js';
import { Spinner } from '../shared/ui/spinner.js';

/**
 * Routes a signed-out visitor may not reach.
 *
 * Waits for the session restore to finish before deciding. Redirecting while
 * the refresh is still in flight would bounce every reload to the login page
 * and back, which reads as the app losing your session on every refresh.
 */
export function RequireSession({ children }: { children: ReactNode }): ReactNode {
  const session = useSession();
  const location = useLocation();

  if (session.status === 'restoring') {
    return <Spinner label="Restoring your session" />;
  }

  if (session.status === 'signed-out') {
    // Where they were going is remembered, so signing in returns them there
    // rather than to a dashboard they did not ask for.
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }

  return children;
}

/**
 * Routes a permission is required for.
 *
 * Shows a clean refusal rather than a half-rendered page. The system this
 * replaces let an officer reach `/settings` and rendered it with every query
 * failing, so the screen filled with error states and empty tables — the user
 * could not tell "you may not do this" from "this is broken" (App Flow §1).
 *
 * This is presentation only. The API refuses the same request regardless, which
 * is what actually protects the data.
 */
export function RequirePermission({
  permission,
  children,
}: {
  permission: Permission;
  children: ReactNode;
}): ReactNode {
  const session = useSession();

  if (!session.can(permission)) {
    return (
      <Panel tone="warning" title="You do not have access to this page">
        <p>
          This page needs the <code>{permission}</code> permission, which your role does not hold.
          If you need it, ask an administrator at your institution.
        </p>
      </Panel>
    );
  }

  return children;
}
