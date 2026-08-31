-- The access path the audit log is actually read by.
--
-- Migration 0006 built the trail and three indexes for it, and left the
-- application no way to read any of them: `audit.read` is granted to
-- `institution_admin` and `auditor`, the policy on `audit_logs` checks it, and
-- until now nothing in the API selected from the table. An institution under
-- BOT supervision could produce the evidence only by opening psql.
--
-- Reading it needs one index that 0006 does not have. The reader pages by
-- keyset on the identifier — `WHERE institution_id = ... AND id < $1 ORDER BY
-- id DESC` — which is how every other list in this system pages, and for the
-- reason `http/cursor.ts` sets out: `uuid_generate_v7()` puts the timestamp in
-- the leading bytes, so ordering by id *is* ordering by time, with no tie-break
-- and no second sort column.
--
-- `audit_logs_institution_changed_idx (institution_id, changed_at DESC)` cannot
-- serve that. Ordering by `id` against an index keyed on `changed_at` leaves
-- Postgres to walk the primary key backwards and discard every row belonging to
-- another institution — which costs nothing in a single-tenant test database
-- and degrades with each tenant added in production. That is the same shape of
-- defect as a job with no caller: correct in development, quietly wrong where
-- it matters.
--
-- The existing index is kept. It answers "what happened between these two
-- dates", which is a range scan on `changed_at` and not what this one is for.

CREATE INDEX audit_logs_institution_id_idx ON audit_logs (institution_id, id DESC);

COMMENT ON INDEX audit_logs_institution_id_idx IS
  'Keyset pagination for the audit reader: tenant, then newest-first by UUIDv7 identifier.';
