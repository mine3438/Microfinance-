import { type Permission, type SessionUser } from '@mfi/contracts';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import { auth } from '../../shared/api/endpoints.js';
import {
  clearAccessToken,
  onSessionEnded,
  restoreSession,
  setAccessToken,
} from '../../shared/api/client.js';

/**
 * Who is signed in, for the whole app.
 *
 * The permissions held here are a **convenience for rendering**, never a
 * control. Every one of them is checked again by the API on every request, and
 * the interface is not the only way in — hiding a button stops an honest user
 * doing the wrong thing by accident and stops nobody else.
 */
export interface Session {
  readonly user: SessionUser | null;
  readonly status: 'restoring' | 'signed-in' | 'signed-out';
  signIn(email: string, password: string): Promise<void>;
  signOut(): Promise<void>;
  can(permission: Permission): boolean;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }): ReactNode {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [status, setStatus] = useState<Session['status']>('restoring');

  /**
   * Recover a session on first load.
   *
   * The access token lives in memory, so a reload loses it. The refresh cookie
   * is `HttpOnly` and survives — which is the point of putting it there — so
   * the app asks for a new access token before deciding the user is signed out.
   * Without this, every refresh of the page would look like a logout.
   */
  useEffect(() => {
    // An AbortController rather than a boolean flag. Under StrictMode this
    // effect runs twice in development, and the first run's response can land
    // after the second has started — writing state from a cancelled run would
    // show a signed-out user as signed in.
    //
    // A plain `let cancelled = false` also reads as always-false to the
    // compiler, because the cleanup that sets it runs outside the closure's
    // visible control flow. `signal.aborted` carries no such narrowing.
    const controller = new AbortController();
    // Read through a call rather than a property. Once `signal.aborted` has
    // been tested, the compiler treats it as settled for the rest of the block
    // — including after an `await`, during which the cleanup may well have run.
    // A function result carries no such narrowing, so each check is a fresh
    // read, which is what the code actually means.
    const cancelled = (): boolean => controller.signal.aborted;

    void (async (): Promise<void> => {
      const restored = await restoreSession();
      if (cancelled()) {
        return;
      }

      if (!restored) {
        setStatus('signed-out');
        return;
      }

      try {
        const me = await auth.me();
        if (!cancelled()) {
          setUser(me);
          setStatus('signed-in');
        }
      } catch {
        if (!cancelled()) {
          clearAccessToken();
          setStatus('signed-out');
        }
      }
    })();

    return () => {
      controller.abort();
    };
  }, []);

  // The API client ends the session when a refresh fails — a revoked family, a
  // suspended account, an expired refresh token. The provider follows it rather
  // than polling, so a session that ended server-side ends here too.
  useEffect(
    () =>
      onSessionEnded(() => {
        setUser(null);
        setStatus('signed-out');
      }),
    [],
  );

  const signIn = useCallback(async (email: string, password: string): Promise<void> => {
    const response = await auth.login({ email, password });
    setAccessToken(response.accessToken);
    setUser(response.user);
    setStatus('signed-in');
  }, []);

  const signOut = useCallback(async (): Promise<void> => {
    try {
      // Told to the server so the refresh family is revoked. Clearing only the
      // local token would leave a thirty-day credential live in the cookie jar.
      await auth.logout();
    } finally {
      clearAccessToken();
      setUser(null);
      setStatus('signed-out');
    }
  }, []);

  const value = useMemo<Session>(
    () => ({
      user,
      status,
      signIn,
      signOut,
      can: (permission) => user?.permissions.includes(permission) ?? false,
    }),
    [user, status, signIn, signOut],
  );

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): Session {
  const session = use(SessionContext);
  if (session === null) {
    throw new Error('useSession must be used inside a SessionProvider.');
  }
  return session;
}
