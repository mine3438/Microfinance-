-- Clients and guarantors.
--
-- The client record is shaped by what BOT asks for, not by what a CRM would
-- collect. Every column here feeds at least one MSP2 form:
--
--   gender          → MSP2-09 (loans disbursed to female / to male)
--   date_of_birth   → MSP2-10 (borrowers by age band, up to 35 / above 35)
--   district_code   → MSP2-10 (geographical distribution)
--   sector_code     → MSP2-03 and MSP2-09 (sectoral classification)
--
-- Anything that does not serve a filing or an operational need is absent.

-- ---------------------------------------------------------------------------
-- clients
-- ---------------------------------------------------------------------------

CREATE TABLE clients (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  -- The branch that owns the relationship. Required, because MSP2-10 reports
  -- borrowers per district and a client belonging to no branch could not be
  -- placed on that return.
  branch_id      uuid        NOT NULL,

  -- Human-readable, allocated by allocate_entity_code: MFI-2026-001.
  client_code    text        NOT NULL,

  full_name      text        NOT NULL CHECK (length(btrim(full_name)) > 0),

  -- Male or female only. This is BOT's form constraint, not a product opinion:
  -- MSP2-09 and MSP2-10 split every count into exactly those two columns, and a
  -- third value would have nowhere to go on the return.
  gender         text        NOT NULL CHECK (gender IN ('male', 'female')),

  date_of_birth  date        NOT NULL,

  -- Stored in E.164. The previous schema held whatever the user typed and
  -- validated it only in the browser, so the same person could exist twice
  -- under 0712345678 and +255712345678.
  phone          text        NOT NULL CHECK (phone ~ '^\+255[67][0-9]{8}$'),

  -- Controlled vocabularies rather than free text. MSP2-10 aggregates across a
  -- fixed district hierarchy, and one misspelling silently drops a client out
  -- of the return.
  district_code  text        NOT NULL REFERENCES reference.districts (code),
  sector_code    text        NOT NULL REFERENCES reference.sectors (code),

  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'inactive')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT clients_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT clients_code_unique_per_institution UNIQUE (institution_id, client_code),

  CONSTRAINT clients_branch_within_institution
    FOREIGN KEY (branch_id, institution_id)
    REFERENCES branches (id, institution_id) ON DELETE RESTRICT,

  -- A borrower cannot be born in the future, and an implausible age is far more
  -- often a typed year than a real one. The lower bound is generous rather than
  -- a policy on lending age, which the documentation does not state.
  CONSTRAINT clients_date_of_birth_plausible
    CHECK (date_of_birth > DATE '1900-01-01' AND date_of_birth < CURRENT_DATE)
);

COMMENT ON TABLE clients IS 'Borrowers. Every column feeds an MSP2 return; see the migration header.';
COMMENT ON COLUMN clients.gender IS
  'Male or female only — MSP2-09 and MSP2-10 provide exactly two columns. A BOT form constraint, not a product opinion.';
COMMENT ON COLUMN clients.phone IS 'E.164, normalised on the way in so one person cannot exist twice.';

-- Access paths: client lists are scoped to an institution and filtered by
-- status; MSP2-10 aggregates by district; MSP2-03 and MSP2-09 by sector.
CREATE INDEX clients_institution_status_idx ON clients (institution_id, status);
CREATE INDEX clients_branch_idx ON clients (branch_id);
CREATE INDEX clients_district_idx ON clients (district_code);
CREATE INDEX clients_sector_idx ON clients (sector_code);

-- Name search. A loan officer looks a client up by name far more often than by
-- code, and a prefix scan over a growing book without this is a sequential read.
CREATE INDEX clients_name_search_idx ON clients (institution_id, lower(full_name));

CREATE TRIGGER trg_clients_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_clients
  AFTER INSERT OR UPDATE OR DELETE ON clients
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients FORCE ROW LEVEL SECURITY;

CREATE POLICY clients_select ON clients
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY clients_insert ON clients
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY clients_update ON clients
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE policy. A client who has ever held a loan is referenced by that
-- history; deactivation is the operation, and the previous schema took the same
-- position with ON DELETE RESTRICT from loans.
GRANT SELECT, INSERT, UPDATE ON clients TO mfi_app;

-- ---------------------------------------------------------------------------
-- guarantors
-- ---------------------------------------------------------------------------

-- People who stand behind a client's borrowing.
--
-- The record only. What a guarantee actually obliges — joint or several
-- liability, whether a guarantor may back more than one live loan, what happens
-- on default — is not stated anywhere in the supplied documentation
-- (00-PROJECT-ANALYSIS.md §2.1). Those rules bind a guarantee to a *loan*, so
-- they belong with the lending workflow rather than here, and building an
-- enforcement mechanism now would mean inventing the policy it enforces.
CREATE TABLE guarantors (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL,
  client_id      uuid        NOT NULL,

  full_name      text        NOT NULL CHECK (length(btrim(full_name)) > 0),
  relationship   text        NOT NULL CHECK (length(btrim(relationship)) > 0),
  phone          text        NOT NULL CHECK (phone ~ '^\+255[67][0-9]{8}$'),

  -- What the guarantor declares they can stand behind. Declared rather than
  -- verified: the system records what was stated, and does not imply the
  -- institution confirmed it.
  declared_value numeric(15, 2) CHECK (declared_value IS NULL OR declared_value >= 0),

  status         text        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'released')),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT guarantors_client_within_institution
    FOREIGN KEY (client_id, institution_id)
    REFERENCES clients (id, institution_id) ON DELETE RESTRICT
);

COMMENT ON TABLE guarantors IS
  'Guarantor records against a client. Liability rules are undocumented and are not enforced here.';
COMMENT ON COLUMN guarantors.declared_value IS
  'Stated by the guarantor. Recording it does not imply the institution verified it.';

CREATE INDEX guarantors_institution_idx ON guarantors (institution_id);
CREATE INDEX guarantors_client_idx ON guarantors (client_id);

CREATE TRIGGER trg_guarantors_updated_at
  BEFORE UPDATE ON guarantors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_guarantors
  AFTER INSERT OR UPDATE OR DELETE ON guarantors
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE guarantors ENABLE ROW LEVEL SECURITY;
ALTER TABLE guarantors FORCE ROW LEVEL SECURITY;

CREATE POLICY guarantors_select ON guarantors
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY guarantors_insert ON guarantors
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY guarantors_update ON guarantors
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON guarantors TO mfi_app;

-- ---------------------------------------------------------------------------
-- Client code allocation
-- ---------------------------------------------------------------------------

-- Fills client_code when the caller does not supply one.
--
-- A BEFORE INSERT trigger rather than a column default, because allocation must
-- know the institution the row belongs to and a default expression cannot see
-- sibling columns.
CREATE OR REPLACE FUNCTION set_client_code() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.client_code IS NULL OR btrim(NEW.client_code) = '' THEN
    NEW.client_code := allocate_entity_code(
      NEW.institution_id, 'client', 'MFI',
      extract(year FROM COALESCE(NEW.created_at, now()))::integer
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_clients_set_code
  BEFORE INSERT ON clients
  FOR EACH ROW EXECUTE FUNCTION set_client_code();

-- The column is NOT NULL, so the trigger has to run before the constraint is
-- checked; making it nullable would let a caller bypass allocation entirely.
ALTER TABLE clients ALTER COLUMN client_code DROP NOT NULL;
ALTER TABLE clients ADD CONSTRAINT clients_code_present
  CHECK (client_code IS NOT NULL AND length(btrim(client_code)) > 0);
