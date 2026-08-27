-- Restructuring: a new loan that carries what the old one still owed.
--
-- RESTRUCT-01 through RESTRUCT-03 and RESTRUCT-05 are decided. The approved
-- rules, in full:
--
--   * Any borrower may request it, but only while the loan is still within its
--     **originally agreed term**. Past the original maturity month, this route
--     is unavailable.
--   * Only the Owner/Manager approves.
--   * New principal = remaining principal + unpaid accrued interest + unpaid
--     penalties. Nothing is forgiven.
--   * A **new loan** is created; the old one is never deleted, keeps its
--     schedule, and stops accepting ordinary repayments.
--   * The new loan starts classified Current.
--
-- Two things this migration deliberately does not decide are recorded as
-- RESTRUCT-04 (the ledger mapping for capitalising interest and penalties) and
-- RESTRUCT-06 (whether MSP2-09 counts a restructured facility as a
-- disbursement, given no cash moves).

-- ---------------------------------------------------------------------------
-- A loan can be restructured
-- ---------------------------------------------------------------------------

-- `restructured` is its own terminal state rather than a reuse of `completed`.
--
-- `completed` means repaid, and a restructured loan was not repaid — its debt
-- moved. Conflating them would report a loan as settled that no borrower ever
-- settled, and would put it on the wrong side of every query that asks what an
-- institution recovered.
ALTER TABLE loans DROP CONSTRAINT loans_status_check;

ALTER TABLE loans ADD CONSTRAINT loans_status_check
  CHECK (status IN ('draft', 'pending_approval', 'approved', 'rejected',
                    'active', 'completed', 'written_off', 'restructured'));

-- A restructured loan was disbursed, so it holds the same completeness the
-- other post-disbursement states do.
ALTER TABLE loans DROP CONSTRAINT loans_disbursement_is_complete;

ALTER TABLE loans ADD CONSTRAINT loans_disbursement_is_complete
  CHECK (status NOT IN ('active', 'completed', 'written_off', 'restructured')
         OR (disbursement_date IS NOT NULL AND disbursed_by IS NOT NULL
             AND outstanding_balance IS NOT NULL));

-- Active is the only state a loan can be restructured out of. A draft has
-- nothing to carry; a completed loan owes nothing; a written-off one has
-- already been disposed of.
CREATE OR REPLACE FUNCTION enforce_loan_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_permitted text[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  v_permitted := CASE OLD.status
    WHEN 'draft'            THEN ARRAY['pending_approval']
    WHEN 'pending_approval' THEN ARRAY['approved', 'rejected']
    WHEN 'approved'         THEN ARRAY['active']
    -- Back to the officer to revise and resubmit.
    WHEN 'rejected'         THEN ARRAY['draft']
    WHEN 'active'           THEN ARRAY['completed', 'written_off', 'restructured']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (v_permitted)) THEN
    RAISE EXCEPTION 'A loan cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_loan_transition() IS
  'The loan status machine. Rejection returns an application to draft; an active loan may be repaid, written off, or restructured into a successor.';

-- ---------------------------------------------------------------------------
-- loan_restructurings
-- ---------------------------------------------------------------------------

-- One row per restructuring, linking the old loan to the new one and recording
-- what was carried across.
--
-- The three components are stored separately rather than as one principal
-- figure. RESTRUCT-04 — the ledger mapping for capitalising interest and
-- penalties — is unresolved, and an accounting treatment cannot decompose a
-- number it was handed already summed. Keeping principal, interest and penalty
-- apart is what lets the eventual mapping post correctly against a restructuring
-- that has already happened.
CREATE TABLE loan_restructurings (
  id                     uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id         uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  old_loan_id            uuid           NOT NULL,
  new_loan_id            uuid           NOT NULL,

  -- What the old loan still owed, decomposed as it stood at approval.
  principal_carried      numeric(15, 2) NOT NULL CHECK (principal_carried >= 0),
  interest_capitalised   numeric(15, 2) NOT NULL CHECK (interest_capitalised >= 0),
  penalties_capitalised  numeric(15, 2) NOT NULL CHECK (penalties_capitalised >= 0),
  new_principal          numeric(15, 2) NOT NULL CHECK (new_principal > 0),

  reason                 text           NOT NULL CHECK (length(btrim(reason)) > 0),

  requested_by           uuid           NOT NULL,
  approved_by            uuid           NOT NULL,
  approved_at            timestamptz    NOT NULL DEFAULT now(),
  created_at             timestamptz    NOT NULL DEFAULT now(),

  -- A loan is restructured once, and a loan is the product of at most one
  -- restructuring. Both directions, so neither a chain nor a fork can be built
  -- by accident.
  CONSTRAINT loan_restructurings_one_per_old_loan UNIQUE (old_loan_id),
  CONSTRAINT loan_restructurings_one_per_new_loan UNIQUE (new_loan_id),
  CONSTRAINT loan_restructurings_id_institution_key UNIQUE (id, institution_id),

  CONSTRAINT loan_restructurings_old_within_institution
    FOREIGN KEY (old_loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_restructurings_new_within_institution
    FOREIGN KEY (new_loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_restructurings_approver_within_institution
    FOREIGN KEY (approved_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_restructurings_requester_within_institution
    FOREIGN KEY (requested_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT,

  -- A loan cannot be restructured into itself.
  CONSTRAINT loan_restructurings_is_not_circular
    CHECK (old_loan_id <> new_loan_id),

  -- The parts are the whole. A new principal that does not decompose is a
  -- figure nobody can reconcile against the loan it came from.
  CONSTRAINT loan_restructurings_total_is_the_parts
    CHECK (new_principal = principal_carried + interest_capitalised + penalties_capitalised)
);

COMMENT ON TABLE loan_restructurings IS
  'Links a restructured loan to its successor and records what was carried across, decomposed for an accounting treatment that is not yet defined.';

CREATE INDEX loan_restructurings_institution_idx
  ON loan_restructurings (institution_id, approved_at DESC);

ALTER TABLE loan_restructurings ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_restructurings FORCE ROW LEVEL SECURITY;

CREATE POLICY loan_restructurings_select ON loan_restructurings
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY loan_restructurings_insert ON loan_restructurings
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

-- No UPDATE and no DELETE. A restructuring that can be amended or removed
-- breaks the link between two loans that are only interpretable together.
GRANT SELECT, INSERT ON loan_restructurings TO mfi_app;

CREATE TRIGGER trg_audit_loan_restructurings
  AFTER INSERT OR UPDATE OR DELETE ON loan_restructurings
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
