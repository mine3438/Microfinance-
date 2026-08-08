-- Overdue classification, provisioning, and the freshness record that makes a
-- stale classification impossible to miss.
--
-- The worst defect in the system being replaced lives here. Its classification
-- job was scheduled by a `pg_cron` line left commented out in schema.sql, so
-- unless somebody noticed and enabled the extension by hand, no loan's
-- classification ever changed after creation — a loan forty days overdue kept
-- reporting "Current" to the dashboard *and to the Bank of Tanzania*
-- (00-PROJECT-ANALYSIS.md R5).
--
-- Nothing crashed. No screen was empty. The numbers simply were not true, which
-- is what made it dangerous. Two changes address it: the job records when it
-- last ran, and anything derived from classification refuses to be filed when
-- that record is stale.

-- ---------------------------------------------------------------------------
-- Classification role
-- ---------------------------------------------------------------------------

-- The classification job owns its own role rather than borrowing the audit
-- writer's.
--
-- The audit writer exists to append audit rows and nothing else; giving it
-- UPDATE on the loan book so a scheduled job could reuse it would widen a role
-- whose whole value is how narrow it is. This role holds exactly what
-- reclassification needs: read the loan book and BOT's bands, write three
-- columns and the health record.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfi_classifier') THEN
    CREATE ROLE mfi_classifier NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

COMMENT ON ROLE mfi_classifier IS
  'Owns the overdue classification job. Reads the loan book, writes classification columns only.';

GRANT USAGE ON SCHEMA public TO mfi_classifier;
GRANT USAGE ON SCHEMA reference TO mfi_classifier;
GRANT SELECT ON ALL TABLES IN SCHEMA reference TO mfi_classifier;
GRANT SELECT ON loans, loan_products, repayment_schedules TO mfi_classifier;
GRANT UPDATE ON loans TO mfi_classifier;
GRANT EXECUTE ON FUNCTION current_user_id() TO mfi_classifier;

ALTER TABLE loans
  ADD COLUMN days_overdue          integer CHECK (days_overdue IS NULL OR days_overdue >= 0),
  ADD COLUMN overdue_class         text
    CHECK (overdue_class IS NULL
           OR overdue_class IN ('current', 'esm', 'substandard', 'doubtful', 'loss')),
  -- NULL means "no band covers this loan", not "not yet computed" — the two are
  -- distinguished by classified_at.
  ADD COLUMN classified_at         timestamptz;

COMMENT ON COLUMN loans.overdue_class IS
  'BOT MSP2-03 classification. NULL after a run means no provisioning band covers the loan — see §11.5.';
COMMENT ON COLUMN loans.classified_at IS
  'When this loan was last classified. NULL means never, which is not the same as unclassifiable.';

CREATE INDEX loans_overdue_class_idx ON loans (institution_id, overdue_class)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- system_health
-- ---------------------------------------------------------------------------

-- One row per institution, recording when derived figures were last computed.
--
-- The point is that absence is meaningful. An institution with no row has never
-- had classifications run, and the readiness check treats that as a refusal
-- rather than as a fresh state.
CREATE TABLE system_health (
  institution_id             uuid        PRIMARY KEY REFERENCES institutions (id) ON DELETE CASCADE,
  classifications_updated_at timestamptz,
  -- Loans that fall outside every provisioning band. Non-zero blocks filing:
  -- MSP2-03 has no unclassified column to put them in.
  unclassifiable_loan_count  integer     NOT NULL DEFAULT 0 CHECK (unclassifiable_loan_count >= 0),
  updated_at                 timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE system_health IS
  'When derived figures were last computed, per institution. Absence means never — treated as a refusal, not as fresh.';

CREATE TRIGGER trg_system_health_updated_at
  BEFORE UPDATE ON system_health FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE system_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_health FORCE ROW LEVEL SECURITY;

CREATE POLICY system_health_select ON system_health
  FOR SELECT TO mfi_app USING (institution_id = current_institution_id());

-- Written only by the classification job, which runs as a definer.
GRANT SELECT ON system_health TO mfi_app;
-- SELECT as well as INSERT and UPDATE: the job upserts, and ON CONFLICT DO
-- UPDATE has to see the conflicting row to update it.
GRANT SELECT, INSERT, UPDATE ON system_health TO mfi_classifier;

CREATE POLICY system_health_read ON system_health
  FOR SELECT TO mfi_classifier USING (true);
CREATE POLICY system_health_write ON system_health
  FOR INSERT TO mfi_classifier WITH CHECK (true);
CREATE POLICY system_health_amend ON system_health
  FOR UPDATE TO mfi_classifier USING (true) WITH CHECK (true);

-- The job sweeps every institution in turn, so its policies are not tenant
-- scoped. It reaches the loan book only through the function below, and
-- `mfi_app` cannot assume this role.
CREATE POLICY loans_classify_select ON loans
  FOR SELECT TO mfi_classifier USING (true);
CREATE POLICY loans_classify_update ON loans
  FOR UPDATE TO mfi_classifier USING (true) WITH CHECK (true);
CREATE POLICY loan_products_classify_select ON loan_products
  FOR SELECT TO mfi_classifier USING (true);
CREATE POLICY repayment_schedules_classify_select ON repayment_schedules
  FOR SELECT TO mfi_classifier USING (true);

-- ---------------------------------------------------------------------------
-- Days overdue
-- ---------------------------------------------------------------------------

-- Days since the earliest unpaid instalment fell due.
--
-- Measured from the *oldest* arrear, not the most recent. A borrower who misses
-- January and pays February is still three months late on January, and
-- classifying on the newest missed instalment would quietly reset the clock
-- every time a partial payment arrived.
CREATE OR REPLACE FUNCTION loan_days_overdue(p_loan_id uuid, p_as_at date DEFAULT CURRENT_DATE)
RETURNS integer
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(MAX(GREATEST(p_as_at - due_date, 0)), 0)
    FROM repayment_schedules
   WHERE loan_id = p_loan_id
     AND NOT is_paid
     AND due_date < p_as_at;
$$;

COMMENT ON FUNCTION loan_days_overdue(uuid, date) IS
  'Days since the earliest unpaid instalment fell due. Zero when nothing is in arrears.';

GRANT EXECUTE ON FUNCTION loan_days_overdue(uuid, date) TO mfi_app, mfi_classifier;

-- ---------------------------------------------------------------------------
-- The classification job
-- ---------------------------------------------------------------------------

-- Recompute every active loan's classification for one institution.
--
-- Runs as a definer so it can write system_health, and returns the number of
-- loans it could not classify. That count is not incidental: BOT's housing
-- microfinance schedule begins at 91 days and defines nothing below it, so a
-- housing loan less overdue than that has no classification BOT has issued
-- (02-BOT-REPORTING-SPEC.md §11.5). Such loans are left NULL and counted,
-- rather than being defaulted into `current` — which would understate
-- provisions and file a wrong MSP2-03.
CREATE OR REPLACE FUNCTION update_overdue_classifications(
  p_institution_id uuid,
  p_as_at          date DEFAULT CURRENT_DATE
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, reference, pg_temp
AS $$
DECLARE
  v_unclassifiable integer;
BEGIN
  IF p_institution_id IS NULL THEN
    RAISE EXCEPTION 'update_overdue_classifications: institution_id is required'
      USING ERRCODE = 'null_value_not_allowed';
  END IF;

  WITH computed AS (
    SELECT l.id,
           loan_days_overdue(l.id, p_as_at) AS days_overdue,
           lt.provisioning_schedule
      FROM loans l
      JOIN loan_products lp ON lp.id = l.product_id
      JOIN reference.loan_types lt ON lt.code = lp.bot_loan_type
     WHERE l.institution_id = p_institution_id
       AND l.status = 'active'
  )
  UPDATE loans l
     SET days_overdue  = c.days_overdue,
         overdue_class = b.classification,
         classified_at = now()
    FROM computed c
    LEFT JOIN reference.provisioning_bands b
           ON b.schedule_code = c.provisioning_schedule
          AND c.days_overdue >= b.min_days_overdue
          AND (b.max_days_overdue IS NULL OR c.days_overdue <= b.max_days_overdue)
   WHERE l.id = c.id;

  SELECT COUNT(*) INTO v_unclassifiable
    FROM loans
   WHERE institution_id = p_institution_id
     AND status = 'active'
     AND classified_at IS NOT NULL
     AND overdue_class IS NULL;

  INSERT INTO system_health (institution_id, classifications_updated_at, unclassifiable_loan_count)
       VALUES (p_institution_id, now(), v_unclassifiable)
  ON CONFLICT (institution_id)
    DO UPDATE SET classifications_updated_at = now(),
                  unclassifiable_loan_count  = EXCLUDED.unclassifiable_loan_count;

  RETURN v_unclassifiable;
END;
$$;

ALTER FUNCTION update_overdue_classifications(uuid, date) OWNER TO mfi_classifier;

COMMENT ON FUNCTION update_overdue_classifications(uuid, date) IS
  'Reclassifies active loans and stamps system_health. Returns the count that no band covers.';

GRANT EXECUTE ON FUNCTION update_overdue_classifications(uuid, date) TO mfi_app;

-- Whether an institution's derived figures may be filed.
--
-- Mirrors assessReportingReadiness in @mfi/domain. Both exist: the domain
-- produces the list of problems an operator has to fix, this refuses at the
-- layer no report generator can go around.
CREATE OR REPLACE FUNCTION classifications_are_fresh(
  p_institution_id uuid,
  p_max_age_hours  integer DEFAULT 24
) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM system_health
     WHERE institution_id = p_institution_id
       AND classifications_updated_at IS NOT NULL
       AND classifications_updated_at > now() - make_interval(hours => p_max_age_hours)
       AND unclassifiable_loan_count = 0
  );
$$;

GRANT EXECUTE ON FUNCTION classifications_are_fresh(uuid, integer) TO mfi_app;
