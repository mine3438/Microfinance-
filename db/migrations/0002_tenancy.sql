-- Tenancy: the institution as tenant root, branches beneath it, and the
-- row-level security machinery that keeps one institution's data invisible to
-- every other.
--
-- `01-ARCHITECTURE.md` §9.1 describes defence in depth: the application layer
-- scopes every query by tenant, and this layer refuses anything that slips
-- through. The analysis (R6) records why the second layer exists — in the
-- system this replaces, RLS was the *only* check, with nothing proving it held.

-- ---------------------------------------------------------------------------
-- Tenant resolution
-- ---------------------------------------------------------------------------

-- The institution the current transaction is acting for.
--
-- Read from a session setting that the application sets with
-- `SET LOCAL app.institution_id = '<uuid>'` at the start of every tenant-scoped
-- transaction. `SET LOCAL` scopes it to that transaction, so a pooled
-- connection cannot leak one tenant's context into the next request.
--
-- Returns NULL when unset, which makes every policy below evaluate false. That
-- direction matters: forgetting to set the context yields *no rows*, never all
-- rows. The system fails closed.
CREATE OR REPLACE FUNCTION current_institution_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.institution_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_institution_id() IS
  'Institution for the current transaction, from app.institution_id. NULL when unset, so policies fail closed.';

GRANT EXECUTE ON FUNCTION current_institution_id() TO mfi_app;

-- ---------------------------------------------------------------------------
-- institutions
-- ---------------------------------------------------------------------------

-- The tenant root. One row per microfinance service provider.
CREATE TABLE institutions (
  id                   uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  name                 text        NOT NULL CHECK (length(btrim(name)) > 0),

  -- BOT registration code, printed on every MSP2 form. Nullable because an
  -- institution can be onboarded before its code is issued, but reporting
  -- requires it — the compliance module refuses to generate without one.
  msp_code             text        UNIQUE CHECK (msp_code IS NULL OR length(btrim(msp_code)) > 0),

  status               text        NOT NULL DEFAULT 'active'
                                   CHECK (status IN ('active', 'suspended', 'closed')),

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE institutions IS 'Tenant root. Every other tenant-scoped table carries institution_id.';
COMMENT ON COLUMN institutions.msp_code IS 'Bank of Tanzania registration code; required before MSP2 reports can be generated.';

CREATE TRIGGER trg_institutions_updated_at
  BEFORE UPDATE ON institutions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE institutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE institutions FORCE ROW LEVEL SECURITY;

-- An institution sees only itself.
CREATE POLICY institutions_select ON institutions
  FOR SELECT TO mfi_app
  USING (id = current_institution_id());

CREATE POLICY institutions_update ON institutions
  FOR UPDATE TO mfi_app
  USING (id = current_institution_id())
  WITH CHECK (id = current_institution_id());

-- No INSERT or DELETE policy, deliberately.
--
-- Creating an institution is the signup path: it happens before any tenant
-- context exists, so it cannot be expressed as a tenant-scoped policy. It runs
-- as a privileged system operation instead. Deleting one is never an
-- application action — an institution with a loan book is retained, and its
-- status is set to 'closed'.
GRANT SELECT, UPDATE ON institutions TO mfi_app;

-- ---------------------------------------------------------------------------
-- branches
-- ---------------------------------------------------------------------------

-- Branches within an institution.
--
-- Not an optional feature. MSP2-10 reports the number of branches and the
-- number of employees per district, so an institution's branch structure is a
-- regulatory disclosure — see `02-BOT-REPORTING-SPEC.md` §8. The PRD had
-- multi-branch explicitly out of scope; the template overrides that.
CREATE TABLE branches (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id  uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  code            text        NOT NULL CHECK (length(btrim(code)) > 0),
  name            text        NOT NULL CHECK (length(btrim(name)) > 0),

  -- Exactly one head office per institution, enforced by a partial unique index below.
  is_head_office  boolean     NOT NULL DEFAULT false,

  status          text        NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'closed')),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT branches_code_unique_per_institution UNIQUE (institution_id, code)
);

COMMENT ON TABLE branches IS 'Branches within an institution. Required by MSP2-10, which reports branch and employee counts per district.';

-- One head office per institution. A partial unique index expresses this
-- without forbidding institutions that have not yet designated one.
CREATE UNIQUE INDEX branches_one_head_office_per_institution
  ON branches (institution_id)
  WHERE is_head_office;

-- Access path: every branch listing is scoped to an institution and filtered by status.
CREATE INDEX branches_institution_status_idx ON branches (institution_id, status);

CREATE TRIGGER trg_branches_updated_at
  BEFORE UPDATE ON branches
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE branches FORCE ROW LEVEL SECURITY;

-- Full CRUD within the tenant. `USING` governs which rows are visible to read,
-- update, and delete; `WITH CHECK` governs what may be written — without it, a
-- caller could insert a row belonging to another institution, or update one of
-- its own rows to point at a different institution.
CREATE POLICY branches_select ON branches
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY branches_insert ON branches
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY branches_update ON branches
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY branches_delete ON branches
  FOR DELETE TO mfi_app
  USING (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON branches TO mfi_app;
