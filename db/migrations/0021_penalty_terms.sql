-- Penalty terms, in the shape §13.1 confirmed.
--
-- 01-ARCHITECTURE.md §24.2 records the answer: configured per loan product, a
-- penalty rate, basis = **overdue instalment amount**, a grace period in days,
-- accrual **daily, simple, non-compounding**, and an optional cap as a
-- percentage of principal.
--
-- **The default values are still outstanding**, and that is why every column
-- below is nullable and no product is seeded with terms. The shape can exist
-- without the figures — a product with no penalty terms simply charges none —
-- but inventing a rate would put a fabricated charge on a borrower's account,
-- which is the one thing §13 exists to prevent. A product gets terms when the
-- institution states them.
--
-- The basis and the accrual method are *not* columns. They are the answer to
-- §13.1 rather than a per-product choice, and a column would invite a second
-- answer to a question that has one. If BOT or the institution ever needs a
-- second basis, that is a migration and a domain change together, not a value
-- somebody sets in a form.

ALTER TABLE loan_products
  -- Daily rate as a fraction, matching @mfi/money's Rate: 0.0010 is 0.1% a day
  -- on the overdue instalment. Four decimal places, as the interest rates
  -- beside it.
  ADD COLUMN penalty_daily_rate numeric(6, 4)
    CHECK (penalty_daily_rate IS NULL OR penalty_daily_rate >= 0),

  -- Days after an instalment falls due before penalty begins to accrue. Zero is
  -- a real answer — penalty from the first day late — and distinct from NULL,
  -- which means this product has no penalty at all.
  ADD COLUMN penalty_grace_days integer
    CHECK (penalty_grace_days IS NULL OR penalty_grace_days >= 0),

  -- Optional even once the rest is configured: the answer says "an optional cap
  -- as a percentage of principal", so a product may have penalty terms and no
  -- ceiling. Expressed as a fraction of the loan's principal.
  ADD COLUMN penalty_cap_fraction numeric(6, 4)
    CHECK (penalty_cap_fraction IS NULL OR penalty_cap_fraction > 0),

  -- Terms are whole or absent. A rate with no grace period would leave the
  -- accrual engine guessing when to start, and a grace period with no rate
  -- would charge nothing while looking configured — which is worse, because it
  -- reads as a deliberate policy on screen.
  ADD CONSTRAINT loan_products_penalty_terms_are_whole
    CHECK ((penalty_daily_rate IS NULL) = (penalty_grace_days IS NULL)),

  -- A cap without terms to cap is a figure nothing reads.
  ADD CONSTRAINT loan_products_penalty_cap_needs_terms
    CHECK (penalty_cap_fraction IS NULL OR penalty_daily_rate IS NOT NULL);

COMMENT ON COLUMN loan_products.penalty_daily_rate IS
  'Daily penalty rate on the overdue instalment, as a fraction. NULL means this product charges no penalty; §13.1''s default values are outstanding.';
COMMENT ON COLUMN loan_products.penalty_grace_days IS
  'Days after due date before penalty accrues. 0 means from the first day late; NULL means no penalty terms at all.';
COMMENT ON COLUMN loan_products.penalty_cap_fraction IS
  'Ceiling on accrued penalty, as a fraction of principal. NULL means uncapped, which the answer permits.';
