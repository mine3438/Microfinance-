-- The TZS 5,000 application/form fee.
--
-- FEE-01, FEE-02 and FEE-03 are decided. The register records the rules in
-- full; what matters here is what the schema has to make true:
--
--   * The fee is paid **separately, in cash, at application**. It is not
--     deducted from disbursement, not added to principal, not interest-bearing,
--     and not part of the repayment schedule.
--   * It is therefore **not a balance the repayment allocator can reach**. That
--     is why it is its own table rather than a column on `loans` or a bucket in
--     the payment path: the allocator's fee bucket keeps its fixed position and
--     continues to allocate nil, and no repayment — past or future — splits
--     differently because this exists.
--   * A refund does **not** delete the collection. The row keeps who took the
--     money, when, and how, and gains the refund stamp alongside.
--
-- One row per application. The fee is charged once per set of forms.

CREATE TABLE loan_application_fees (
  id              uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id  uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  loan_id         uuid           NOT NULL,
  branch_id       uuid           NOT NULL,

  -- What was actually charged, stored rather than derived from today's policy.
  -- The approved figure is TZS 5,000; storing it means a later change of policy
  -- does not restate what a borrower was charged last year.
  amount          numeric(15, 2) NOT NULL CHECK (amount > 0),

  collected_on    date           NOT NULL,
  -- Cash, by the approved rule. Recorded rather than constrained to a
  -- vocabulary, because no supplied document enumerates payment methods and
  -- inventing the list would be inventing a taxonomy.
  method          text           CHECK (method IS NULL OR length(btrim(method)) > 0),
  reference       text           CHECK (reference IS NULL OR length(btrim(reference)) > 0),
  collected_by    uuid           NOT NULL,
  created_at      timestamptz    NOT NULL DEFAULT now(),

  -- The refund, stamped on the same row.
  --
  -- Deliberately not a deletion and not a replacement row: the requirement is
  -- that collection stays evidenced, and the audit trigger captures the before
  -- and after of this stamp. `payments` is append-only because payment rows
  -- compose a borrower's balance and a reversal has to be visible as its own
  -- event; an application fee composes no balance, so the simpler shape is the
  -- honest one.
  refunded_on     date,
  refunded_by     uuid,
  refund_reason   text           CHECK (refund_reason IS NULL OR length(btrim(refund_reason)) > 0),
  refunded_at     timestamptz,

  CONSTRAINT loan_application_fees_one_per_loan UNIQUE (loan_id),
  CONSTRAINT loan_application_fees_id_institution_key UNIQUE (id, institution_id),

  CONSTRAINT loan_application_fees_loan_within_institution
    FOREIGN KEY (loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_application_fees_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_application_fees_collector_within_institution
    FOREIGN KEY (collected_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loan_application_fees_refunder_within_institution
    FOREIGN KEY (refunded_by, institution_id) REFERENCES users (id, institution_id) ON DELETE RESTRICT,

  -- A refund is all four columns or none. Half a refund is a record nobody can
  -- act on: an amount handed back with no date, or a date with nobody attached.
  CONSTRAINT loan_application_fees_refund_is_complete
    CHECK (num_nonnulls(refunded_on, refunded_by, refunded_at) IN (0, 3)),

  -- Money cannot be handed back before it was taken.
  CONSTRAINT loan_application_fees_refund_follows_collection
    CHECK (refunded_on IS NULL OR refunded_on >= collected_on)
);

COMMENT ON TABLE loan_application_fees IS
  'The application/form fee, collected in cash at application. Separate from the loan: never principal, never interest-bearing, never in the repayment allocator.';
COMMENT ON COLUMN loan_application_fees.amount IS
  'What was charged, not what current policy charges. A policy change must not restate history.';
COMMENT ON COLUMN loan_application_fees.refunded_on IS
  'Set when the fee is handed back. The collection columns are never cleared.';

CREATE INDEX loan_application_fees_institution_collected_idx
  ON loan_application_fees (institution_id, collected_on);

ALTER TABLE loan_application_fees ENABLE ROW LEVEL SECURITY;
ALTER TABLE loan_application_fees FORCE ROW LEVEL SECURITY;

CREATE POLICY loan_application_fees_select ON loan_application_fees
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY loan_application_fees_insert ON loan_application_fees
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY loan_application_fees_update ON loan_application_fees
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE policy and no DELETE grant. A collected fee is evidence, and a
-- refund is recorded alongside it rather than by removing it.
GRANT SELECT, INSERT, UPDATE ON loan_application_fees TO mfi_app;

-- ---------------------------------------------------------------------------
-- The collection columns are written once
-- ---------------------------------------------------------------------------

-- UPDATE is granted so a refund can be stamped. It must not become a way to
-- rewrite what was collected — which is the whole point of keeping the record.
CREATE OR REPLACE FUNCTION enforce_application_fee_collection_is_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.loan_id      IS DISTINCT FROM OLD.loan_id
     OR NEW.amount       IS DISTINCT FROM OLD.amount
     OR NEW.collected_on IS DISTINCT FROM OLD.collected_on
     OR NEW.collected_by IS DISTINCT FROM OLD.collected_by
     OR NEW.method       IS DISTINCT FROM OLD.method
     OR NEW.reference    IS DISTINCT FROM OLD.reference THEN
    RAISE EXCEPTION
      'What was collected cannot be amended. Record the truth alongside it instead.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- And a refund is stamped once.
  IF OLD.refunded_at IS NOT NULL AND NEW.refunded_at IS DISTINCT FROM OLD.refunded_at THEN
    RAISE EXCEPTION 'That fee has already been refunded.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_application_fee_collection_is_immutable() IS
  'UPDATE exists to stamp a refund. It is not a way to restate what was collected.';

CREATE TRIGGER trg_loan_application_fees_collection_is_immutable
  BEFORE UPDATE ON loan_application_fees
  FOR EACH ROW EXECUTE FUNCTION enforce_application_fee_collection_is_immutable();

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE TRIGGER trg_audit_loan_application_fees
  AFTER INSERT OR UPDATE OR DELETE ON loan_application_fees
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
