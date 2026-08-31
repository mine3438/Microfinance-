-- Complaints, and the roll-forward BOT asks for.
--
-- 02-BOT-REPORTING-SPEC.md §8 settled what this form needs, and it is more than
-- the "resolved / unresolved counts" the documents being replaced described.
-- MSP2-06 is a quarterly movement statement:
--
--   opening + new − resolved by the institution − resolved by other parties
--                                              = unresolved at the quarter end
--
-- reported as both a **count** and a **TZS value**, split across BOT's six
-- nature categories, with four further lines counting where the unresolved ones
-- were referred.
--
-- None of that can be derived from a stored quarterly figure, so complaints are
-- kept as records with dates and the form is derived from them. The alternative
-- — an entered dataset like MSP2-01 — would make an institution retype last
-- quarter's closing figure as this quarter's opening one, and a single typo
-- would then propagate through every return that followed it.
--
-- One constraint below does more work than it looks: `resolved_on >=
-- received_on`. BOT's roll-forward (rule 8) is an *identity* over these records
-- rather than an arithmetic claim about them — the set of complaints unresolved
-- at the quarter end is exactly opening plus new less those resolved during it,
-- and the only way the two could differ is a complaint resolved before it was
-- received. The database refuses that, so the identity holds by construction.

-- ---------------------------------------------------------------------------
-- MSP2-06's nine lines
-- ---------------------------------------------------------------------------

-- Read off the template's own sheet, like MSP2-05's in migration 0015: the
-- machine-readable taxonomy carries MSP2-01 and MSP2-02 and not this form.
INSERT INTO reference.form_lines (form_code, sno, label, is_computed, formula) VALUES
  ('MSP2-06', 1, 'Number of complaints at the beginning of the quarter', false, NULL),
  ('MSP2-06', 2, 'New complaints received during the quarter', false, NULL),
  ('MSP2-06', 3, 'Complaints resolved during the quarter by the institution', false, NULL),
  ('MSP2-06', 4,
   'Complaints resolved during the quarter by other parties (eg Courts, Bank of Tanzania, FCC)',
   false, NULL),
  ('MSP2-06', 5, 'Unresolved  complaints at the end of the quarter(1+2-3-4)', true,
   '=C14+C15-C16-C17'),
  ('MSP2-06', 6, 'Unresolved  complaints referred to Bank of Tanzania', false, NULL),
  ('MSP2-06', 7, 'Unresolved  complaints referred to Fair Competition Commission', false, NULL),
  ('MSP2-06', 8, 'Unresolved  complaints referred to Courts', false, NULL),
  ('MSP2-06', 9, 'Unresolved  complaints referred to Other Parties', false, NULL);

-- ---------------------------------------------------------------------------
-- The complaints themselves
-- ---------------------------------------------------------------------------

CREATE TABLE complaints (
  id                uuid           PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id    uuid           NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,
  branch_id         uuid           NOT NULL,

  -- Human-readable, allocated by allocate_entity_code: CMP-2026-001.
  complaint_code    text           NOT NULL,

  -- A complainant need not be a client on the books. Somebody refused a loan,
  -- or a guarantor pursued for one they did not take, has a complaint BOT
  -- counts and no client record to hang it on.
  client_id         uuid,
  complainant_name  text           NOT NULL CHECK (length(btrim(complainant_name)) > 0),

  -- BOT's six categories, as a key rather than as a string that resembles one.
  -- The form has a column per category and no room for a seventh.
  nature_code       text           NOT NULL REFERENCES reference.complaint_natures (code),

  summary           text           NOT NULL CHECK (length(btrim(summary)) > 0),

  -- The amount in dispute. Zero is a real answer — a complaint about a loan
  -- statement need not be about money — and BOT's value column is a sum over
  -- the same complaints its count column counts, so a nil value still belongs
  -- to a counted complaint.
  amount            numeric(15, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),

  received_on       date           NOT NULL CHECK (received_on > DATE '2000-01-01'),

  -- Resolution, in BOT's two routes and no others. The form's lines 3 and 4
  -- are the only ways a complaint leaves the unresolved population, so a
  -- resolution that names neither would vanish from the roll-forward.
  resolved_on       date,
  resolved_by       text           CHECK (resolved_by IN ('institution', 'other_party')),
  resolution_note   text           CHECK (resolution_note IS NULL
                                          OR length(btrim(resolution_note)) > 0),

  -- Where an unresolved complaint has been taken, and when. Dated because
  -- lines 6 to 9 count referrals as at the quarter end: one made in January
  -- does not belong on the return for the quarter that ended in December.
  referred_to       text           CHECK (referred_to IN ('bank_of_tanzania',
                                                          'fair_competition_commission',
                                                          'courts',
                                                          'other_parties')),
  referred_on       date,

  recorded_by       uuid           NOT NULL,
  created_at        timestamptz    NOT NULL DEFAULT now(),
  updated_at        timestamptz    NOT NULL DEFAULT now(),

  CONSTRAINT complaints_code_unique_per_institution UNIQUE (institution_id, complaint_code),

  CONSTRAINT complaints_branch_within_institution
    FOREIGN KEY (branch_id, institution_id) REFERENCES branches (id, institution_id)
    ON DELETE RESTRICT,

  -- A complaint cannot be about another institution's client.
  CONSTRAINT complaints_client_within_institution
    FOREIGN KEY (client_id, institution_id) REFERENCES clients (id, institution_id)
    ON DELETE RESTRICT,

  -- Resolved means resolved by somebody. Half a resolution would sit in no line
  -- of the form: counted out of the unresolved population by its date and into
  -- neither of the two lines that account for where it went.
  CONSTRAINT complaints_resolution_is_whole
    CHECK ((resolved_on IS NULL) = (resolved_by IS NULL)),

  -- The constraint BOT's rule 8 rests on. Without it the roll-forward is a
  -- claim; with it, it is an identity.
  CONSTRAINT complaints_resolved_after_received
    CHECK (resolved_on IS NULL OR resolved_on >= received_on),

  CONSTRAINT complaints_referral_is_whole
    CHECK ((referred_on IS NULL) = (referred_to IS NULL)),

  CONSTRAINT complaints_referred_after_received
    CHECK (referred_on IS NULL OR referred_on >= received_on)
);

COMMENT ON TABLE complaints IS
  'Customer complaints, with the dates, value, nature and resolution route MSP2-06 is derived from.';
COMMENT ON COLUMN complaints.nature_code IS
  'One of BOT''s six nature categories. The form has a column per category and no room for a seventh.';
COMMENT ON COLUMN complaints.referred_on IS
  'When the complaint was referred. Lines 6-9 count referrals as at the quarter end, so an undated referral could not be placed in a period.';

-- Access paths: the roll-forward reads a whole institution across two date
-- ranges, and the list screen reads a branch's most recent first.
CREATE INDEX complaints_institution_received_idx
  ON complaints (institution_id, received_on);
CREATE INDEX complaints_institution_resolved_idx
  ON complaints (institution_id, resolved_on) WHERE resolved_on IS NOT NULL;
CREATE INDEX complaints_branch_idx ON complaints (institution_id, branch_id, received_on DESC);

CREATE TRIGGER trg_complaints_updated_at
  BEFORE UPDATE ON complaints FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_complaints
  AFTER INSERT OR UPDATE OR DELETE ON complaints
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE complaints FORCE ROW LEVEL SECURITY;

CREATE POLICY complaints_select ON complaints
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY complaints_insert ON complaints
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
CREATE POLICY complaints_update ON complaints
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE, and no privilege for one.
--
-- A complaint that has been counted on a filed return cannot be made not to
-- have happened, and one recorded in error is corrected by resolving it with a
-- note saying so. The audit trigger keeps every version either way.
GRANT SELECT, INSERT, UPDATE ON complaints TO mfi_app;

-- ---------------------------------------------------------------------------
-- Where MSP2-06 sits in BOT's workbook
-- ---------------------------------------------------------------------------

-- The same treatment as the other nine forms (migration 0017): addresses are
-- read off the template and seeded, never computed. Sno5 is absent from
-- `form_rows` because BOT's own template computes the whole of row 18 —
-- including its count and value columns — and this system does not write over
-- their arithmetic.
INSERT INTO reference.form_sheets
  (form_code, sheet_name, sno_row_offset, identity_column) VALUES
  ('MSP2-06', 'MSP2-06', 13, 'C');

-- Keyed by BOT's own nature codes, so the exporter reads as a translation
-- rather than as a table of letters. Column K (the nature total) is BOT's
-- formula and has no key here.
INSERT INTO reference.form_columns (form_code, column_key, column_letter) VALUES
  ('MSP2-06', 'number', 'C'),
  ('MSP2-06', 'value', 'D'),
  ('MSP2-06', 'interest_rate', 'E'),
  ('MSP2-06', 'agreements', 'F'),
  ('MSP2-06', 'repayments', 'G'),
  ('MSP2-06', 'loan_statement', 'H'),
  ('MSP2-06', 'loan_processing', 'I'),
  ('MSP2-06', 'others', 'J');

INSERT INTO reference.form_rows (form_code, row_number, sno) VALUES
  ('MSP2-06', 14, 1),
  ('MSP2-06', 15, 2),
  ('MSP2-06', 16, 3),
  ('MSP2-06', 17, 4),
  ('MSP2-06', 19, 6),
  ('MSP2-06', 20, 7),
  ('MSP2-06', 21, 8),
  ('MSP2-06', 22, 9);
