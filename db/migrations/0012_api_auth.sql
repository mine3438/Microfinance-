-- Authentication lookups: the one narrow exemption row-level security needs.
--
-- Every authenticated request carries its institution in the access token, so
-- the tenant setting is established before any query runs. Four operations have
-- no institution yet, because *identifying* one is the operation: login,
-- refresh, invitation acceptance and password reset.
--
-- `mfi_app` is subject to row-level security, so an unscoped lookup returns
-- nothing — correctly, and uselessly. Asking the client which institution it is
-- authenticating against was rejected: it puts tenancy in the hands of the
-- caller, and an enumerable institution identifier on an unauthenticated
-- endpoint is a disclosure with no compensating benefit (01-ARCHITECTURE.md
-- §17.2).
--
-- So the exemption is a small number of named functions with fixed result
-- shapes, not a role that can read the tables. The pattern is the one stage 10
-- used for `mfi_classifier`.
--
-- Two functions, not four. Invitation acceptance and password reset land with
-- the features that use them; adding their lookups now would be schema for a
-- capability that does not exist, which is the fault this project records as R8.

-- ---------------------------------------------------------------------------
-- Authentication role
-- ---------------------------------------------------------------------------

-- Owns the lookup functions and nothing else.
--
-- NOBYPASSRLS deliberately, even though these functions exist precisely to see
-- past a policy. BYPASSRLS would exempt the role from every policy on every
-- table for all time; a policy naming the role exempts it from exactly the
-- tables written here, and adding a table later does not silently widen it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mfi_auth') THEN
    CREATE ROLE mfi_auth NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;

COMMENT ON ROLE mfi_auth IS
  'Owns the pre-tenant authentication lookups. Reads only the columns those lookups return.';

CREATE SCHEMA auth;

COMMENT ON SCHEMA auth IS
  'Pre-tenant authentication lookups. Every function here is SECURITY DEFINER and returns a fixed, minimal shape.';

GRANT USAGE ON SCHEMA auth TO mfi_app;
GRANT USAGE ON SCHEMA public TO mfi_auth;

-- ---------------------------------------------------------------------------
-- What mfi_auth may read
-- ---------------------------------------------------------------------------

-- Column-level grants, so the role cannot read a column no lookup returns.
-- `email` is included because the login lookup filters on it; `full_name` is
-- not, because the session profile is read later through the ordinary
-- tenant-scoped path once the institution is known.
GRANT SELECT (id, institution_id, email, password_hash, status) ON users TO mfi_auth;
GRANT SELECT (id, status) ON institutions TO mfi_auth;
GRANT SELECT (id, institution_id, user_id, family_id, token_hash, expires_at, used_at, revoked_at)
  ON refresh_tokens TO mfi_auth;

-- The tables are FORCE ROW LEVEL SECURITY, so a grant alone is not enough: even
-- an owner is filtered. Each policy is SELECT-only and names this role, so the
-- exemption cannot be used to write anything.
CREATE POLICY users_auth_lookup ON users
  FOR SELECT TO mfi_auth USING (true);

CREATE POLICY institutions_auth_lookup ON institutions
  FOR SELECT TO mfi_auth USING (true);

CREATE POLICY refresh_tokens_auth_lookup ON refresh_tokens
  FOR SELECT TO mfi_auth USING (true);

-- ---------------------------------------------------------------------------
-- auth.find_login_identity
-- ---------------------------------------------------------------------------

-- Resolve an email to the minimum a login attempt needs.
--
-- Deliberately not a "log the user in" function. It returns the hash to verify
-- against and the two statuses that gate the attempt, and stops. Everything
-- else — the user's name, branch, roles and permissions — is read afterwards
-- through the ordinary tenant-scoped path, once the institution is known and
-- the password has been verified. The exemption therefore covers identification
-- only, never the session payload.
--
-- It does not decide anything either. An unknown email returns no row and a
-- suspended user returns a row; distinguishing those two to the caller is the
-- use case's job, and its answer is the same message and the same elapsed time
-- for both, so that this endpoint cannot be used to enumerate accounts.
--
-- The filter matches `users_email_unique`, which indexes `lower(email)`, so the
-- lookup is an index probe and email case is irrelevant.
CREATE FUNCTION auth.find_login_identity(p_email text)
RETURNS TABLE (
  user_id            uuid,
  institution_id     uuid,
  password_hash      text,
  user_status        text,
  institution_status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT u.id, u.institution_id, u.password_hash, u.status, i.status
    FROM users u
    JOIN institutions i ON i.id = u.institution_id
   WHERE lower(u.email) = lower(btrim(p_email));
$$;

ALTER FUNCTION auth.find_login_identity(text) OWNER TO mfi_auth;

COMMENT ON FUNCTION auth.find_login_identity(text) IS
  'Pre-tenant login lookup. Returns the credential and the two statuses gating the attempt, nothing more.';

-- ---------------------------------------------------------------------------
-- auth.find_refresh_token
-- ---------------------------------------------------------------------------

-- Resolve a refresh token hash to the session it belongs to.
--
-- Returns the row whether or not it is still usable — `used_at`, `revoked_at`
-- and `expires_at` come back as data rather than as a filter. That is the
-- point: a token that has already been used is the signal that a token was
-- captured, because the legitimate holder rotated past it. Filtering consumed
-- tokens out here would discard exactly the evidence reuse detection runs on,
-- leaving a stolen token indistinguishable from an expired one.
--
-- Revoking the family in response happens through `mfi_app` inside a tenant
-- transaction, since by then the institution is known. This role holds no
-- UPDATE privilege anywhere and cannot perform it.
--
-- The lookup is by hash, never by identifier: the token itself is never stored,
-- so a database disclosure yields no usable credential.
CREATE FUNCTION auth.find_refresh_token(p_token_hash text)
RETURNS TABLE (
  token_id           uuid,
  institution_id     uuid,
  user_id            uuid,
  family_id          uuid,
  expires_at         timestamptz,
  used_at            timestamptz,
  revoked_at         timestamptz,
  user_status        text,
  institution_status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT rt.id, rt.institution_id, rt.user_id, rt.family_id,
         rt.expires_at, rt.used_at, rt.revoked_at,
         u.status, i.status
    FROM refresh_tokens rt
    JOIN users u        ON u.id = rt.user_id
    JOIN institutions i ON i.id = rt.institution_id
   WHERE rt.token_hash = p_token_hash;
$$;

ALTER FUNCTION auth.find_refresh_token(text) OWNER TO mfi_auth;

COMMENT ON FUNCTION auth.find_refresh_token(text) IS
  'Pre-tenant refresh lookup. Returns consumed and revoked tokens too — that is what reuse detection reads.';

-- ---------------------------------------------------------------------------
-- Execution privileges
-- ---------------------------------------------------------------------------

-- Postgres grants EXECUTE to PUBLIC on a new function by default. On a
-- SECURITY DEFINER function that reads password hashes, inheriting that default
-- means every role in the cluster — including any added later for an unrelated
-- purpose — can call it. Revoked first, then granted to the one role that needs
-- it, so the privilege is stated rather than assumed.
REVOKE ALL ON FUNCTION auth.find_login_identity(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.find_refresh_token(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth.find_login_identity(text) TO mfi_app;
GRANT EXECUTE ON FUNCTION auth.find_refresh_token(text) TO mfi_app;

-- The same default applied to the SECURITY DEFINER functions written in earlier
-- migrations. None of them is currently reachable by a role that should not
-- have it — `mfi_app` is granted each one explicitly — but the same reasoning
-- holds: a role added later must not inherit these by being part of PUBLIC.
REVOKE ALL ON FUNCTION allocate_entity_code(uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION user_permissions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION update_overdue_classifications(uuid, date) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION allocate_entity_code(uuid, text, text, integer) TO mfi_app;
GRANT EXECUTE ON FUNCTION user_permissions(uuid) TO mfi_app;
GRANT EXECUTE ON FUNCTION update_overdue_classifications(uuid, date) TO mfi_app;

-- The trigger functions too, and nothing is granted back.
--
-- A trigger function cannot be invoked directly — Postgres refuses to call one
-- outside trigger context — so the exposure was theoretical. But EXECUTE on
-- these is checked when a trigger is *created*, not when it fires, so the
-- privilege's only real effect would be to let a role that could create a table
-- attach the audit writer's authority to it. Verified against the running
-- schema before revoking: audit rows are still written after the revoke, so
-- firing genuinely does not depend on the caller holding EXECUTE.
REVOKE ALL ON FUNCTION audit_row_change() FROM PUBLIC;
REVOKE ALL ON FUNCTION emit_loan_domain_event() FROM PUBLIC;
REVOKE ALL ON FUNCTION emit_payment_domain_event() FROM PUBLIC;
