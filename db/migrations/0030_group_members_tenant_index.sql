-- The tenant index `group_members` was created without.
--
-- Migration 0029 gave the table two access-path indexes — `(group_id)` and
-- `(client_id)` — and no index leading on `institution_id`. Every other tenant
-- table has one, `schema-invariants.test.ts` asserts it, and the assertion
-- failed on the commit that added the table. This is that invariant doing the
-- job it was written for: the omission was caught by CI rather than by a slow
-- query on a database with more than one institution in it.
--
-- Why it matters here rather than merely being a rule. Row-level security adds
-- `institution_id = current_institution_id()` to every statement against this
-- table. With `(group_id)` leading, "the members of this group" is an index
-- seek and the tenant predicate is a filter applied afterwards — which is
-- correct, and costs nothing while one institution's rows are most of the
-- table. It stops being free as tenants are added, and it is invisible when it
-- does, because the answers stay right.
--
-- Rather than add a third index that only satisfies the rule, the two existing
-- ones are made tenant-leading. That is the shape `groups` itself already uses
-- — `groups_institution_status_idx (institution_id, status)` — and it leaves
-- the table with the same number of indexes it had, each now serving both the
-- tenant predicate and its access path.
--
-- `group_members_one_current_per_client` is deliberately untouched. It is a
-- uniqueness rule, not an access path, and it is already tenant-safe: a group
-- belongs to exactly one institution by composite foreign key, so uniqueness
-- within a group cannot span two.

DROP INDEX group_members_group_idx;
DROP INDEX group_members_client_idx;

CREATE INDEX group_members_institution_group_idx
  ON group_members (institution_id, group_id);

CREATE INDEX group_members_institution_client_idx
  ON group_members (institution_id, client_id);

COMMENT ON INDEX group_members_institution_group_idx IS
  'Members of one group, within the tenant: the roll-call path.';
COMMENT ON INDEX group_members_institution_client_idx IS
  'Groups one client belongs to, within the tenant.';
