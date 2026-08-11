-- The balance sheet and the liquid-asset computation.
--
-- 02-BOT-REPORTING-SPEC.md §9 records the decision: Option 1, a structured
-- quarterly dataset the institution fills in, with every line this system can
-- derive auto-populated and locked. Roughly 95 of MSP2-01 and MSP2-02's 103
-- line items are accounting balances no operational lending system holds, and
-- building a general ledger to reach them would delay the first filing — which
-- is the assumption the project most needs tested against reality.
--
-- "Locked" is expressed here by having nowhere to write. A derived line has no
-- row in `financial_statement_lines`, and the composite key below refuses one:
-- a caller cannot overwrite the loan book's own figure because there is no
-- column that would hold their version of it.

-- ---------------------------------------------------------------------------
-- MSP2-05's lines
-- ---------------------------------------------------------------------------

-- Read from the template's own MSP2-05 sheet (`docs/reference/`), which is the
-- only place the eight liquid-asset categories are written down — the
-- machine-readable taxonomy carries MSP2-01 and MSP2-02 and not this form.
INSERT INTO reference.form_lines (form_code, sno, label, is_computed, formula) VALUES
  ('MSP2-05', 1, 'A: TOTAL AVAILABLE LIQUID ASSETS', true, '=SUM(C15:C22)'),
  ('MSP2-05', 2, '(a) Cash in hand', false, NULL),
  ('MSP2-05', 3, '(b) Balances with  Banks and Financial Institutions', false, NULL),
  ('MSP2-05', 4, '(c ) Balances with Microfinance Service Providers', false, NULL),
  ('MSP2-05', 5, '(d ) MNOs Float Cash Balances', false, NULL),
  ('MSP2-05', 6, '(e)  Treasury Bills (Unencumbered)', false, NULL),
  ('MSP2-05', 7, '(f)Other Government Securities with Residual Maturity of One Year or Less (Unencumbered)', false, NULL),
  ('MSP2-05', 8, '(g) Private Securities with Residual Maturity of One Year or Less  (Unencumbered)', false, NULL),
  ('MSP2-05', 9, '(h) Other Liquid Assets Maturing within 12 Months', false, NULL),
  ('MSP2-05', 10, 'B. TOTAL ASSETS', true, '=[1]MSP2_01!C46'),
  ('MSP2-05', 11, 'C: Required Minimum Liquid Assets (5%*B)', true, '=0.05*C23'),
  ('MSP2-05', 12, 'D: Excess (Deficiency) Liquid Assets (A-C)', true, '=C14-C24'),
  ('MSP2-05', 13, 'E: Liquid Asset Ratio (A / B)', true, '=C14/C23');

-- ---------------------------------------------------------------------------
-- Which lines an institution may enter a figure against
-- ---------------------------------------------------------------------------

ALTER TABLE reference.form_lines
  ADD COLUMN accepts_statement_entry boolean
    CHECK (accepts_statement_entry IS NULL OR accepts_statement_entry);

COMMENT ON COLUMN reference.form_lines.accepts_statement_entry IS
  'True where a quarterly statement figure is typed in. NULL where the line is computed, derived from elsewhere in this system, or a section header.';

-- Every MSP2-01 line BOT does not compute, minus the ones below.
UPDATE reference.form_lines SET accepts_statement_entry = true
 WHERE form_code = 'MSP2-01' AND is_computed = false;

-- Derived, and therefore locked. Each has a source inside this system, and
-- every one of them is named either by §9's list or by a BOT validation rule:
--
--   4, 5      non-agent and agent banking balances     MSP2-07 / MSP2-08 (rules 14, 15)
--   6, 7      microfinance provider and MNO balances   MSP2-07 (rules 10, 11)
--   18        loans to clients                         the loan book
--   22        allowance for probable losses            the provisioning engine
--   37, 38    borrowings in Tanzania                   MSP2-07 (rules 9, 10)
--   43        borrowings from abroad                   MSP2-07 (rule 13)
--   46        cash collateral / compulsory savings     MSP2-10 (rule 16)
--   59        profit or loss                           MSP2-02 Sno42 YTD (rule 2)
--
-- A figure typed against any of these would be a second answer to a question
-- the system already answers, and the two could disagree on a filed return.
UPDATE reference.form_lines SET accepts_statement_entry = NULL
 WHERE form_code = 'MSP2-01'
   AND sno IN (4, 5, 6, 7, 18, 22, 37, 38, 43, 46, 59);

-- Sno34 is a section heading, and BOT's own arithmetic proves it.
--
-- The template gives "8. LIABILITIES" an enterable cell, but Sno50 (Total
-- Liabilities) sums Sno35, 46, 47, 48 and 49 — not Sno34. A figure typed there
-- is reported nowhere and reduces no total, so it would silently vanish from a
-- filed balance sheet. Entry is refused rather than accepted and discarded.
UPDATE reference.form_lines SET accepts_statement_entry = NULL
 WHERE form_code = 'MSP2-01' AND sno = 34;

-- MSP2-05: the four unencumbered-securities lines are typed in. Its first four
-- amounts restate MSP2-01 (rule 5), so they are derived, and the rest are
-- computed.
UPDATE reference.form_lines SET accepts_statement_entry = true
 WHERE form_code = 'MSP2-05' AND sno IN (6, 7, 8, 9);

-- The invariant, asserted rather than assumed: nothing computed accepts entry.
DO $$
DECLARE
  v_bad integer;
BEGIN
  SELECT count(*) INTO v_bad
    FROM reference.form_lines
   WHERE is_computed = true AND accepts_statement_entry IS NOT NULL;

  IF v_bad > 0 THEN
    RAISE EXCEPTION 'A computed line was marked as accepting a statement entry';
  END IF;
END;
$$;

ALTER TABLE reference.form_lines
  ADD CONSTRAINT form_lines_statement_entry_key
  UNIQUE (form_code, sno, accepts_statement_entry);

-- ---------------------------------------------------------------------------
-- financial_statement_lines
-- ---------------------------------------------------------------------------

CREATE TABLE financial_statement_lines (
  id             uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  form_code      text           NOT NULL CHECK (form_code IN ('MSP2-01', 'MSP2-05')),
  sno            smallint       NOT NULL,

  year           smallint       NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  quarter        smallint       NOT NULL CHECK (quarter BETWEEN 1 AND 4),

  -- Signed. A balance sheet carries deduction lines BOT subtracts rather than
  -- negates — "Allowance for Probable Losses (Deduction)" is entered positive
  -- and taken away by the formula — but retained earnings can genuinely be
  -- negative, and clamping it at zero would file a figure that is not the
  -- institution's.
  amount         numeric(15, 2) NOT NULL,

  -- Always true, so the composite key below can require the referenced line to
  -- be one that accepts entry. A derived or computed line has NULL there and
  -- can never match, which is what makes "locked" enforceable rather than
  -- merely intended.
  accepts_entry  boolean        NOT NULL DEFAULT true CHECK (accepts_entry),

  updated_by     uuid           NOT NULL,
  created_at     timestamptz    NOT NULL DEFAULT now(),
  updated_at     timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT financial_statement_lines_line
    FOREIGN KEY (form_code, sno, accepts_entry)
    REFERENCES reference.form_lines (form_code, sno, accepts_statement_entry),

  -- One figure per line per quarter. Two would make the balance sheet depend
  -- on which row a query happened to find.
  CONSTRAINT financial_statement_lines_one_per_quarter
    UNIQUE (institution_id, form_code, sno, year, quarter)
);

COMMENT ON TABLE financial_statement_lines IS
  'Quarterly statement figures an institution enters. Lines this system derives are absent by construction — see migration 0015.';

CREATE INDEX financial_statement_lines_period_idx
  ON financial_statement_lines (institution_id, form_code, year, quarter);

CREATE TRIGGER trg_financial_statement_lines_updated_at
  BEFORE UPDATE ON financial_statement_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_financial_statement_lines
  AFTER INSERT OR UPDATE OR DELETE ON financial_statement_lines
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE financial_statement_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_statement_lines FORCE ROW LEVEL SECURITY;

CREATE POLICY financial_statement_lines_select ON financial_statement_lines
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY financial_statement_lines_insert ON financial_statement_lines
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY financial_statement_lines_update ON financial_statement_lines
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());
CREATE POLICY financial_statement_lines_delete ON financial_statement_lines
  FOR DELETE TO mfi_app USING (institution_id = current_institution_id());

-- Editable while a quarter is being prepared, and audited throughout. A
-- balance sheet is assembled over days as figures arrive from elsewhere in the
-- institution; making each line write-once would mean a typo could only be
-- corrected by someone with database access.
GRANT SELECT, INSERT, UPDATE, DELETE ON financial_statement_lines TO mfi_app;
