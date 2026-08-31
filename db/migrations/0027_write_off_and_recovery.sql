-- Writing a loan off, and recovering against one that has been written off.
--
-- Both were blocked on a business decision until now, and the register records
-- what changed: WRITEOFF-01 and RECOVERY-01 are decided. The rules are the
-- institution's, stated in full, and nothing here infers any of them.
--
-- What the schema has to make true, from the approved rules:
--
--   * A write-off zeroes the borrower's live balance but must NOT erase what was
--     written off. `loans.outstanding_balance` becomes 0; the amount lives here.
--   * There is no automatic write-off. No threshold, no scheduled job — a person
--     with the authority decides, and records why.
--   * A recovery is not a repayment. It does not reinstate the loan, does not
--     recreate principal, and does not reopen the schedule. So it cannot be a
--     row in `payments`, which is the table that moves a balance.
--   * Both are append-only records of a decision, so both are auditable and
--     neither is editable.
--
-- Two tables rather than columns on `loans`, because both are events with their
-- own actor, time and reason — and recoveries are many per loan.

-- ---------------------------------------------------------------------------
-- loan_write_offs
-- ---------------------------------------------------------------------------

-- One row per loan, ever. A loan is written off once.
--
-- The amount is captured at the moment of the decision because the live balance
-- is about to become zero. Without it, "how much did we write off last quarter"
-- has no answer, and MSP2-02's bad-debts line has no source.
CREATE TABLE loan_write_offs (
  id                 uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id     uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  loan_id            uuid           NOT NULL,

  -- What the borrower owed at the instant of write-off, split as the balance
  -- was actually composed. Principal and penalty are held separately because
  -- BOT's MSP2-02 distinguishes bad debts written off from provisions, and
  -- because an eventual accounting mapping will need the split rather than a
  -- single total it cannot decompose.
  principal_written_off numeric(15, 2) NOT NULL CHECK (principal_written_off >= 0),
  penalty_written_off   numeric(15, 2) NOT NULL CHECK (penalty_written_off >= 0),
  total_written_off     numeric(15, 2) NOT NULL CHECK (total_written_off > 0),

  -- Why. Required: a write-off with no reason is an unexplained disposal of an
  -- asset, which is precisely what an inspection asks about.
  reason             text           NOT NULL CHECK (length(btrim(reason)) > 0),

  approved_by        uuid           NOT NULL,
  written_off_at     timestamptz    NOT NULL DEFAULT now(),
  created_at         timestamptz    NOT NULL DEFAULT now(),

  -- One write-off per loan. The application refuses a second; this makes a
  -- second impossible by any route.
  CONSTRAINT loan_write_offs_one_per_loan UNIQUE (loan_id),
  CONSTRAINT loan_write_offs_id_institution_key UNIQUE (id, institution_id),

  CONSTRAINT loan_write_offs_loan_within_institution
    FOREIGN KEY (loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_write_offs_approver_within_institution
    FOREIGN KEY (approved_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT,

  -- The parts are the whole. A total that does not decompose is a figure nobody
  -- can reconcile against the loan it came from.
  CONSTRAINT loan_write_offs_total_is_the_parts
    CHECK (total_written_off = principal_written_off + penalty_written_off)
);

COMMENT ON TABLE loan_write_offs IS
  'One per loan. Records what was written off, by whom and why, because the live balance becomes zero.';
COMMENT ON COLUMN loan_write_offs.total_written_off IS
  'What the borrower owed when the decision was taken. Never recomputed from the loan afterwards.';

CREATE INDEX loan_write_offs_institution_idx ON loan_write_offs (institution_id, written_off_at DESC);

ALTER TABLE loan_write_offs ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_write_offs FORCE ROW LEVEL SECURITY;

CREATE POLICY loan_write_offs_select ON loan_write_offs
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY loan_write_offs_insert ON loan_write_offs
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

-- No UPDATE and no DELETE policy, and no grant for either. A write-off that can
-- be amended or removed is not a record of a decision; it is a draft.
GRANT SELECT, INSERT ON loan_write_offs TO mfi_app;

-- ---------------------------------------------------------------------------
-- loan_recoveries
-- ---------------------------------------------------------------------------

-- Money received after a loan was written off.
--
-- Deliberately not a `payments` row. A payment moves `loans.outstanding_balance`
-- and consumes the repayment schedule; a recovery does neither. The borrower's
-- live balance stays at zero, the loan stays `written_off`, and the schedule
-- stays closed — which is the approved rule, and which the separation makes
-- structural rather than a thing the application has to remember.
--
-- That separation is also what stops the same shilling being counted twice: as
-- repayment income and again as recovery income. The two live in different
-- tables and reach MSP2-02 by different lines.
CREATE TABLE loan_recoveries (
  id                 uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id     uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  loan_id            uuid           NOT NULL,
  branch_id          uuid           NOT NULL,

  amount             numeric(15, 2) NOT NULL CHECK (amount > 0),
  recovered_on       date           NOT NULL,

  -- How the money arrived. Free text within a bounded vocabulary would be
  -- inventing a payment-method taxonomy nobody has specified, so this is the
  -- same shape `payments.notes` uses: recorded, not classified.
  method             text           CHECK (method IS NULL OR length(btrim(method)) > 0),
  reference          text           CHECK (reference IS NULL OR length(btrim(reference)) > 0),
  notes              text,

  recorded_by        uuid           NOT NULL,
  created_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT loan_recoveries_id_institution_key UNIQUE (id, institution_id),

  CONSTRAINT loan_recoveries_loan_within_institution
    FOREIGN KEY (loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_recoveries_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_recoveries_recorder_within_institution
    FOREIGN KEY (recorded_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT
);

COMMENT ON TABLE loan_recoveries IS
  'Money received against a written-off loan. Not a repayment: the balance stays zero and the loan stays written off.';

CREATE INDEX loan_recoveries_loan_idx ON loan_recoveries (loan_id);
CREATE INDEX loan_recoveries_institution_date_idx
  ON loan_recoveries (institution_id, recovered_on);

ALTER TABLE loan_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_recoveries FORCE ROW LEVEL SECURITY;

CREATE POLICY loan_recoveries_select ON loan_recoveries
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY loan_recoveries_insert ON loan_recoveries
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

-- Append-only, like payments. A recovery is corrected by recording the truth
-- alongside it, never by editing what was recorded.
GRANT SELECT, INSERT ON loan_recoveries TO mfi_app;

-- ---------------------------------------------------------------------------
-- A recovery only exists against a loan that was written off
-- ---------------------------------------------------------------------------

-- Enforced here rather than only in the application, because "money received
-- against a live loan" and "money received against a written-off loan" are
-- different events with different reporting lines, and a row in the wrong one
-- misstates both.
CREATE OR REPLACE FUNCTION enforce_recovery_is_against_written_off_loan()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status INTO v_status FROM loans WHERE id = NEW.loan_id;

  IF v_status IS DISTINCT FROM 'written_off' THEN
    RAISE EXCEPTION
      'A recovery can only be recorded against a written-off loan; this one is %', v_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_recovery_is_against_written_off_loan() IS
  'A recovery belongs to a written-off loan. Money against a live loan is a payment, and reaches a different MSP2-02 line.';

CREATE TRIGGER trg_loan_recoveries_require_written_off
  BEFORE INSERT ON loan_recoveries
  FOR EACH ROW EXECUTE FUNCTION enforce_recovery_is_against_written_off_loan();

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

-- Both are business tables, so both are audited. `schema-invariants.test.ts`
-- fails the build for a business table without a trigger, which is what keeps
-- this from being forgotten.
CREATE TRIGGER trg_audit_loan_write_offs
  AFTER INSERT OR UPDATE OR DELETE ON loan_write_offs
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_loan_recoveries
  AFTER INSERT OR UPDATE OR DELETE ON loan_recoveries
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
