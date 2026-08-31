-- Human-readable entity codes: `MFI-2026-001`, `LN-2026-001`, `BR-2026-001`.
--
-- The system this replaces derived the next number by parsing the maximum
-- existing suffix (`SPLIT_PART` over a `MAX(...)`) inside a BEFORE INSERT
-- trigger. Two concurrent inserts in the same institution and year both read
-- the same maximum and both compute the same next value — the analysis records
-- this as R7. A unique constraint turns that into a user-facing error rather
-- than corruption, but it is still an error nobody can act on, and it appears
-- exactly when the institution is busiest.
--
-- Here the counter is a row, and allocating a number locks it. Concurrency
-- serialises instead of colliding.

CREATE TABLE code_sequences (
  institution_id uuid     NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,

  -- Which code series: 'client', 'loan', 'branch', …
  entity         text     NOT NULL CHECK (length(btrim(entity)) > 0),

  -- Codes restart each calendar year, which is what makes them readable.
  year           smallint NOT NULL CHECK (year BETWEEN 2000 AND 9999),

  next_value     integer  NOT NULL DEFAULT 1 CHECK (next_value > 0),

  PRIMARY KEY (institution_id, entity, year)
);

COMMENT ON TABLE code_sequences IS
  'Per-institution, per-entity, per-year counters for human-readable codes. Allocation locks the row, so concurrent inserts cannot collide.';

ALTER TABLE code_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_sequences FORCE ROW LEVEL SECURITY;

-- Readable within the tenant for diagnostics. Never written directly by the
-- application: allocation goes through allocate_entity_code(), which is
-- SECURITY DEFINER, so there is one code path and it is the correct one.
CREATE POLICY code_sequences_select ON code_sequences
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

GRANT SELECT ON code_sequences TO mfi_app;

-- Allocate the next code in a series.
--
-- The upsert is the whole mechanism: `ON CONFLICT DO UPDATE` takes a row lock,
-- so a second transaction allocating the same series blocks until the first
-- commits and then reads the incremented value. No gap, no duplicate, no
-- retry loop.
--
-- Numbers are consumed on allocation, so a rolled-back transaction leaves a
-- gap in the sequence. That is the correct trade: gaps are cosmetic, whereas
-- reusing a code that appeared on a printed loan agreement is not.
--
-- SECURITY DEFINER because `mfi_app` deliberately holds no INSERT or UPDATE
-- privilege on the table — allocation is only reachable through this function.
-- `search_path` is pinned to defeat the classic SECURITY DEFINER attack, where
-- a caller puts a malicious `code_sequences` earlier on their own search path.
CREATE OR REPLACE FUNCTION allocate_entity_code(
  p_institution_id uuid,
  p_entity         text,
  p_prefix         text,
  p_year           integer DEFAULT extract(year FROM now())::integer
) RETURNS text
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_next integer;
BEGIN
  IF p_institution_id IS NULL THEN
    RAISE EXCEPTION 'allocate_entity_code: institution_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  INSERT INTO code_sequences (institution_id, entity, year, next_value)
       VALUES (p_institution_id, p_entity, p_year, 1)
  ON CONFLICT (institution_id, entity, year)
    DO UPDATE SET next_value = code_sequences.next_value + 1
    RETURNING next_value INTO v_next;

  -- Three digits is the readable case; longer numbers simply widen rather than
  -- wrap, so an institution issuing more than 999 loans in a year still gets
  -- correct, unique codes.
  RETURN p_prefix || '-' || p_year::text || '-' || lpad(v_next::text, 3, '0');
END;
$$;

COMMENT ON FUNCTION allocate_entity_code(uuid, text, text, integer) IS
  'Allocates the next human-readable code for an institution/entity/year. Row-locked, so concurrent callers serialise.';

-- Callable by the application; the function body holds the write privilege.
GRANT EXECUTE ON FUNCTION allocate_entity_code(uuid, text, text, integer) TO mfi_app;
