import { ApiError } from './errors.js';

/**
 * Keyset pagination over UUIDv7 identifiers.
 *
 * Every table in this schema uses `uuid_generate_v7()`, which puts a
 * millisecond timestamp in the most significant bytes. Postgres compares `uuid`
 * byte-wise, so ordering by `id DESC` *is* ordering by creation time, newest
 * first — with no second sort column, no tie-break, and no separate index.
 *
 * That is what makes the cursor a single value. A `(created_at, id)` cursor
 * would need both halves encoded, both compared as a row constructor, and a
 * composite index to stay a seek rather than a sort. The identifier already
 * carries the ordering, so none of that is necessary.
 *
 * The cursor is opaque to callers by contract (`pagination.ts` says so), but it
 * is not a secret and is not pretending to be: it is a base64url identifier a
 * determined caller can decode. What matters is that it is *validated* — a
 * cursor is a caller-supplied value that reaches a query, so it is parsed into
 * a UUID before it goes anywhere near one.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Encode the last row's identifier as a continuation token. */
export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

/**
 * Decode a caller-supplied cursor.
 *
 * @throws {ApiError} `validation_failed` when it is not a cursor this server
 * issued. Refused rather than ignored: silently starting from the top would
 * hand back page one when the caller asked for page nine, which reads as data
 * loss rather than as a bad parameter.
 */
export function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');

  if (!UUID.test(decoded)) {
    throw new ApiError('validation_failed', 'That page cursor is not valid.', [
      { path: ['cursor'], message: 'Pass back the nextCursor from the previous page.' },
    ]);
  }

  return decoded;
}

/** A page assembled from one extra row. */
export interface PagedRows<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Turn `limit + 1` rows into a page and a cursor.
 *
 * Querying one row beyond the page is how "is there a next page?" is answered
 * without a second query and without a count. If the extra row came back there
 * is more; it is dropped from the results and the last kept row becomes the
 * cursor.
 */
export function toPage<T extends { id: string }>(rows: readonly T[], limit: number): PagedRows<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor: hasMore && last !== undefined ? encodeCursor(last.id) : null,
  };
}
