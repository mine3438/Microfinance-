-- How much compulsory savings secures each loan.
--
-- §11.7 asked whether compulsory savings is a savings-product attribute, a
-- per-loan collateral amount, or both. **Answered: a per-loan collateral
-- amount** (01-ARCHITECTURE.md §24.1). The money still sits in a savings
-- account — that is what MSP2-01 Sno46 and MSP2-10 report — and this column
-- records how much of it stands behind a particular loan.
--
-- The answer is what makes MSP2-03's deduction exact. BOT subtracts "Cash
-- Collateral / Insurance Guarantee / Compulsory Savings" from the provision
-- **per sector**, and a loan belongs to exactly one sector, so the per-sector
-- figure is a sum. Under the other reading — a client's savings balance
-- attributed across their loans — a client borrowing in two sectors would have
-- no defined split, and this system would have had to invent one. Migration
-- 0019 left the deduction at nil for exactly that reason.

ALTER TABLE loans
  ADD COLUMN compulsory_savings_secured numeric(15, 2) NOT NULL DEFAULT 0
    CHECK (compulsory_savings_secured >= 0);

COMMENT ON COLUMN loans.compulsory_savings_secured IS
  'Compulsory savings held as security against this loan. Summed per sector for MSP2-03''s provision deduction; capped by the borrower''s compulsory savings balance.';

-- Access path: MSP2-03 sums this per sector across the loans outstanding at a
-- quarter end, and the trigger below sums it per client.
CREATE INDEX loans_collateral_idx
  ON loans (institution_id, client_id)
  WHERE compulsory_savings_secured > 0;

-- ---------------------------------------------------------------------------
-- Security that is actually held
-- ---------------------------------------------------------------------------

-- A cross-row invariant, so it cannot be a CHECK: **the total secured across a
-- borrower's loans may not exceed their compulsory savings balance.**
--
-- Without it, two loans could each claim the same shilling of savings and
-- MSP2-03 would deduct it twice — reporting a smaller provision than the
-- institution owes, which is the direction of error a regulator cares about.
-- The balance is read as at now rather than as at a quarter end, because this
-- is a question about what is being claimed today.
CREATE OR REPLACE FUNCTION enforce_collateral_within_savings() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_secured numeric(15, 2);
  v_held    numeric(15, 2);
BEGIN
  IF NEW.compulsory_savings_secured = 0 THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(sum(l.compulsory_savings_secured), 0)
    INTO v_secured
    FROM loans l
   WHERE l.client_id = NEW.client_id
     AND l.id <> NEW.id
     -- A settled loan releases its security. Counting it would let a borrower's
     -- history block a new loan against savings they still hold.
     AND l.status NOT IN ('completed', 'written_off', 'rejected');

  SELECT COALESCE(
           sum(CASE t.direction WHEN 'deposit' THEN t.amount ELSE -t.amount END), 0)
    INTO v_held
    FROM savings_transactions t
    JOIN savings_accounts a ON a.id = t.savings_account_id
    JOIN savings_products p ON p.id = a.product_id
   WHERE a.client_id = NEW.client_id
     AND p.is_compulsory;

  IF v_secured + NEW.compulsory_savings_secured > v_held THEN
    RAISE EXCEPTION
      'This borrower holds % in compulsory savings and % is already secured against other loans, so % cannot be secured here.',
      v_held, v_secured, NEW.compulsory_savings_secured
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION enforce_collateral_within_savings() IS
  'Refuses security a borrower does not hold. Two loans claiming the same shilling would make MSP2-03 deduct it twice.';

CREATE TRIGGER trg_loans_collateral_within_savings
  BEFORE INSERT OR UPDATE OF compulsory_savings_secured, client_id ON loans
  FOR EACH ROW EXECUTE FUNCTION enforce_collateral_within_savings();
