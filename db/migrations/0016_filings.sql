-- What was filed, kept exactly as it was filed.
--
-- The Sno-addressed cell map that §16.2 item 10 calls for is deliberately not
-- here. It has one consumer — the exporter that writes BOT's workbook — and
-- that exporter is not built yet. A table nothing reads is the fault the
-- analysis records twice over: `audit_logs` and `bot_reports` were both schema
-- for capabilities that were designed and never built (R8, App Flow §4). The
-- map lands with the code that reads it, as the domain-event seam did.

-- ---------------------------------------------------------------------------
-- filed_returns
-- ---------------------------------------------------------------------------

-- What was filed, exactly as it was filed.
--
-- The compiled return is stored whole rather than recomputed on demand, and
-- that is the point. A return describes a quarter as it stood on a date; six
-- months later the loan book has moved, a mis-keyed payment has been reversed,
-- and recompiling would produce a different document from the one BOT holds.
-- An institution asked to explain a figure needs the document it sent, not this
-- system's current opinion of that quarter.
--
-- The previous system had no equivalent: reports were generated in the browser
-- and never retained, so nothing could be produced afterwards (analysis R10,
-- App Flow §4).
CREATE TABLE filed_returns (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  year           smallint    NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  quarter        smallint    NOT NULL CHECK (quarter BETWEEN 1 AND 4),

  -- The whole compiled return, in the wire shape the API serves. Money is held
  -- as strings inside it, for the same reason it travels as strings: a JSON
  -- number is a binary double, and a filing that cannot be reproduced to the
  -- cent is not a filing record.
  document       jsonb       NOT NULL,

  -- Which forms the document contains, so a listing can say what was filed
  -- without parsing the whole thing.
  form_codes     text[]      NOT NULL CHECK (array_length(form_codes, 1) > 0),

  -- Recorded at the moment of filing, because the validator's verdict is part
  -- of what was relied on. A return archived after a rule changed should still
  -- show the verdict it was filed under.
  finding_count  integer     NOT NULL DEFAULT 0 CHECK (finding_count >= 0),

  filed_by       uuid        NOT NULL,
  filed_at       timestamptz NOT NULL DEFAULT now(),

  -- Free text: BOT's acknowledgement reference, once the institution has one.
  submission_reference text  CHECK (submission_reference IS NULL
                                    OR length(btrim(submission_reference)) > 0),

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE filed_returns IS
  'Quarterly returns as filed, stored whole. Recompiling a past quarter would produce a different document from the one BOT holds.';

-- Access path: an institution's filings, newest first, and a lookup by quarter.
CREATE INDEX filed_returns_institution_filed_idx
  ON filed_returns (institution_id, filed_at DESC);
CREATE INDEX filed_returns_period_idx ON filed_returns (institution_id, year, quarter);

CREATE TRIGGER trg_filed_returns_updated_at
  BEFORE UPDATE ON filed_returns FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER trg_audit_filed_returns
  AFTER INSERT OR UPDATE OR DELETE ON filed_returns
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

ALTER TABLE filed_returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE filed_returns FORCE ROW LEVEL SECURITY;

CREATE POLICY filed_returns_select ON filed_returns
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());
CREATE POLICY filed_returns_insert ON filed_returns
  FOR INSERT TO mfi_app WITH CHECK (institution_id = current_institution_id());
-- The acknowledgement reference arrives after the filing, so the row is
-- updatable. Nothing else about it should be, and the audit trigger records
-- what was.
CREATE POLICY filed_returns_update ON filed_returns
  FOR UPDATE TO mfi_app USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE, and no privilege to grant one. A filing that can be removed is not
-- a record of what was filed.
GRANT SELECT, INSERT, UPDATE ON filed_returns TO mfi_app;

-- The document itself never changes.
--
-- Only the acknowledgement reference may be added afterwards. Without this an
-- UPDATE could rewrite the figures under a filing's own identifier, which is
-- precisely the property the table exists to provide.
CREATE OR REPLACE FUNCTION enforce_filed_return_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.document IS DISTINCT FROM OLD.document
     OR NEW.year IS DISTINCT FROM OLD.year
     OR NEW.quarter IS DISTINCT FROM OLD.quarter
     OR NEW.form_codes IS DISTINCT FROM OLD.form_codes
     OR NEW.finding_count IS DISTINCT FROM OLD.finding_count
     OR NEW.filed_by IS DISTINCT FROM OLD.filed_by
     OR NEW.filed_at IS DISTINCT FROM OLD.filed_at THEN
    RAISE EXCEPTION 'A filed return is a record of what was filed. Only the submission reference may be added afterwards.'
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION enforce_filed_return_immutable() FROM PUBLIC;

CREATE TRIGGER trg_filed_returns_immutable
  BEFORE UPDATE ON filed_returns FOR EACH ROW
  EXECUTE FUNCTION enforce_filed_return_immutable();
