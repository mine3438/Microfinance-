-- The pre-tenant lookup invitation acceptance needs.
--
-- Migration 0012 built two of the four lookups row-level security requires and
-- named the other two: "Invitation acceptance and password reset land with the
-- features that use them; adding their lookups now would be schema for a
-- capability that does not exist, which is the fault this project records as
-- R8." Invitation acceptance is that feature, so this is its lookup.
--
-- Someone accepting an invitation holds a token and nothing else. They have no
-- session, no institution, and — until they accept — no password with which to
-- get one. `mfi_app` is subject to row-level security, so reading `invitations`
-- without a tenant returns nothing, correctly and uselessly.
--
-- Asking the browser which institution it is accepting into was rejected for
-- the same reason 0012 rejected it for login: it puts tenancy in the hands of
-- the caller. The token already names exactly one invitation, and that
-- invitation already names its institution.

-- ---------------------------------------------------------------------------
-- What mfi_auth may read
-- ---------------------------------------------------------------------------

-- Column-level, so the role cannot read a column the lookup does not return.
-- `email`, `full_name` and `role_code` are deliberately absent: the acceptance
-- screen shows them, but it shows them through the ordinary tenant-scoped path
-- once the institution is known, which is the same division login uses for the
-- session profile.
GRANT SELECT (id, institution_id, token_hash, expires_at, accepted_at, revoked_at)
  ON invitations TO mfi_auth;

-- The table is FORCE ROW LEVEL SECURITY, so the grant alone is not enough.
-- SELECT-only and named to this role, so the exemption cannot write anything —
-- consuming the invitation happens later, under the tenant, as `mfi_app`.
CREATE POLICY invitations_auth_lookup ON invitations
  FOR SELECT TO mfi_auth USING (true);

COMMENT ON POLICY invitations_auth_lookup ON invitations IS
  'Pre-tenant read for invitation acceptance. SELECT only; the invitation is consumed under the tenant.';

-- ---------------------------------------------------------------------------
-- auth.find_invitation
-- ---------------------------------------------------------------------------

-- Resolve a token hash to the institution it belongs to, and the three facts
-- that gate the attempt.
--
-- Deliberately not an "accept this invitation" function. It decides nothing: an
-- expired invitation returns a row, a revoked one returns a row, and an already
-- accepted one returns a row. Which of those the caller is told, and in what
-- words, is the use case's job — and unlike login, telling the truth here
-- carries no enumeration risk, because reaching this function at all requires
-- possession of a 256-bit token.
--
-- The lookup is by hash, never by the token itself. The token exists in
-- whatever was sent to the invitee and nowhere else, so a disclosure of this
-- database yields nothing that can be redeemed.
--
-- The filter matches `invitations.token_hash`, which is UNIQUE, so this is an
-- index probe returning at most one row.
CREATE FUNCTION auth.find_invitation(p_token_hash text)
RETURNS TABLE (
  invitation_id      uuid,
  institution_id     uuid,
  expires_at         timestamptz,
  accepted_at        timestamptz,
  revoked_at         timestamptz,
  institution_status text
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT v.id, v.institution_id, v.expires_at, v.accepted_at, v.revoked_at, i.status
    FROM invitations v
    JOIN institutions i ON i.id = v.institution_id
   WHERE v.token_hash = p_token_hash;
$$;

ALTER FUNCTION auth.find_invitation(text) OWNER TO mfi_auth;

-- Postgres grants EXECUTE to PUBLIC by default, which on a SECURITY DEFINER
-- function means every role including ones that should never see past a policy.
REVOKE ALL ON FUNCTION auth.find_invitation(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth.find_invitation(text) TO mfi_app;

COMMENT ON FUNCTION auth.find_invitation(text) IS
  'Pre-tenant invitation lookup. Returns the institution and the three timestamps gating acceptance, nothing more.';
