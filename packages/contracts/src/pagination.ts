import { z } from 'zod';

/** Pages returned when the caller does not ask for a size. */
export const DEFAULT_PAGE_SIZE = 25;

/**
 * Largest page the API will return.
 *
 * A cap, not a suggestion. Without one, `?limit=1000000` is a denial-of-service
 * request that looks like a legitimate one, and it costs the server a full scan
 * to find that out.
 */
export const MAXIMUM_PAGE_SIZE = 100;

/**
 * Keyset pagination, on every list endpoint.
 *
 * Offset pagination (`LIMIT n OFFSET m`) degrades linearly with depth — the
 * database walks and discards every skipped row — and it degrades exactly where
 * a growing loan book hurts most, which is the far pages of the oldest data.
 * It is also incorrect under concurrent writes: a loan created while an officer
 * pages through the list shifts every subsequent row, so a record can be seen
 * twice or missed entirely. On a portfolio listing that is a reconciliation
 * problem, not a cosmetic one.
 *
 * A cursor names the last row seen, so the next page is an index seek and the
 * result set is stable regardless of what else is being written.
 */
export const paginationQuerySchema = z
  .object({
    /**
     * Opaque continuation token from the previous page's `nextCursor`.
     *
     * Opaque deliberately: it encodes the sort key of the last row, and a
     * client that decodes and edits it is depending on an ordering the server
     * is free to change. Callers pass back what they were given, or start from
     * the top.
     */
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int('Page size must be a whole number.')
      .min(1, 'Page size must be at least 1.')
      .max(MAXIMUM_PAGE_SIZE, `Page size may not exceed ${String(MAXIMUM_PAGE_SIZE)}.`)
      .default(DEFAULT_PAGE_SIZE),
  })
  // Strict, and it survives `.extend()`, so an endpoint adding its own filters
  // keeps the property. A mistyped `?limt=100` returning a quiet default page
  // is the same class of defect as a mistyped body field: the caller believes
  // it asked for something it did not.
  .strict();

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/**
 * A page of results.
 *
 * There is no `total`. Counting the matching rows on every request is the cost
 * keyset pagination exists to avoid, and on a table that grows for the life of
 * the institution it is the query that degrades first. Where a count is
 * genuinely needed — a dashboard figure, a regulatory total — it is its own
 * endpoint, computed once and cached, rather than a toll paid by every page of
 * every list.
 */
export const pageSchema = <T extends z.ZodType>(
  item: T,
): z.ZodObject<
  {
    items: z.ZodArray<T>;
    nextCursor: z.ZodNullable<z.ZodString>;
  },
  z.core.$strict
> =>
  z
    .object({
      items: z.array(item),
      /** `null` when this is the last page. */
      nextCursor: z.string().nullable(),
    })
    .strict();

export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}
