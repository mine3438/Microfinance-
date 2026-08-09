import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  ApiRequestError,
  NetworkError,
  apiRequest,
  clearAccessToken,
  onSessionEnded,
  restoreSession,
  setAccessToken,
} from './client.js';

const bodySchema = z.object({ ok: z.literal(true) }).strict();

/**
 * A fresh response every call.
 *
 * A `Response` body can be read once. Handing the same object to two mocked
 * calls fails on the second with "Body has already been read", which looks like
 * a bug in the client rather than in the mock — so every stub builds a new one.
 */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}): unknown {
  return { error: { code, message, correlationId: 'trace-1', ...extra } };
}

/** Typed, so `mockImplementation` is checked against what `fetch` returns. */
type FetchMock = ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;

let fetchMock: FetchMock;

/** The init of the nth call, asserted to exist so a miss fails loudly. */
function requestOf(index: number): RequestInit {
  const call = fetchMock.mock.calls[index];
  if (call === undefined) {
    throw new Error(`Expected a fetch call at index ${String(index)}.`);
  }
  return call[1] ?? {};
}

beforeEach(() => {
  fetchMock = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();
  vi.stubGlobal('fetch', fetchMock);
  clearAccessToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('parses a response against the shared schema', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(apiRequest('/thing', bodySchema)).resolves.toEqual({ ok: true });
  });

  it('sends the access token when one is held, and not when it is not', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { ok: true })));

    await apiRequest('/thing', bodySchema);
    const withoutToken = requestOf(0);
    expect(
      (withoutToken.headers as Record<string, string | undefined>)['authorization'],
    ).toBeUndefined();

    setAccessToken('a-token');
    await apiRequest('/thing', bodySchema);
    const withToken = requestOf(1);
    expect((withToken.headers as Record<string, string | undefined>)['authorization']).toBe(
      'Bearer a-token',
    );
  });

  it('turns a described refusal into a typed error carrying its field details', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        400,
        errorBody('validation_failed', 'That is not valid.', {
          details: [{ path: ['principal'], message: 'Too small.' }],
        }),
      ),
    );

    const error = await apiRequest('/thing', bodySchema).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).fieldError('principal')).toBe('Too small.');
    expect((error as ApiRequestError).fieldError('nothing')).toBeUndefined();
  });

  it('refuses a response whose shape it does not recognise', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unexpected: true }));

    // Surfaced rather than rendered. A component handed a half-parsed object
    // shows "undefined" where an amount belongs, which reads as a data problem
    // rather than a version mismatch.
    await expect(apiRequest('/thing', bodySchema)).rejects.toBeInstanceOf(NetworkError);
  });

  it('reports a failure that never reached the server as a network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

    await expect(apiRequest('/thing', bodySchema)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('refreshing after a 401', () => {
  it('refreshes once and retries the original request', async () => {
    setAccessToken('expired');

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, errorBody('unauthenticated', 'Nope.')))
      .mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

    await expect(apiRequest('/thing', bodySchema)).resolves.toEqual({ ok: true });

    expect(fetchMock.mock.calls[1]?.[0]).toContain('/auth/refresh');
    const retried = requestOf(2);
    expect((retried.headers as Record<string, string | undefined>)['authorization']).toBe(
      'Bearer fresh',
    );
  });

  it('refreshes only once when several requests expire together', async () => {
    setAccessToken('expired');

    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/auth/refresh')) {
        return Promise.resolve(jsonResponse(200, { accessToken: 'fresh' }));
      }
      // Every request 401s until a fresh token is in play; after that they pass.
      return Promise.resolve(jsonResponse(200, { ok: true }));
    });

    // The first call 401s, the rest arrive while the refresh is in flight.
    fetchMock.mockResolvedValueOnce(jsonResponse(401, errorBody('unauthenticated', 'Nope.')));

    await Promise.all([
      apiRequest('/a', bodySchema),
      apiRequest('/b', bodySchema),
      apiRequest('/c', bodySchema),
    ]);

    const refreshes = fetchMock.mock.calls.filter((call) => call[0].includes('/auth/refresh'));

    // Every refresh rotates the token. Four parallel refreshes would mean three
    // of them presenting a token already rotated past — which the server treats
    // as a replayed token and answers by revoking the whole family. The user's
    // own concurrency would end their session.
    expect(refreshes.length).toBeLessThanOrEqual(1);
  });

  it('ends the session when the refresh is refused', async () => {
    setAccessToken('expired');

    const ended = vi.fn();
    const unsubscribe = onSessionEnded(ended);

    fetchMock
      .mockResolvedValueOnce(jsonResponse(401, errorBody('unauthenticated', 'Nope.')))
      .mockResolvedValueOnce(jsonResponse(401, errorBody('unauthenticated', 'Session over.')));

    await expect(apiRequest('/thing', bodySchema)).rejects.toBeInstanceOf(ApiRequestError);
    expect(ended).toHaveBeenCalled();

    unsubscribe();
  });

  it('does not try to refresh when no token was held', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, errorBody('unauthenticated', 'Nope.')));

    await expect(apiRequest('/thing', bodySchema)).rejects.toBeInstanceOf(ApiRequestError);

    // One call, not two: refreshing an anonymous 401 would loop.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends credentials, so the HttpOnly refresh cookie is attached', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { accessToken: 'fresh' }));

    await restoreSession();

    const request = requestOf(0);
    expect(request.credentials).toBe('include');
  });
});
