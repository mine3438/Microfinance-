-- Income, expenditure, and the balances an institution holds elsewhere.
--
-- Three tables, and between them they produce MSP2-02 (statement of income and
-- expense), MSP2-07 (deposits and borrowings) and MSP2-08 (agent banking).
--
-- The design point that matters is where categories come from. The system
-- being replaced kept a flat `expenses` table whose category was a free-text
-- string enforced only in the browser, so a direct API call could put any
-- string into a field that flows onto a regulatory filing (00-PROJECT-ANALYSIS
-- R12). BOT does not have categories in that sense — it has 42 numbered lines,
-- and every figure an institution reports belongs to exactly one of them.
--
-- So a category here is a foreign key into `reference.form_lines`, and it is
-- not merely "some line": the composite key below admits only lines BOT
-- accepts entry on, on the correct side of the statement. An expense recorded
-- against an income line, or against a line the template computes, is refused
-- by the database rather than discovered by BOT.

-- ---------------------------------------------------------------------------
-- Which lines accept an entry, and on which side
-- ---------------------------------------------------------------------------

ALTER TABLE reference.form_lines
  ADD COLUMN entry_direction text
    CHECK (entry_direction IS NULL OR entry_direction IN ('income', 'expense'));

COMMENT ON COLUMN reference.form_lines.entry_direction IS
  'Side of MSP2-02 this line takes entries on. NULL means the line is computed, or belongs to a form that is not entered this way.';

-- Interest income (a–e under Sno1) and non-interest income (a–f under Sno16).
UPDATE reference.form_lines SET entry_direction = 'income'
 WHERE form_code = 'MSP2-02' AND sno IN (2, 3, 4, 5, 6, 17, 18, 19, 20, 21, 22);

-- Interest expense (a–e under Sno7), the two deductions BOT lists separately
-- (Sno14 bad debts written off, Sno15 provision for bad and doubtful debts),
-- the sixteen non-interest expense lines (a–p under Sno23), and the tax
-- provision (Sno41).
--
-- Sno14 and Sno15 subtract in BOT's own formula for Sno40, which is why they
-- are expenses here rather than a third direction: the template's arithmetic
-- already treats them as reductions of income.
UPDATE reference.form_lines SET entry_direction = 'expense'
 WHERE form_code = 'MSP2-02'
   AND sno IN (8, 9, 10, 11, 12, 14, 15, 24, 25, 26, 27, 28, 29, 30, 31, 32,
               33, 34, 35, 36, 37, 38, 39, 41);

-- Every entered line on MSP2-02 now has a direction, and every computed one
-- does not. Asserted rather than assumed: a line left without a direction
-- would silently accept no entries and report zero, which is the failure mode
-- this whole migration exists to prevent.
DO $$
DECLARE
  v_missing integer;
BEGIN
  SELECT count(*) INTO v_missing
    FROM reference.form_lines
   WHERE form_code = 'MSP2-02'
     AND is_computed = false
     AND entry_direction IS NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'MSP2-02 has % entered line(s) with no direction', v_missing;
  END IF;

  SELECT count(*) INTO v_missing
    FROM reference.form_lines
   WHERE is_computed = true AND entry_direction IS NOT NULL;

  IF v_missing > 0 THEN
    RAISE EXCEPTION 'A computed line was given an entry direction';
  END IF;
END;
$$;

-- The key `finance_entries` points at. A NULL `entry_direction` can never
-- satisfy a NOT NULL child column, so referencing a computed line is a
-- foreign-key violation without needing a rule that says so.
ALTER TABLE reference.form_lines
  ADD CONSTRAINT form_lines_entry_key UNIQUE (form_code, sno, entry_direction);

-- ---------------------------------------------------------------------------
-- finance_entries
-- ---------------------------------------------------------------------------

CREATE TABLE finance_entries (
  id             uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  -- Optional. Not every cost belongs to a branch — a licence fee is the
  -- institution's — and forcing one would put head-office costs in whichever
  -- branch the person recording them happened to belong to.
  branch_id      uuid,

  direction      text           NOT NULL CHECK (direction IN ('income', 'expense')),

  -- Fixed to MSP2-02 by a check rather than left open. The column exists
  -- because the foreign key needs it and because a future form that accepts
  -- entries would extend the check; it is not a place to put an arbitrary
  -- form code today.
  form_code      text           NOT NULL DEFAULT 'MSP2-02'
                                CHECK (form_code = 'MSP2-02'),
  sno            smallint       NOT NULL,

  amount         numeric(15, 2) NOT NULL CHECK (amount > 0),

  -- Dated, not bucketed by quarter.
  --
  -- The previous schema scoped an entry to (institution, year, quarter), which
  -- makes the quarter a fact somebody types rather than one the date implies —
  -- and MSP2-02 carries a year-to-date column, so the same rows must aggregate
  -- two different ways. A date supports both, and it leaves the fiscal-year
  -- question (02-BOT-REPORTING-SPEC.md §11.8) answerable either way without
  -- restating a single row.
  entry_date     date           NOT NULL
                                CHECK (entry_date > DATE '2000-01-01'),

  description    text           CHECK (description IS NULL OR length(btrim(description)) > 0),
  -- Invoice, receipt or voucher number, as the institution files it.
  reference      text           CHECK (reference IS NULL OR length(btrim(reference)) > 0),

  recorded_by    uuid           NOT NULL,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT finance_entries_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id) ON DELETE RESTRICT,

  -- The line must exist, must accept entries, and must be on this entry's
  -- side of the statement. All three in one key.
  CONSTRAINT finance_entries_line
    FOREIGN KEY (form_code, sno, direction)
    REFERENCES reference.form_lines (form_code, sno, entry_direction)
);

COMMENT ON TABLE finance_entries IS
  'Income and expenditure, each mapped to the BOT MSP2-02 line it reports on. Replaces the free-text category of R12.';
COMMENT ON COLUMN finance_entries.sno IS
  'BOT line number on MSP2-02. The category is the line, not a string that resembles one.';

-- Access path: MSP2-02 aggregates a period, and a year-to-date column
-- aggregates a longer one. Both read by institution across a date range.
CREATE INDEX finance_entries_institution_date_idx
  ON finance_entries (institution_id, entry_date);
CREATE INDEX finance_entries_line_idx ON finance_entries (institution_id, sno);

CREATE TRIGGER trg_finance_entries_updated_at
  BEFORE UPDATE ON finance_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_finance_entries
  AFTER INSERT OR UPDATE OR DELETE ON finance_entries
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE finance_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE finance_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY finance_entries_select ON finance_entries
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY finance_entries_insert ON finance_entries
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY finance_entries_update ON finance_entries
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());
CREATE POLICY finance_entries_delete ON finance_entries
  FOR DELETE TO mfi_app USING (institution_id = current_institution_id());

-- Editable and deletable, unlike a payment.
--
-- A payment is evidence of money a borrower handed over; an expense entry is a
-- bookkeeping classification of the institution's own spending, and
-- reclassifying one is ordinary work rather than a correction to a record of
-- fact. Every change is captured by the audit trigger above, so "who moved
-- this figure between lines" remains answerable.
GRANT SELECT, INSERT, UPDATE, DELETE ON finance_entries TO mfi_app;

-- ---------------------------------------------------------------------------
-- bank_accounts
-- ---------------------------------------------------------------------------

-- The composite keys `bank_accounts` resolves its counterparty against. Added
-- before the table, because a foreign key cannot be declared against a key
-- that does not exist yet.
ALTER TABLE reference.financial_institutions
  ADD CONSTRAINT financial_institutions_code_kind_key UNIQUE (code, kind),
  ADD CONSTRAINT financial_institutions_code_agent_key UNIQUE (code, in_agent_banking_list);

-- Where an institution's money sits when it is not lent out.
--
-- BOT's MSP2-07 has four sections, and only two of them are drawn from a fixed
-- list: banks in Tanzania (56 published institutions) and MNOs (six). Balances
-- with other microfinance service providers and with banks abroad are typed in
-- by name — BOT publishes no list for either. So the counterparty is a foreign
-- key for the first two and free text for the last two, and the check below
-- makes it impossible to supply both or neither.
CREATE TABLE bank_accounts (
  id                     uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id         uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  holding_kind           text        NOT NULL
                                     CHECK (holding_kind IN ('bank_tanzania',
                                                             'microfinance_service_provider',
                                                             'mno',
                                                             'bank_abroad')),

  institution_code       text        REFERENCES reference.financial_institutions (code),
  counterparty_name      text        CHECK (counterparty_name IS NULL
                                            OR length(btrim(counterparty_name)) > 0),

  -- Which of BOT's two kinds the referenced institution must be. Derived, so a
  -- bank cannot be filed as an MNO or the reverse.
  reference_kind         text        GENERATED ALWAYS AS (
                                       CASE holding_kind
                                         WHEN 'bank_tanzania' THEN 'bank'
                                         WHEN 'mno' THEN 'mno'
                                       END
                                     ) STORED,

  -- Whether BOT lists this institution for agent banking.
  --
  -- Not a preference. The foreign key below requires this to equal BOT's own
  -- flag exactly, so the column is a copy of a published fact rather than a
  -- setting — held here only so the balance table can refuse an agent-banking
  -- figure that MSP2-08 would have no row for.
  supports_agent_banking boolean     NOT NULL DEFAULT false,

  account_number         text        CHECK (account_number IS NULL
                                            OR length(btrim(account_number)) > 0),
  -- ISO 4217. TZS unless the account is held abroad or in foreign currency;
  -- MSP2-07 reports foreign holdings in a separate TZS-equivalent column.
  currency_code          text        NOT NULL DEFAULT 'TZS'
                                     CHECK (currency_code ~ '^[A-Z]{3}$'),

  status                 text        NOT NULL DEFAULT 'active'
                                     CHECK (status IN ('active', 'closed')),

  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bank_accounts_counterparty_is_named CHECK (
    (holding_kind IN ('bank_tanzania', 'mno')
       AND institution_code IS NOT NULL AND counterparty_name IS NULL)
    OR
    (holding_kind IN ('microfinance_service_provider', 'bank_abroad')
       AND institution_code IS NULL AND counterparty_name IS NOT NULL)
  ),

  -- An institution BOT does not list for agent banking cannot support it, and
  -- a counterparty that is not on any BOT list cannot either.
  CONSTRAINT bank_accounts_agent_banking_matches_bot
    FOREIGN KEY (institution_code, supports_agent_banking)
    REFERENCES reference.financial_institutions (code, in_agent_banking_list),
  CONSTRAINT bank_accounts_unlisted_has_no_agent_banking
    CHECK (institution_code IS NOT NULL OR supports_agent_banking = false),

  CONSTRAINT bank_accounts_reference_kind_matches
    FOREIGN KEY (institution_code, reference_kind)
    REFERENCES reference.financial_institutions (code, kind),

  -- Referenced by the balance table so its own checks stay single-table.
  CONSTRAINT bank_accounts_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT bank_accounts_id_agent_banking_key UNIQUE (id, supports_agent_banking),
  CONSTRAINT bank_accounts_id_currency_key UNIQUE (id, currency_code)
);

COMMENT ON TABLE bank_accounts IS
  'Balances held with banks, other microfinance providers, and MNOs. Feeds MSP2-07, MSP2-08 and MSP2-01.';

-- One account per counterparty per institution, so two rows cannot each hold
-- half a balance BOT wants reported once.
CREATE UNIQUE INDEX bank_accounts_one_per_listed_counterparty
  ON bank_accounts (institution_id, institution_code, currency_code)
  WHERE institution_code IS NOT NULL AND status = 'active';
CREATE UNIQUE INDEX bank_accounts_one_per_named_counterparty
  ON bank_accounts (institution_id, holding_kind, lower(counterparty_name), currency_code)
  WHERE counterparty_name IS NOT NULL AND status = 'active';

CREATE INDEX bank_accounts_institution_kind_idx
  ON bank_accounts (institution_id, holding_kind);

CREATE TRIGGER trg_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_bank_accounts
  AFTER INSERT OR UPDATE OR DELETE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY bank_accounts_select ON bank_accounts
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY bank_accounts_insert ON bank_accounts
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY bank_accounts_update ON bank_accounts
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE. An account with reported balances against it is part of a filing
-- history; closing it is a status change.
GRANT SELECT, INSERT, UPDATE ON bank_accounts TO mfi_app;

-- ---------------------------------------------------------------------------
-- bank_account_balances
-- ---------------------------------------------------------------------------

-- What each account held at a quarter end.
--
-- A snapshot per quarter rather than a running balance: MSP2-07 asks what was
-- held on the reporting date, and an institution's own bank statement is the
-- authority for that. Deriving it from transactions this system does not
-- record would be inventing a figure.
CREATE TABLE bank_account_balances (
  id                        uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id            uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  bank_account_id           uuid           NOT NULL,

  year                      smallint       NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  quarter                   smallint       NOT NULL CHECK (quarter BETWEEN 1 AND 4),

  -- Carried from the account so every check below is single-table. Held
  -- together by the composite foreign keys, so they cannot drift.
  currency_code             text           NOT NULL,
  supports_agent_banking    boolean        NOT NULL,

  -- Held in the account's own currency.
  deposit_balance           numeric(15, 2) NOT NULL DEFAULT 0 CHECK (deposit_balance >= 0),
  borrowing_balance         numeric(15, 2) NOT NULL DEFAULT 0 CHECK (borrowing_balance >= 0),

  -- The same two figures in TZS, which is the only currency BOT's forms carry.
  -- Equal to the balances above for a TZS account; converted for any other.
  -- Computed by `@mfi/money` on the way in, never by this table: a generated
  -- column would do the multiplication in double precision.
  deposit_balance_tzs       numeric(15, 2) NOT NULL DEFAULT 0 CHECK (deposit_balance_tzs >= 0),
  borrowing_balance_tzs     numeric(15, 2) NOT NULL DEFAULT 0 CHECK (borrowing_balance_tzs >= 0),

  -- MSP2-08. Nil for an account whose institution BOT does not list.
  agent_banking_balance     numeric(15, 2) NOT NULL DEFAULT 0 CHECK (agent_banking_balance >= 0),

  -- Which rate turned foreign currency into TZS, and when it was taken.
  -- Recorded because BOT's own guidance does not say which rate applies
  -- (02-BOT-REPORTING-SPEC.md §11.6): whatever an institution used, the filing
  -- can be explained afterwards.
  exchange_rate             numeric(18, 6) CHECK (exchange_rate IS NULL OR exchange_rate > 0),
  rate_date                 date,

  recorded_by               uuid           NOT NULL,
  created_at                timestamptz    NOT NULL DEFAULT now(),
  updated_at                timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT bank_account_balances_account_within_institution
    FOREIGN KEY (bank_account_id, institution_id)
    REFERENCES bank_accounts (id, institution_id) ON DELETE RESTRICT,
  CONSTRAINT bank_account_balances_currency_matches_account
    FOREIGN KEY (bank_account_id, currency_code)
    REFERENCES bank_accounts (id, currency_code),
  CONSTRAINT bank_account_balances_agent_banking_matches_account
    FOREIGN KEY (bank_account_id, supports_agent_banking)
    REFERENCES bank_accounts (id, supports_agent_banking),

  -- A balance BOT has no row for cannot be reported, so it cannot be recorded.
  CONSTRAINT bank_account_balances_agent_banking_is_eligible
    CHECK (agent_banking_balance = 0 OR supports_agent_banking),

  -- A TZS account converts at par and needs no rate; anything else needs both
  -- a rate and the date it was taken, or the TZS column cannot be explained.
  CONSTRAINT bank_account_balances_conversion_is_stated CHECK (
    (currency_code = 'TZS'
       AND exchange_rate IS NULL AND rate_date IS NULL
       AND deposit_balance_tzs = deposit_balance
       AND borrowing_balance_tzs = borrowing_balance)
    OR
    (currency_code <> 'TZS' AND exchange_rate IS NOT NULL AND rate_date IS NOT NULL)
  ),

  -- One figure per account per quarter. Two would mean the total BOT reads
  -- depends on which row a query happened to find.
  CONSTRAINT bank_account_balances_one_per_quarter UNIQUE (bank_account_id, year, quarter)
);

COMMENT ON TABLE bank_account_balances IS
  'Quarter-end balances per account, in the account currency and in TZS. Feeds MSP2-07 and MSP2-08.';
COMMENT ON COLUMN bank_account_balances.exchange_rate IS
  'Rate used to state a foreign balance in TZS. Which rate BOT expects is open — see 02-BOT-REPORTING-SPEC.md §11.6.';

CREATE INDEX bank_account_balances_period_idx
  ON bank_account_balances (institution_id, year, quarter);

CREATE TRIGGER trg_bank_account_balances_updated_at
  BEFORE UPDATE ON bank_account_balances FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_bank_account_balances
  AFTER INSERT OR UPDATE OR DELETE ON bank_account_balances
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE bank_account_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_account_balances FORCE ROW LEVEL SECURITY;

CREATE POLICY bank_account_balances_select ON bank_account_balances
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY bank_account_balances_insert ON bank_account_balances
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY bank_account_balances_update ON bank_account_balances
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE: a quarter's reported balance stays on the record. Correcting one
-- is an update, which the audit trigger captures with both values.
GRANT SELECT, INSERT, UPDATE ON bank_account_balances TO mfi_app;
