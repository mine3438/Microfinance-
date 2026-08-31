import { errorResponseSchema, type ErrorCode, type FieldError } from '@mfi/contracts';
import { z } from 'zod';

/**
 * The one way this client talks to the API.
 *
 * Two properties it exists to hold, both of which decay if each call site is
 * left to implement them:
 *
 * - **The access token never leaves memory.** It is held in a module variable,
 *   not in `localStorage` or `sessionStorage`, which are readable by any script
 *   on the origin and survive the tab. A page reload therefore loses it — and
 *   recovers by calling `/auth/refresh`, which presents the `HttpOnly` cookie
 *   the browser holds and script cannot read. That asymmetry is the whole
 *   design: the short-lived credential lives where XSS could reach it, the
 *   long-lived one does not.
 * - **Every response is parsed against the shared schema.** The server and this
 *   client import the same zod objects, so a shape change is a compile error
 *   here rather than `undefined` rendering as "NaN" three components deep.
 */

/** Where the API lives. Set at build time; no default that could point anywhere. */
const BASE_URL: string =
  (import.meta.env as Record<string, string | undefined>)['VITE_API_URL'] ?? '';

let accessToken: string | null = null;

/** Notified when the session ends, so the app can route to the login page. */
type SessionListener = () => void;
const sessionEndedListeners = new Set<SessionListener>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function hasAccessToken(): boolean {
  return accessToken !== null;
}

export function onSessionEnded(listener: SessionListener): () => void {
  sessionEndedListeners.add(listener);
  return () => sessionEndedListeners.delete(listener);
}

function endSession(): void {
  accessToken = null;
  for (const listener of sessionEndedListeners) {
    listener();
  }
}

/**
 * A refusal the API described, carried with its code and field errors.
 *
 * Thrown rather than returned so a component that forgets to check cannot
 * render a failure as if it were data.
 */
export class ApiRequestError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
    public readonly details: readonly FieldError[] = [],
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }

  /** The message for one field, if the server named it. */
  public fieldError(field: string): string | undefined {
    return this.details.find((detail) => detail.path[0] === field)?.message;
  }
}

/** A failure that never reached the server, or a response that was not JSON. */
export class NetworkError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  readonly body?: unknown;
  /** Set false on the auth endpoints, which manage their own token. */
  readonly authenticated?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Whether a refresh is already in flight.
 *
 * Several queries can 401 at once when a token expires — a dashboard firing
 * four requests in parallel is ordinary. Without this they would each refresh,
 * and every refresh rotates the token, so all but one would present a consumed
 * one and trip reuse detection. The session would end on the user's own
 * concurrency.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= (async (): Promise<boolean> => {
    try {
      const response = await fetch(`${BASE_URL}/auth/refresh`, {
        method: 'POST',
        // The refresh cookie is SameSite=Strict and HttpOnly; this is what
        // makes the browser attach it at all.
        credentials: 'include',
      });

      if (!response.ok) {
        return false;
      }

      const body: unknown = await response.json();
      const parsed = z.object({ accessToken: z.string() }).safeParse(body);
      if (!parsed.success) {
        return false;
      }

      accessToken = parsed.data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  if (options.authenticated !== false && accessToken !== null) {
    headers['authorization'] = `Bearer ${accessToken}`;
  }

  return fetch(`${BASE_URL}${path}`, {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}

async function toError(response: Response): Promise<never> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new NetworkError(
      `The server responded with ${String(response.status)} and no readable body.`,
    );
  }

  const parsed = errorResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new NetworkError('The server responded with an error this client cannot read.');
  }

  throw new ApiRequestError(
    parsed.data.error.code,
    parsed.data.error.message,
    response.status,
    parsed.data.error.details ?? [],
    parsed.data.error.correlationId,
  );
}

/**
 * Call the API and parse the response against a schema.
 *
 * A 401 on an authenticated call is retried once behind a refresh. Only once,
 * and only when a token was actually held: retrying an unauthenticated 401
 * would loop, and retrying twice would mean the second refresh presents a token
 * the first already rotated past.
 */
export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  options: RequestOptions = {},
): Promise<T> {
  let response: Response;
  try {
    response = await send(path, options);
  } catch (error: unknown) {
    throw new NetworkError(
      error instanceof Error ? error.message : 'The request could not be sent.',
    );
  }

  if (response.status === 401 && options.authenticated !== false && accessToken !== null) {
    if (await refreshAccessToken()) {
      response = await send(path, options);
    } else {
      endSession();
    }
  }

  if (!response.ok) {
    if (response.status === 401 && options.authenticated !== false) {
      endSession();
    }
    return toError(response);
  }

  // A 204 carries no body, and `json()` on an empty response rejects — which
  // would turn a successful delete into a network error the user is told to
  // retry.
  const body: unknown = response.status === 204 ? undefined : await response.json();
  const parsed = schema.safeParse(body);

  if (!parsed.success) {
    // The server sent something this client does not understand. Surfaced
    // rather than rendered: a component given a half-parsed object shows
    // "undefined" where an amount should be, which looks like a data problem
    // rather than a version mismatch.
    throw new NetworkError(
      'The server sent a response this version of the app does not understand. Reload the page.',
    );
  }

  return parsed.data;
}

/** Restore a session from the refresh cookie, if the browser still holds one. */
export async function restoreSession(): Promise<boolean> {
  return refreshAccessToken();
}

/** Discard the in-memory token without calling the server. */
export function clearAccessToken(): void {
  accessToken = null;
}
