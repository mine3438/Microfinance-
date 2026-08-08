-- Payments and reversals.
--
-- The previous schema made payments immutable — no UPDATE or DELETE policy for
-- any role, deliberately — but never built the correcting mechanism. The
-- analysis records the consequence as R9: fixing a mis-keyed payment required
-- direct database intervention, which destroys the audit property the
-- immutability was protecting.
--
-- Immutability is kept. A correction is a new row that negates the original,
-- so both the mistake and its correction remain visible, which is what an
-- examiner needs to see.

CREATE TABLE payments (
  id                  uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id      uuid           NOT NULL,
  loan_id             uuid           NOT NULL,

  -- Positive for a payment received, negative for a reversal. The sign is
  -- constrained against reverses_payment_id below, so a row cannot be
  -- ambiguous about which it is.
  amount_paid         numeric(15, 2) NOT NULL CHECK (amount_paid <> 0),

  -- How the amount was applied. Computed by @mfi/domain allocatePayment; the
  -- client never submits a split, only an amount.
  penalty_portion     numeric(15, 2) NOT NULL DEFAULT 0,
  fee_portion         numeric(15, 2) NOT NULL DEFAULT 0,
  interest_portion    numeric(15, 2) NOT NULL DEFAULT 0,
  principal_portion   numeric(15, 2) NOT NULL DEFAULT 0,

  -- What the payment exceeded everything owed by. Recorded rather than
  -- absorbed: what an institution does with excess funds is an open rule
  -- (§13.8), and silently keeping them would answer it on their behalf.
  unallocated_amount  numeric(15, 2) NOT NULL DEFAULT 0,

  -- Snapshots, so a historic balance is readable without replaying every
  -- payment against the loan. The previous schema took the same position and
  -- it is the right one.
  balance_before      numeric(15, 2) NOT NULL CHECK (balance_before >= 0),
  balance_after       numeric(15, 2) NOT NULL CHECK (balance_after >= 0),

  date_paid           date           NOT NULL,
  notes               text,

  recorded_by         uuid           NOT NULL,
  created_at          timestamptz    NOT NULL DEFAULT now(),

  -- Set only on a reversal, naming the payment being undone.
  reverses_payment_id uuid REFERENCES payments (id) ON DELETE RESTRICT,
  reversal_reason     text,

  CONSTRAINT payments_loan_within_institution
    FOREIGN KEY (loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,

  -- Every shilling is accounted for. A split that does not sum to the amount
  -- leaves a balance nobody can reconcile.
  CONSTRAINT payments_allocation_is_complete
    CHECK (amount_paid = penalty_portion + fee_portion + interest_portion
                       + principal_portion + unallocated_amount),

  -- Only the principal component moves the balance. Interest, penalties and
  -- fees are charges the payment settles; paying them does not reduce what was
  -- borrowed.
  CONSTRAINT payments_balance_moves_by_principal
    CHECK (balance_after = balance_before - principal_portion),

  -- A payment is positive and stands alone; a reversal is negative and names
  -- what it undoes, with a reason. Nothing in between.
  CONSTRAINT payments_sign_matches_kind
    CHECK (
      (reverses_payment_id IS NULL AND amount_paid > 0 AND reversal_reason IS NULL)
      OR
      (reverses_payment_id IS NOT NULL AND amount_paid < 0
       AND length(btrim(coalesce(reversal_reason, ''))) > 0)
    ),

  -- Components carry the same sign as the amount, so a reversal cannot undo
  -- more of one component than the original applied.
  CONSTRAINT payments_components_match_sign
    CHECK (
      (amount_paid > 0 AND penalty_portion >= 0 AND fee_portion >= 0
       AND interest_portion >= 0 AND principal_portion >= 0 AND unallocated_amount >= 0)
      OR
      (amount_paid < 0 AND penalty_portion <= 0 AND fee_portion <= 0
       AND interest_portion <= 0 AND principal_portion <= 0 AND unallocated_amount <= 0)
    )
);

COMMENT ON TABLE payments IS
  'Append-only. A correction is a linked negating row, never an edit — both the mistake and its correction stay visible.';
COMMENT ON COLUMN payments.unallocated_amount IS
  'Paid beyond everything owed. Recorded rather than absorbed; what happens to it is an open business rule.';

-- A payment may be reversed once. Reversing a reversal, or reversing the same
-- payment twice, would make the loan balance depend on the order rows are read.
CREATE UNIQUE INDEX payments_one_reversal_per_payment
  ON payments (reverses_payment_id)
  WHERE reverses_payment_id IS NOT NULL;

CREATE INDEX payments_institution_date_idx ON payments (institution_id, date_paid DESC);
CREATE INDEX payments_loan_idx ON payments (loan_id, date_paid);

CREATE TRIGGER trg_audit_payments
  AFTER INSERT OR UPDATE OR DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE payments FORCE ROW LEVEL SECURITY;

CREATE POLICY payments_select ON payments
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY payments_insert ON payments
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());

-- No UPDATE or DELETE policy, and neither privilege is granted. A recorded
-- payment is evidence; evidence that can be edited is not evidence. Correcting
-- one means recording a reversal.
GRANT SELECT, INSERT ON payments TO mfi_app;

-- Refuses a reversal that does not exactly undo its original.
--
-- A partial or mismatched reversal would leave the loan's balance depending on
-- which rows a reader happened to sum.
CREATE OR REPLACE FUNCTION enforce_payment_reversal() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_original payments%ROWTYPE;
BEGIN
  IF NEW.reverses_payment_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_original FROM payments WHERE id = NEW.reverses_payment_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cannot reverse payment %: it does not exist', NEW.reverses_payment_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_original.reverses_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Payment % is itself a reversal and cannot be reversed',
      NEW.reverses_payment_id USING ERRCODE = 'check_violation';
  END IF;

  IF v_original.loan_id <> NEW.loan_id THEN
    RAISE EXCEPTION 'A reversal must be recorded against the same loan as the payment it undoes'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.amount_paid <> -v_original.amount_paid
     OR NEW.penalty_portion <> -v_original.penalty_portion
     OR NEW.fee_portion <> -v_original.fee_portion
     OR NEW.interest_portion <> -v_original.interest_portion
     OR NEW.principal_portion <> -v_original.principal_portion
     OR NEW.unallocated_amount <> -v_original.unallocated_amount THEN
    RAISE EXCEPTION 'A reversal must negate its original exactly, component by component'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_payments_enforce_reversal
  BEFORE INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION enforce_payment_reversal();

-- Emits the ledger-ready event. Money moving in is exactly what a double-entry
-- posting exists to record.
CREATE OR REPLACE FUNCTION emit_payment_domain_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO domain_events (
    institution_id, event_type, aggregate_type, aggregate_id, actor_user_id, payload
  ) VALUES (
    NEW.institution_id,
    CASE WHEN NEW.reverses_payment_id IS NULL THEN 'payment.received' ELSE 'payment.reversed' END,
    'payment', NEW.id, current_user_id(),
    jsonb_build_object(
      'loan_id',            NEW.loan_id,
      'amount_paid',        NEW.amount_paid::text,
      'penalty_portion',    NEW.penalty_portion::text,
      'fee_portion',        NEW.fee_portion::text,
      'interest_portion',   NEW.interest_portion::text,
      'principal_portion',  NEW.principal_portion::text,
      'unallocated_amount', NEW.unallocated_amount::text,
      'balance_before',     NEW.balance_before::text,
      'balance_after',      NEW.balance_after::text,
      'date_paid',          NEW.date_paid,
      'reverses',           NEW.reverses_payment_id
    )
  );
  RETURN NULL;
END;
$$;

ALTER FUNCTION emit_payment_domain_event() OWNER TO mfi_audit_writer;

CREATE TRIGGER trg_payments_emit_domain_event
  AFTER INSERT ON payments
  FOR EACH ROW EXECUTE FUNCTION emit_payment_domain_event();
