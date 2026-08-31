-- Lending groups, and who belongs to them.
--
-- GROUP-01 through GROUP-04 are decided: the group is the borrower, liability
-- is joint, one disbursement to the group account, one balance, one schedule,
-- one combined repayment, and arrears and classification at the group-loan
-- level.
--
-- This migration builds the part of that which is safe to build today: the
-- group as an entity, and its membership over time. It deliberately does **not**
-- add `group_id` to `loans`, and the reason is recorded in the decision register
-- as GROUP-05.
--
-- In short: every MSP2 exposure query inner-joins `clients` on `loans.client_id`
-- — MSP2-03's sectoral classification, MSP2-09's disbursements by gender,
-- MSP2-10's borrowers by age band and district, the compulsory-savings line and
-- the write-off line. A loan whose borrower is a group has no single sector, no
-- gender, no date of birth and no district, so it would drop out of all of them
-- silently, understating the loan book on a return filed with the Bank of
-- Tanzania. No supplied document says how a group loan is reported on those
-- forms, and inventing an allocation across members would be inventing a
-- regulatory answer.
--
-- So the entity lands and the lending waits. Nothing here changes an existing
-- table, so the eventual answer is still an additive change.

-- ---------------------------------------------------------------------------
-- groups
-- ---------------------------------------------------------------------------

CREATE TABLE groups (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  -- The branch that administers the group, as a loan would be administered.
  branch_id      uuid        NOT NULL,

  code           text        NOT NULL CHECK (length(btrim(code)) > 0),
  name           text        NOT NULL CHECK (length(btrim(name)) > 0),

  -- When the group was formed, which is not the same as when somebody keyed it
  -- in. Groups exist before the software hears about them.
  formed_on      date        NOT NULL,

  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'closed')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT groups_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT groups_code_unique_per_institution UNIQUE (institution_id, code),
  CONSTRAINT groups_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id) ON DELETE RESTRICT
);

COMMENT ON TABLE groups IS
  'Lending groups. The group is the borrower under the approved joint-liability model; group lending itself waits on GROUP-05.';

CREATE INDEX groups_institution_status_idx ON groups (institution_id, status);

CREATE TRIGGER trg_groups_updated_at
  BEFORE UPDATE ON groups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE groups FORCE ROW LEVEL SECURITY;

CREATE POLICY groups_select ON groups
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY groups_insert ON groups
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY groups_update ON groups
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE. A group that has held a loan is referenced by that history; it is
-- closed, never removed — the same rule `users` and `clients` follow.
GRANT SELECT, INSERT, UPDATE ON groups TO mfi_app;

-- ---------------------------------------------------------------------------
-- group_members
-- ---------------------------------------------------------------------------

-- Membership over time, not membership now.
--
-- The approved rules require that "if membership changes while a loan exists,
-- historical loan records must remain interpretable". A table holding only the
-- current roster cannot do that: once a member leaves, the question "who was
-- jointly liable when this loan was advanced" has no answer.
--
-- So a membership is an interval. Joining opens one, leaving closes it, and a
-- member who leaves and returns has two — which is the truth, and which keeps
-- both periods legible.
CREATE TABLE group_members (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  group_id       uuid        NOT NULL,
  client_id      uuid        NOT NULL,

  joined_on      date        NOT NULL,
  /** NULL while the member is still in the group. */
  left_on        date,

  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT group_members_group_within_institution
    FOREIGN KEY (group_id, institution_id) REFERENCES groups (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT group_members_client_within_institution
    FOREIGN KEY (client_id, institution_id) REFERENCES clients (id, institution_id) ON DELETE RESTRICT,

  -- A membership cannot end before it began.
  CONSTRAINT group_members_interval_is_ordered
    CHECK (left_on IS NULL OR left_on >= joined_on)
);

COMMENT ON TABLE group_members IS
  'Membership as an interval, so who was in a group at a past date stays answerable after people come and go.';
COMMENT ON COLUMN group_members.left_on IS
  'NULL while the member is current. Closing an interval never deletes it.';

-- One live membership per client per group. A client cannot be in the same
-- group twice at once; they may rejoin after leaving, which opens a new row.
CREATE UNIQUE INDEX group_members_one_current_per_client
  ON group_members (group_id, client_id)
  WHERE left_on IS NULL;

CREATE INDEX group_members_group_idx ON group_members (group_id);
CREATE INDEX group_members_client_idx ON group_members (client_id);

ALTER TABLE group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_members FORCE ROW LEVEL SECURITY;

CREATE POLICY group_members_select ON group_members
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY group_members_insert ON group_members
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY group_members_update ON group_members
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- UPDATE exists to close an interval. No DELETE: a membership that happened
-- stays happened, which is the whole point of holding intervals.
GRANT SELECT, INSERT, UPDATE ON group_members TO mfi_app;

-- ---------------------------------------------------------------------------
-- A membership interval is closed once, and never reopened or rewritten
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_group_membership_is_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.group_id  IS DISTINCT FROM OLD.group_id
     OR NEW.client_id IS DISTINCT FROM OLD.client_id
     OR NEW.joined_on IS DISTINCT FROM OLD.joined_on THEN
    RAISE EXCEPTION 'A membership record cannot be rewritten. Close it and open another.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.left_on IS NOT NULL AND NEW.left_on IS DISTINCT FROM OLD.left_on THEN
    RAISE EXCEPTION 'That membership has already ended.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_group_membership_is_append_only() IS
  'UPDATE exists to close a membership interval. It is not a way to restate who was in a group.';

CREATE TRIGGER trg_group_members_append_only
  BEFORE UPDATE ON group_members
  FOR EACH ROW EXECUTE FUNCTION enforce_group_membership_is_append_only();

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_audit_groups
  AFTER INSERT OR UPDATE OR DELETE ON groups
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_group_members
  AFTER INSERT OR UPDATE OR DELETE ON group_members
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
