-- Savings, and the compulsory part of it that three BOT forms depend on.
--
-- This migration deliberately builds less than a savings subsystem. §13.4 asks
-- for the interest rate basis and accrual frequency, the minimum balance, the
-- withdrawal rules, and whether savings can secure a loan — and none of those
-- have been answered. Inventing them would put fabricated interest on a
-- client's statement, so there is no interest here at all: a balance is the sum
-- of what was paid in less what was taken out, and nothing accrues.
--
-- What is built is what the reporting spec settles and what the return cannot
-- be filed without. **Compulsory savings appears on three of BOT's forms**
-- (02-BOT-REPORTING-SPEC.md §1, R5): as a liability on MSP2-01 Sno46, as a
-- deduction from provisions on MSP2-03, and per district on MSP2-10 column E,
-- with validation rule 16 tying the last to the first. Until now those have
-- been reported as nil with a validator warning saying so.
--
-- The one rule enforced here that §13.4 does not settle is that a balance
-- cannot go negative. That is not a product decision: a negative savings
-- balance is an overdraft, which is a lending product this institution does not
-- offer, and letting a withdrawal create one would report a liability as an
-- asset. Everything §13.4 actually asks about — minimum balances, withdrawal
-- limits, whether compulsory savings may be withdrawn while the loan it
-- accompanies is outstanding — is absent rather than guessed at.

-- ---------------------------------------------------------------------------
-- Products
-- ---------------------------------------------------------------------------

CREATE TABLE savings_products (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  code           text        NOT NULL CHECK (length(btrim(code)) > 0),
  name           text        NOT NULL CHECK (length(btrim(name)) > 0),

  -- BOT's own distinction, and the reason this column exists rather than a
  -- product-name convention. Compulsory savings is reported on three forms and
  -- reduces provisions; voluntary savings appears on none of them. A misfiled
  -- flag moves money between a reported figure and an unreported one.
  is_compulsory  boolean     NOT NULL,

  -- TZS only, as everywhere else money is held. A foreign-currency savings
  -- product would need MSP2-07's rate and rate-date treatment, which no
  -- document asks for.
  currency_code  text        NOT NULL DEFAULT 'TZS' CHECK (currency_code = 'TZS'),

  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'closed')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT savings_products_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT savings_products_code_unique_per_institution UNIQUE (institution_id, code)
);

COMMENT ON TABLE savings_products IS
  'Savings products. No interest terms: §13.4 has not settled the rate basis or accrual frequency, and nothing here accrues.';
COMMENT ON COLUMN savings_products.is_compulsory IS
  'True where balances on this product are BOT compulsory savings, reported on MSP2-01 Sno46, MSP2-03 and MSP2-10.';

CREATE TRIGGER trg_savings_products_updated_at
  BEFORE UPDATE ON savings_products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_savings_products
  AFTER INSERT OR UPDATE OR DELETE ON savings_products
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE savings_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_products FORCE ROW LEVEL SECURITY;

CREATE POLICY savings_products_select ON savings_products
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY savings_products_insert ON savings_products
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY savings_products_update ON savings_products
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON savings_products TO mfi_app;

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

CREATE TABLE savings_accounts (
  id             uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  branch_id      uuid           NOT NULL,
  client_id      uuid           NOT NULL,
  product_id     uuid           NOT NULL,

  -- Human-readable, allocated by allocate_entity_code: SAV-2026-001.
  account_code   text           NOT NULL,

  status         text           NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'dormant', 'closed')),

  opened_on      date           NOT NULL CHECK (opened_on > DATE '2000-01-01'),
  closed_on      date,

  -- The current balance, maintained alongside the ledger below.
  --
  -- Held rather than computed on read, because the check that refuses an
  -- overdraft has to be atomic with the withdrawal that would cause one. A
  -- SUM taken before the write is a race; a column with a CHECK is not.
  balance        numeric(15, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),

  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT savings_accounts_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT savings_accounts_code_unique_per_institution
    UNIQUE (institution_id, account_code),

  CONSTRAINT savings_accounts_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id)
    ON DELETE RESTRICT,

  -- The client's own district and sector are what MSP2-10 and MSP2-03 read, so
  -- an account belonging to another institution's client would report a balance
  -- in the wrong place on somebody else's return.
  CONSTRAINT savings_accounts_client_within_institution
    FOREIGN KEY (client_id, institution_id) REFERENCES clients (id, institution_id)
    ON DELETE RESTRICT,

  CONSTRAINT savings_accounts_product_within_institution
    FOREIGN KEY (product_id, institution_id)
    REFERENCES savings_products (id, institution_id) ON DELETE RESTRICT,

  CONSTRAINT savings_accounts_closed_after_opened
    CHECK (closed_on IS NULL OR closed_on >= opened_on),

  -- A closed account holds nothing, and an account holding something is not
  -- closed. Without this a balance could sit on a closed account and vanish
  -- from every screen while still being owed to the client.
  CONSTRAINT savings_accounts_closed_is_empty
    CHECK (status <> 'closed' OR balance = 0)
);

COMMENT ON TABLE savings_accounts IS
  'One client''s savings on one product. `balance` is authoritative and maintained with the ledger; the CHECK is what refuses an overdraft atomically.';

-- Access paths: MSP2-10 groups balances by the client's district, MSP2-01 sums
-- them across the institution, and the client screen lists one client's.
CREATE INDEX savings_accounts_client_idx ON savings_accounts (institution_id, client_id);
CREATE INDEX savings_accounts_product_idx ON savings_accounts (institution_id, product_id);

CREATE TRIGGER trg_savings_accounts_updated_at
  BEFORE UPDATE ON savings_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_savings_accounts
  AFTER INSERT OR UPDATE OR DELETE ON savings_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE savings_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY savings_accounts_select ON savings_accounts
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY savings_accounts_insert ON savings_accounts
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY savings_accounts_update ON savings_accounts
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON savings_accounts TO mfi_app;

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

-- Append-only, like payments, and for the same reason: a savings balance is
-- money the institution owes a client, and a record of it that can be edited is
-- not evidence of anything. A mistake is corrected by a reversing entry, which
-- leaves both the error and the correction visible.
--
-- Dated as well as timestamped, because MSP2-10 reports the balance **as at**
-- the quarter end. Restating an old quarter is then a matter of summing the
-- entries dated on or before it, exactly as MSP2-06 restates from complaint
-- dates rather than from a stored figure.
CREATE TABLE savings_transactions (
  id                 uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id     uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  savings_account_id uuid           NOT NULL,

  direction          text           NOT NULL
                                    CHECK (direction IN ('deposit', 'withdrawal')),
  amount             numeric(15, 2) NOT NULL CHECK (amount > 0),

  -- The balance this entry left behind, so a statement reads without the reader
  -- having to re-sum every prior line, and so a drifted `savings_accounts.balance`
  -- is detectable rather than silent.
  balance_after      numeric(15, 2) NOT NULL CHECK (balance_after >= 0),

  transaction_date   date           NOT NULL CHECK (transaction_date > DATE '2000-01-01'),

  narrative          text           CHECK (narrative IS NULL OR length(btrim(narrative)) > 0),
  reference          text           CHECK (reference IS NULL OR length(btrim(reference)) > 0),

  -- Set on the entry that reverses another, never on the entry reversed. The
  -- original stays exactly as recorded.
  reverses_id        uuid,

  recorded_by        uuid           NOT NULL,
  created_at         timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT savings_transactions_id_institution_key UNIQUE (id, institution_id),

  CONSTRAINT savings_transactions_account_within_institution
    FOREIGN KEY (savings_account_id, institution_id)
    REFERENCES savings_accounts (id, institution_id) ON DELETE RESTRICT,

  CONSTRAINT savings_transactions_reverses_within_institution
    FOREIGN KEY (reverses_id, institution_id)
    REFERENCES savings_transactions (id, institution_id) ON DELETE RESTRICT
);

COMMENT ON TABLE savings_transactions IS
  'Append-only savings ledger. Dated, so MSP2-10 can report the balance as at a quarter end rather than as at today.';

-- One reversal per entry. Two would take the money out twice.
CREATE UNIQUE INDEX savings_transactions_one_reversal_idx
  ON savings_transactions (reverses_id) WHERE reverses_id IS NOT NULL;

-- Access paths: a statement reads one account in order; the return sums an
-- institution's entries up to a date.
CREATE INDEX savings_transactions_account_idx
  ON savings_transactions (savings_account_id, transaction_date, id);
CREATE INDEX savings_transactions_institution_date_idx
  ON savings_transactions (institution_id, transaction_date);

CREATE TRIGGER trg_audit_savings_transactions
  AFTER INSERT OR UPDATE OR DELETE ON savings_transactions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE savings_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings_transactions FORCE ROW LEVEL SECURITY;

CREATE POLICY savings_transactions_select ON savings_transactions
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY savings_transactions_insert ON savings_transactions
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());

-- No UPDATE and no DELETE, and no privilege for either. A ledger entry that can
-- be changed after the fact is not a ledger.
GRANT SELECT, INSERT ON savings_transactions TO mfi_app;
