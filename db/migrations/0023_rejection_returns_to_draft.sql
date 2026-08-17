-- A rejected application goes back to the officer, as a draft.
--
-- §13.3's remaining behavioural question, answered: rejection is not terminal.
-- A loan officer who has a decision returned rework it and resubmit rather than
-- rekeying the whole application, which is how the work actually happens — the
-- reasons for rejection are usually a missing document or a term that needs
-- changing, not a judgement that the borrower should never be lent to.
--
-- The rejection is still *recorded*. The decision path moves the loan through
-- `rejected` — capturing the decider, the timestamp and the required reason,
-- and firing the audit trigger — and then on to `draft` in the same
-- transaction. So the history says "rejected by X on Y because Z" while the
-- officer's queue says "draft, needs work".
--
-- Without this transition the second step would be refused and the loan would
-- sit in a state nothing could move it out of.

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

COMMENT ON FUNCTION enforce_loan_transition() IS
  'The loan status machine. Rejection returns an application to draft so the officer can revise and resubmit; the rejection itself is recorded on the way through.';
