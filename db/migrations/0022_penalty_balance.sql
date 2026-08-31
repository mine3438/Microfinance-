-- What a loan has actually accrued in penalty, and how far it has been accrued.
--
-- Migration 0021 gave products their penalty terms and the domain the
-- arithmetic (§24.5). This is where a loan carries the result, so a payment has
-- something to allocate against — §24.3 put penalties first in the order, and
-- until now that bucket has been permanently nil.
--
-- Two columns, and the second is the one that makes the first trustworthy.

ALTER TABLE loans
  ADD COLUMN penalty_balance numeric(15, 2) NOT NULL DEFAULT 0
    CHECK (penalty_balance >= 0),

  -- The date accrual has been computed **to**, inclusive.
  --
  -- Without a watermark, "accrue penalty" is a question about how many times the
  -- job has run rather than about the loan: run it twice on Tuesday and the
  -- borrower owes twice as much. With one, the job charges the days between the
  -- watermark and the date it is asked about, and running it again the same day
  -- charges nothing. That is what makes the operation idempotent, and idempotent
  -- is not a nicety on a figure a borrower is asked to pay.
  --
  -- NULL until the first accrual, which is distinct from a watermark of the
  -- disbursement date: a loan that has never been accrued and a loan accrued to
  -- its first day are different states, and only the second means "the days
  -- before this were considered and charged nothing".
  ADD COLUMN penalty_accrued_to date,

  -- A penalty balance implies an accrual happened. The reverse is not true —
  -- accruing a loan that is not overdue leaves the balance at nothing — so this
  -- is one-directional.
  ADD CONSTRAINT loans_penalty_balance_implies_accrual
    CHECK (penalty_balance = 0 OR penalty_accrued_to IS NOT NULL),

  -- Nothing accrues before money is lent.
  ADD CONSTRAINT loans_penalty_accrued_after_disbursement
    CHECK (penalty_accrued_to IS NULL
           OR (disbursement_date IS NOT NULL AND penalty_accrued_to >= disbursement_date));

COMMENT ON COLUMN loans.penalty_balance IS
  'Penalty accrued and not yet paid. Allocated against first, per §24.3.';
COMMENT ON COLUMN loans.penalty_accrued_to IS
  'Date penalty has been accrued to, inclusive. NULL means never accrued. The watermark is what makes accrual idempotent.';

-- Access path: the accrual job asks for active loans whose watermark is behind
-- the date being accrued to, which is most of the book on the first run and few
-- of it thereafter.
CREATE INDEX loans_penalty_accrual_idx
  ON loans (institution_id, penalty_accrued_to)
  WHERE status = 'active';
