-- Audit logging, attached at the database rather than left to application code.
--
-- The previous system had an `audit_logs` table with row-level security
-- policies and no trigger anywhere writing to it. The analysis records it as
-- R8: "currently decorative", empty in every deployment. That is the predictable
-- end state of an audit trail that depends on each developer remembering to
-- call it — and an institution under BOT supervision is expected to show who
-- changed what and when.
--
-- Here one generic trigger function is attached to every business table, and a
-- test reads the catalogue to confirm none was missed. A write path added in
-- six months is audited whether or not anyone remembers.

-- ---------------------------------------------------------------------------
-- Writer role
-- ---------------------------------------------------------------------------

-- The audit trigger runs as this role, not as the application.
--
-- `mfi_app` is granted SELECT on the audit log and nothing else, so the
-- application cannot write, amend, or remove an entry even in principle. The
-- trigger reaches the table through a SECURITY DEFINER function owned by this
-- role instead — the only INSERT path there is.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfi_audit_writer') THEN
    CREATE ROLE mfi_audit_writer NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

COMMENT ON ROLE mfi_audit_writer IS
  'Owns the audit trigger function. The only role permitted to insert into audit_logs.';

GRANT USAGE ON SCHEMA public TO mfi_audit_writer;

-- ---------------------------------------------------------------------------
-- audit_logs
-- ---------------------------------------------------------------------------

CREATE TABLE audit_logs (
  id              uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id  uuid        NOT NULL,

  table_name      text        NOT NULL,
  row_id          uuid,
  operation       text        NOT NULL CHECK (operation IN ('INSERT', 'UPDATE', 'DELETE')),

  -- The acting user, from app.user_id. NULL for work with no human actor: a
  -- migration, a scheduled classification run, or signup, which necessarily
  -- happens before the first user of an institution exists.
  actor_user_id   uuid,

  changed_at      timestamptz NOT NULL DEFAULT now(),

  -- Row state either side of the change, with secrets removed. NULL on the side
  -- that does not apply: no before on an insert, no after on a delete.
  before_data     jsonb,
  after_data      jsonb,

  -- Columns whose value actually changed. Lets a reviewer see what happened
  -- without diffing two JSON documents by eye.
  changed_columns text[]
);

COMMENT ON TABLE audit_logs IS
  'Append-only record of every change to a business table. Written exclusively by the audit trigger.';
COMMENT ON COLUMN audit_logs.actor_user_id IS
  'From app.user_id. NULL where no user initiated the change.';

-- Access paths: "what happened in this institution recently" and "what happened
-- to this row".
CREATE INDEX audit_logs_institution_changed_idx ON audit_logs (institution_id, changed_at DESC);
CREATE INDEX audit_logs_row_idx ON audit_logs (table_name, row_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_user_id) WHERE actor_user_id IS NOT NULL;

ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

-- Readable within the tenant, and only by someone holding audit.read. An audit
-- trail that every user can browse leaks the institution's internal activity to
-- anyone with an account.
CREATE POLICY audit_logs_select ON audit_logs
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id() AND has_permission('audit.read'));

-- The single write path. Scoped to the writer role, so it grants the
-- application nothing: policies permit, they do not grant, and `mfi_app` holds
-- no INSERT privilege here at all.
CREATE POLICY audit_logs_insert ON audit_logs
  FOR INSERT TO mfi_audit_writer
  WITH CHECK (true);

-- SELECT only. No UPDATE or DELETE policy exists for any role, and none is
-- granted: an audit entry that can be amended is not evidence.
GRANT SELECT ON audit_logs TO mfi_app;
GRANT INSERT ON audit_logs TO mfi_audit_writer;

-- ---------------------------------------------------------------------------
-- Redaction
-- ---------------------------------------------------------------------------

-- Columns never copied into the audit log.
--
-- An audit trail holding password hashes and session token hashes is a second
-- credential store, with a longer retention period and a wider read audience
-- than the first. Capturing them would make the audit log more dangerous than
-- the table it describes.
CREATE OR REPLACE FUNCTION audit_redact(payload jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$
  SELECT payload - 'password_hash' - 'token_hash';
$$;

COMMENT ON FUNCTION audit_redact(jsonb) IS
  'Strips secret-bearing columns before a row is written to the audit log.';

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------

-- Records one row per change.
--
-- Generic over any table carrying `institution_id`, plus `institutions` itself,
-- whose own id is the tenant key. Attached AFTER the fact so it observes the
-- committed shape of the row, including anything other triggers changed.
CREATE OR REPLACE FUNCTION audit_row_change() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_before          jsonb;
  v_after           jsonb;
  v_subject         jsonb;
  v_institution_id  uuid;
  v_row_id          uuid;
  v_changed         text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_before := audit_redact(to_jsonb(OLD));
    v_after  := NULL;
    v_subject := to_jsonb(OLD);
  ELSIF TG_OP = 'INSERT' THEN
    v_before := NULL;
    v_after  := audit_redact(to_jsonb(NEW));
    v_subject := to_jsonb(NEW);
  ELSE
    v_before := audit_redact(to_jsonb(OLD));
    v_after  := audit_redact(to_jsonb(NEW));
    v_subject := to_jsonb(NEW);

    -- Only the keys whose value actually moved. An UPDATE that sets a column to
    -- the value it already held is not a change worth reporting as one.
    SELECT array_agg(key ORDER BY key) INTO v_changed
      FROM jsonb_each(v_after) AS after_pairs(key, value)
     WHERE value IS DISTINCT FROM v_before -> key;
  END IF;

  -- `institutions` is the tenant root, so its own id is the tenant key;
  -- everything else carries institution_id.
  IF TG_TABLE_NAME = 'institutions' THEN
    v_institution_id := (v_subject ->> 'id')::uuid;
  ELSE
    v_institution_id := (v_subject ->> 'institution_id')::uuid;
  END IF;

  -- Composite-keyed tables have no single row id; the payload still identifies them.
  v_row_id := NULLIF(v_subject ->> 'id', '')::uuid;

  INSERT INTO audit_logs (
    institution_id, table_name, row_id, operation, actor_user_id,
    before_data, after_data, changed_columns
  ) VALUES (
    v_institution_id, TG_TABLE_NAME, v_row_id, TG_OP, current_user_id(),
    v_before, v_after, v_changed
  );

  RETURN NULL;   -- AFTER trigger: the return value is discarded.
END;
$$;

ALTER FUNCTION audit_row_change() OWNER TO mfi_audit_writer;

COMMENT ON FUNCTION audit_row_change() IS
  'AFTER INSERT/UPDATE/DELETE trigger. Writes one redacted audit entry per row change.';

-- The writer needs to reach the function's dependencies under its own privileges.
GRANT EXECUTE ON FUNCTION audit_redact(jsonb) TO mfi_audit_writer;
GRANT EXECUTE ON FUNCTION current_user_id() TO mfi_audit_writer;

-- ---------------------------------------------------------------------------
-- Attachment
-- ---------------------------------------------------------------------------

-- Every business table, with no exception that is not written down.
--
-- Deliberately excluded, and asserted as excluded by the test suite:
--
--   refresh_tokens, user_tokens — rotated on every request and every password
--     reset. Auditing them would bury genuine business changes under session
--     churn, and they carry no business meaning: who logged in is a security
--     concern served by the login record, not by a change log.
--   code_sequences — an implementation detail of code allocation. The audit
--     entry for the loan says everything the counter increment would.
--   audit_logs — auditing the audit log is circular.
CREATE TRIGGER trg_audit_institutions
  AFTER INSERT OR UPDATE OR DELETE ON institutions
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_branches
  AFTER INSERT OR UPDATE OR DELETE ON branches
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_users
  AFTER INSERT OR UPDATE OR DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_user_roles
  AFTER INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();

CREATE TRIGGER trg_audit_invitations
  AFTER INSERT OR UPDATE OR DELETE ON invitations
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
