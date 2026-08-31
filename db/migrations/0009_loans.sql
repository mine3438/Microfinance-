-- Loan applications, approval, disbursement, and the repayment schedule.
--
-- The previous system had no approval step at all: a loan appeared as `active`
-- the moment an officer created it. PRD §4.2 records maker-checker as cut. For
-- a supervised lender that is the control auditors ask about first, so it is
-- here — and enforced where it cannot be bypassed, not in an interface.

-- ---------------------------------------------------------------------------
-- approval_thresholds
-- ---------------------------------------------------------------------------

-- The most a role may sanction, per institution.
--
-- Seeded empty, deliberately. The figures belong to the institution and are not
-- stated anywhere in the supplied documentation (01-ARCHITECTURE.md §13.3), so
-- inventing a default would be inventing a lending policy.
--
-- The absence of a row means no authority, not unlimited authority. The
-- opposite reading would grant every role the power to approve any amount the
-- moment someone forgot to configure a limit.
CREATE TABLE approval_thresholds (
  institution_id uuid           NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  role_code      text           NOT NULL REFERENCES reference.roles (code),
  max_principal  numeric(15, 2) NOT NULL CHECK (max_principal > 0),

  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  PRIMARY KEY (institution_id, role_code)
);

COMMENT ON TABLE approval_thresholds IS
  'Per-role approval limits. No row means no authority — absence must not read as unlimited.';

CREATE INDEX approval_thresholds_institution_idx ON approval_thresholds (institution_id);

CREATE TRIGGER trg_approval_thresholds_updated_at
  BEFORE UPDATE ON approval_thresholds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_approval_thresholds
  AFTER INSERT OR UPDATE OR DELETE ON approval_thresholds
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE approval_thresholds ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_thresholds FORCE ROW LEVEL SECURITY;

CREATE POLICY approval_thresholds_select ON approval_thresholds
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY approval_thresholds_insert ON approval_thresholds
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY approval_thresholds_update ON approval_thresholds
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());
CREATE POLICY approval_thresholds_delete ON approval_thresholds
  FOR DELETE TO mfi_app USING (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON approval_thresholds TO mfi_app;

-- ---------------------------------------------------------------------------
-- loans
-- ---------------------------------------------------------------------------

CREATE TABLE loans (
  id                  uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id      uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  branch_id           uuid           NOT NULL,
  client_id           uuid           NOT NULL,
  product_id          uuid           NOT NULL,

  loan_code           text,

  -- Terms, copied from the product at submission rather than referenced.
  -- A product's rate may be revised; a loan's may not. Reading the rate through
  -- the product would silently restate every historic schedule and every
  -- MSP2-04 return the next time someone changed a price.
  principal           numeric(15, 2) NOT NULL CHECK (principal > 0),
  monthly_rate        numeric(6, 4)  NOT NULL CHECK (monthly_rate >= 0),
  interest_method     text           NOT NULL CHECK (interest_method IN ('flat', 'reducing_balance')),
  term_months         integer        NOT NULL CHECK (term_months BETWEEN 1 AND 360),

  status              text           NOT NULL DEFAULT 'draft'
                                     CHECK (status IN ('draft', 'pending_approval', 'approved',
                                                       'rejected', 'active', 'completed',
                                                       'written_off')),

  submitted_by        uuid,
  submitted_at        timestamptz,
  decided_by          uuid,
  decided_at          timestamptz,
  rejection_reason    text,

  disbursed_by        uuid,
  disbursement_date   date,

  -- Mutated only by recording a payment. Nothing else may write it.
  outstanding_balance numeric(15, 2) CHECK (outstanding_balance IS NULL OR outstanding_balance >= 0),

  created_at          timestamptz    NOT NULL DEFAULT now(),
  updated_at          timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT loans_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT loans_code_unique_per_institution UNIQUE (institution_id, loan_code),

  CONSTRAINT loans_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loans_client_within_institution
    FOREIGN KEY (client_id, institution_id) REFERENCES clients (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT loans_product_within_institution
    FOREIGN KEY (product_id, institution_id) REFERENCES loan_products (id, institution_id) ON DELETE RESTRICT,

  -- Maker-checker, at the level that cannot be bypassed. The application layer
  -- checks this too, with a message explaining the refusal; this is the backstop
  -- for anything that reaches the table by another route.
  CONSTRAINT loans_approver_is_not_submitter
    CHECK (decided_by IS NULL OR submitted_by IS NULL OR decided_by <> submitted_by),

  -- A decided application records who decided it and when.
  CONSTRAINT loans_decision_is_attributed
    CHECK (status NOT IN ('approved', 'rejected') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),

  -- A rejection says why. "Declined" with no reason is not a record anyone can act on.
  CONSTRAINT loans_rejection_has_reason
    CHECK (status <> 'rejected' OR length(btrim(coalesce(rejection_reason, ''))) > 0),

  -- Money moved: there is a disbursement date, someone who released it, and a balance.
  CONSTRAINT loans_disbursement_is_complete
    CHECK (status NOT IN ('active', 'completed', 'written_off')
           OR (disbursement_date IS NOT NULL AND disbursed_by IS NOT NULL
               AND outstanding_balance IS NOT NULL)),

  -- Nothing is owed on a loan that is repaid.
  CONSTRAINT loans_completed_is_settled
    CHECK (status <> 'completed' OR outstanding_balance = 0)
);

COMMENT ON TABLE loans IS
  'Loan applications through their lifecycle. Terms are copied from the product at submission, not referenced.';
COMMENT ON COLUMN loans.outstanding_balance IS
  'NULL until disbursement. Thereafter mutated only by recording a payment.';

CREATE INDEX loans_institution_status_idx ON loans (institution_id, status);
CREATE INDEX loans_client_idx ON loans (client_id);
CREATE INDEX loans_branch_status_idx ON loans (branch_id, status);
CREATE INDEX loans_product_idx ON loans (product_id);
-- MSP2-09 reports loans disbursed within the quarter.
CREATE INDEX loans_disbursement_date_idx ON loans (institution_id, disbursement_date)
  WHERE disbursement_date IS NOT NULL;

CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON loans FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_audit_loans
  AFTER INSERT OR UPDATE OR DELETE ON loans FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE loans FORCE ROW LEVEL SECURITY;

CREATE POLICY loans_select ON loans
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY loans_insert ON loans
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY loans_update ON loans
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON loans TO mfi_app;

-- Allocates the loan code at submission, not at creation: a draft that is never
-- submitted should not consume a number that appears on no agreement.
CREATE OR REPLACE FUNCTION set_loan_code() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status <> 'draft' AND (NEW.loan_code IS NULL OR btrim(NEW.loan_code) = '') THEN
    NEW.loan_code := allocate_entity_code(
      NEW.institution_id, 'loan', 'LN', extract(year FROM now())::integer
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_loans_set_code
  BEFORE INSERT OR UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_loan_code();

-- ---------------------------------------------------------------------------
-- Transition enforcement
-- ---------------------------------------------------------------------------

-- Mirrors LOAN_TRANSITIONS in @mfi/domain. Both exist for different reasons:
-- the domain table produces a message a user can act on, this one guarantees no
-- write path can put a loan into a state it could not legally reach.
CREATE OR REPLACE FUNCTION enforce_loan_transition() RETURNS trigger
LANGUAGE plpgsql
AS $$
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
    WHEN 'active'           THEN ARRAY['completed', 'written_off']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.status = ANY (v_permitted)) THEN
    RAISE EXCEPTION 'A loan cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_loans_enforce_transition
  BEFORE UPDATE OF status ON loans
  FOR EACH ROW EXECUTE FUNCTION enforce_loan_transition();

-- ---------------------------------------------------------------------------
-- repayment_schedules
-- ---------------------------------------------------------------------------

CREATE TABLE repayment_schedules (
  id             uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid           NOT NULL,
  loan_id        uuid           NOT NULL,

  month_number   integer        NOT NULL CHECK (month_number > 0),
  due_date       date           NOT NULL,

  principal_due  numeric(15, 2) NOT NULL CHECK (principal_due >= 0),
  interest_due   numeric(15, 2) NOT NULL CHECK (interest_due >= 0),
  total_due      numeric(15, 2) NOT NULL CHECK (total_due >= 0),

  is_paid        boolean        NOT NULL DEFAULT false,
  paid_date      date,
  paid_amount    numeric(15, 2) CHECK (paid_amount IS NULL OR paid_amount >= 0),

  created_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT repayment_schedules_month_unique UNIQUE (loan_id, month_number),
  CONSTRAINT repayment_schedules_loan_within_institution
    FOREIGN KEY (loan_id, institution_id) REFERENCES loans (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT repayment_schedules_total_is_sum
    CHECK (total_due = principal_due + interest_due)
);

COMMENT ON TABLE repayment_schedules IS
  'Generated at disbursement by @mfi/domain generateSchedule. Sums to exactly the principal advanced.';

CREATE INDEX repayment_schedules_institution_idx ON repayment_schedules (institution_id);
CREATE INDEX repayment_schedules_loan_idx ON repayment_schedules (loan_id, month_number);
CREATE INDEX repayment_schedules_due_idx ON repayment_schedules (institution_id, due_date)
  WHERE NOT is_paid;

CREATE TRIGGER trg_audit_repayment_schedules
  AFTER INSERT OR UPDATE OR DELETE ON repayment_schedules
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE repayment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE repayment_schedules FORCE ROW LEVEL SECURITY;

CREATE POLICY repayment_schedules_select ON repayment_schedules
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY repayment_schedules_insert ON repayment_schedules
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY repayment_schedules_update ON repayment_schedules
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON repayment_schedules TO mfi_app;

-- ---------------------------------------------------------------------------
-- domain_events
-- ---------------------------------------------------------------------------

-- The ledger seam, landing now that there is a financial event to carry.
--
-- 01-ARCHITECTURE.md §1.1 describes it: every event that moves money records
-- what a double-entry posting would need, so adding a ledger later is one
-- subscriber rather than reopening every use case. It was deliberately not
-- created in stage 5, because a table nothing writes to is the fault that stage
-- existed to correct. Disbursement is the first event that moves money, so the
-- seam arrives with it.
CREATE TABLE domain_events (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL,

  event_type     text        NOT NULL CHECK (length(btrim(event_type)) > 0),
  aggregate_type text        NOT NULL,
  aggregate_id   uuid        NOT NULL,

  occurred_at    timestamptz NOT NULL DEFAULT now(),
  actor_user_id  uuid,

  -- Amounts and direction. Kept as JSONB because a ledger subscriber, not this
  -- table, decides which accounts an event posts to.
  payload        jsonb       NOT NULL,

  -- Set when a ledger has consumed the event. NULL until one exists, which is
  -- the point: the backlog is queryable from the day the ledger is built.
  posted_at      timestamptz
);

COMMENT ON TABLE domain_events IS
  'Financial events in ledger-ready form. Consumed by a double-entry subscriber when one is built.';

CREATE INDEX domain_events_institution_occurred_idx
  ON domain_events (institution_id, occurred_at DESC);
CREATE INDEX domain_events_aggregate_idx ON domain_events (aggregate_type, aggregate_id);
CREATE INDEX domain_events_unposted_idx ON domain_events (institution_id) WHERE posted_at IS NULL;

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE domain_events FORCE ROW LEVEL SECURITY;

CREATE POLICY domain_events_select ON domain_events
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY domain_events_insert ON domain_events
  FOR INSERT TO mfi_audit_writer WITH CHECK (true);

-- Read-only to the application, like the audit log: events are a record of what
-- happened, not something to be edited afterwards.
GRANT SELECT ON domain_events TO mfi_app;
GRANT INSERT ON domain_events TO mfi_audit_writer;

-- Emits the event when a loan's status change moves money.
CREATE OR REPLACE FUNCTION emit_loan_domain_event() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_event_type text;
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;

  v_event_type := CASE
    WHEN NEW.status = 'active'      THEN 'loan.disbursed'
    WHEN NEW.status = 'completed'   THEN 'loan.completed'
    WHEN NEW.status = 'written_off' THEN 'loan.written_off'
    ELSE NULL
  END;

  -- Approval and rejection move no money. They are recorded in the audit log,
  -- which is where a decision belongs; a ledger has nothing to post for them.
  IF v_event_type IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO domain_events (
    institution_id, event_type, aggregate_type, aggregate_id, actor_user_id, payload
  ) VALUES (
    NEW.institution_id, v_event_type, 'loan', NEW.id, current_user_id(),
    jsonb_build_object(
      'loan_code',         NEW.loan_code,
      'client_id',         NEW.client_id,
      'branch_id',         NEW.branch_id,
      'principal',         NEW.principal::text,
      'outstanding',       NEW.outstanding_balance::text,
      'interest_method',   NEW.interest_method,
      'monthly_rate',      NEW.monthly_rate::text,
      'term_months',       NEW.term_months,
      'disbursement_date', NEW.disbursement_date
    )
  );

  RETURN NULL;
END;
$$;

ALTER FUNCTION emit_loan_domain_event() OWNER TO mfi_audit_writer;

CREATE TRIGGER trg_loans_emit_domain_event
  AFTER UPDATE OF status ON loans
  FOR EACH ROW EXECUTE FUNCTION emit_loan_domain_event();
