import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  DEFAULT_PAGE_SIZE,
  MAXIMUM_PAGE_SIZE,
  pageSchema,
  paginationQuerySchema,
} from './pagination.js';

describe('paginationQuerySchema', () => {
  it('defaults the page size when the caller does not ask', () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE });
  });

  it('coerces the limit from a query string, where everything is text', () => {
    expect(paginationQuerySchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('caps the page size', () => {
    // Without a cap, `?limit=1000000` is a denial-of-service request that looks
    // like a legitimate one, and it costs a full scan to discover otherwise.
    expect(paginationQuerySchema.safeParse({ limit: '1000000' }).success).toBe(false);
    expect(paginationQuerySchema.parse({ limit: String(MAXIMUM_PAGE_SIZE) }).limit).toBe(
      MAXIMUM_PAGE_SIZE,
    );
  });

  it.each(['0', '-1', '1.5', 'all', ''])('rejects a limit of %s', (limit) => {
    expect(paginationQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('bounds the cursor length, since it arrives from the caller', () => {
    expect(paginationQuerySchema.safeParse({ cursor: 'x'.repeat(513) }).success).toBe(false);
  });

  it('accepts a cursor that came from a previous page', () => {
    expect(paginationQuerySchema.parse({ cursor: 'eyJpZCI6IjEifQ' }).cursor).toBe('eyJpZCI6IjEifQ');
  });

  it('rejects an unrecognised query parameter rather than defaulting quietly', () => {
    expect(paginationQuerySchema.safeParse({ limt: '100' }).success).toBe(false);
  });

  it('keeps rejecting unknown keys after an endpoint extends it with filters', () => {
    const withFilters = paginationQuerySchema.extend({ status: z.string().optional() });

    expect(withFilters.safeParse({ status: 'active' }).success).toBe(true);
    expect(withFilters.safeParse({ status: 'active', stauts: 'x' }).success).toBe(false);
  });
});

describe('pageSchema', () => {
  const page = pageSchema(z.object({ id: z.string() }));

  it('describes a page with a continuation', () => {
    expect(page.parse({ items: [{ id: 'a' }], nextCursor: 'abc' }).nextCursor).toBe('abc');
  });

  it('uses a null cursor for the last page', () => {
    expect(page.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
  });

  it('has no total, which is the cost keyset pagination exists to avoid', () => {
    // Counting matching rows on every request is the query that degrades first
    // on a table that grows for the life of the institution.
    expect(page.safeParse({ items: [], nextCursor: null, total: 0 }).success).toBe(false);
  });
});
