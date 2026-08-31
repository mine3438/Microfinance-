-- The classification job's view of which institutions to classify.
--
-- Migration 0011 built the job itself — `update_overdue_classifications()`,
-- which recomputes a loan book, stamps `system_health` and returns the count no
-- band covers. What it never had was a caller, which is the same shape of
-- defect as the system being replaced: there, the job existed and the `pg_cron`
-- line that ran it was commented out (00-PROJECT-ANALYSIS.md R5).
--
-- A scheduled run has no institution to scope itself to. Covering every
-- institution *is* the job, so it has to enumerate them — and that is the one
-- thing row-level security is built to prevent.
--
-- Reaching for a policy that lets `mfi_app` read every institution would solve
-- it by widening the tenancy boundary for every request in the system, to serve
-- one unattended job. Instead this mirrors what 0011 already does for the
-- classification itself: a SECURITY DEFINER function owned by the narrow
-- classifier role, executable by the application, returning identifiers and
-- nothing else.
--
-- Without it the job would have worked in development and CI — where the
-- connection is a superuser and RLS does not apply — and silently classified
-- nothing in production, where the application connects as `mfi_app`. A job
-- that reports success having done nothing is the exact failure this whole
-- subsystem exists to make impossible.

GRANT SELECT ON institutions TO mfi_classifier;

CREATE POLICY institutions_classifier_enumerate ON institutions
  FOR SELECT TO mfi_classifier
  USING (true);

COMMENT ON POLICY institutions_classifier_enumerate ON institutions IS
  'The classification job must see every institution; covering all of them is what the job is.';

-- Institutions whose loan book should be reclassified.
--
-- Closed institutions are excluded: a closed institution has no ongoing book,
-- and stamping its health record would make a dormant tenant look freshly
-- classified. Suspended ones are included — a suspended provider still holds
-- loans and still owes BOT a return, so its classification must not go stale.
CREATE OR REPLACE FUNCTION institution_ids_for_classification()
RETURNS TABLE (institution_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT id FROM institutions WHERE status <> 'closed' ORDER BY id;
$$;

ALTER FUNCTION institution_ids_for_classification() OWNER TO mfi_classifier;

-- Postgres grants EXECUTE to PUBLIC on every new function, so a SECURITY
-- DEFINER function that says nothing about privileges has handed the
-- classifier's cross-tenant sight to every role in the cluster — including any
-- added later for an unrelated purpose. The grant is the absence of a line
-- rather than the presence of one, which is why `schema-invariants.test.ts`
-- checks for it; it failed on the commit that added this function.
REVOKE ALL ON FUNCTION institution_ids_for_classification() FROM PUBLIC;

COMMENT ON FUNCTION institution_ids_for_classification() IS
  'Institutions the classification job covers. SECURITY DEFINER so the job can enumerate without widening mfi_app.';

GRANT EXECUTE ON FUNCTION institution_ids_for_classification() TO mfi_app;
