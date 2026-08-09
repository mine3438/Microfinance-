import { type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';

import { useSession } from '../features/auth/session.js';

/** The frame every signed-in page renders inside. */
export function Shell(): ReactNode {
  const session = useSession();

  return (
    <div className="shell">
      <header className="shell__bar">
        <div className="shell__brand">
          <span className="shell__brand-name">MFI Manager</span>
          <span className="shell__institution">{session.user?.institutionName}</span>
        </div>

        <nav className="shell__nav" aria-label="Main">
          {/* Nav entries follow permissions, so a role never sees a link to a
              page that would refuse it. The API refuses regardless. */}
          {session.can('client.read') && <NavLink to="/clients">Borrowers</NavLink>}
          {session.can('loan.read') && <NavLink to="/loans">Loans</NavLink>}
        </nav>

        <div className="shell__account">
          <span className="shell__user">
            {session.user?.fullName}
            {session.user?.branch !== null && session.user?.branch !== undefined && (
              <span className="shell__branch"> · {session.user.branch.name}</span>
            )}
          </span>
          <button
            className="button button--small"
            type="button"
            onClick={() => {
              void session.signOut();
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="shell__main">
        <Outlet />
      </main>
    </div>
  );
}
