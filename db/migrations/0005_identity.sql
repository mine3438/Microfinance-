-- Identity: users, the permission model, invitations, and session tokens.
--
-- Replaces the two hardcoded roles (`admin`, `officer`) the previous system
-- carried. That model cannot express an approver who is not the maker, which
-- maker-checker requires, nor a manager scoped to one branch, which MSP2-10's
-- per-district reporting implies. PRD §7 raised the branch-manager question and
-- left it open; the reporting requirement settles it.
--
-- It also closes the gap recorded in PRD §4.2 and SCHEMA §2: there was no
-- invitation flow at all, so an institution could never have a second user and
-- the loan-officer persona the whole product is designed around could not exist.

-- ---------------------------------------------------------------------------
-- Current user resolution
-- ---------------------------------------------------------------------------

-- The user acting in the current transaction.
--
-- Companion to current_institution_id(). Set from the authenticated principal
-- alongside the tenant, and NULL when absent — so a policy that depends on it
-- denies rather than permits.
CREATE OR REPLACE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_user_id() IS
  'Acting user for the current transaction, from app.user_id. NULL when unset.';

GRANT EXECUTE ON FUNCTION current_user_id() TO mfi_app;

-- ---------------------------------------------------------------------------
-- Permission catalogue
-- ---------------------------------------------------------------------------

-- Permissions and roles are global, not per-institution: they define what the
-- software can do, which is the same everywhere. Only the *assignment* of users
-- to roles is tenant data. They live in `reference` for the same reason BOT's
-- taxonomies do — no institution owns them, and they change by migration.
CREATE TABLE reference.permissions (
  code        text PRIMARY KEY,
  description text NOT NULL
);

COMMENT ON TABLE reference.permissions IS
  'What the application can do. Roles are named bundles of these.';

INSERT INTO reference.permissions (code, description) VALUES
  ('client.read',       'View clients and their details'),
  ('client.create',     'Register new clients'),
  ('client.update',     'Amend client records'),
  ('client.deactivate', 'Deactivate a client'),
  ('branch.read',       'View branches'),
  ('branch.manage',     'Create and amend branches'),
  ('user.read',         'View staff accounts'),
  ('user.invite',       'Invite staff to the institution'),
  ('user.manage',       'Amend, suspend and assign roles to staff'),
  ('loan.read',         'View loans and repayment schedules'),
  ('loan.create',       'Create loan applications'),
  ('loan.approve',      'Approve or reject loan applications'),
  ('loan.disburse',     'Disburse an approved loan'),
  ('loan.write_off',    'Write off a loan'),
  ('payment.read',      'View payments'),
  ('payment.create',    'Record payments'),
  ('payment.reverse',   'Reverse a recorded payment'),
  ('savings.read',      'View savings accounts'),
  ('savings.manage',    'Operate savings accounts'),
  ('share.read',        'View share accounts'),
  ('share.manage',      'Operate share accounts'),
  ('expense.read',      'View expense and income entries'),
  ('expense.manage',    'Record expense and income entries'),
  ('complaint.read',    'View complaints'),
  ('complaint.manage',  'Log and resolve complaints'),
  ('report.read',       'View compiled BOT reports'),
  ('report.generate',   'Compile and export BOT reports'),
  ('settings.manage',   'Amend institution settings'),
  ('audit.read',        'Read the audit log');

CREATE TABLE reference.roles (
  code        text     PRIMARY KEY,
  name        text     NOT NULL,
  -- Whether the role's authority covers the whole institution or one branch.
  scope       text     NOT NULL CHECK (scope IN ('institution', 'branch')),
  description text     NOT NULL,
  sort_order  smallint NOT NULL
);

INSERT INTO reference.roles (code, name, scope, description, sort_order) VALUES
  ('institution_admin', 'Institution Administrator', 'institution',
   'Full authority across the institution, including settings and staff.', 1),
  ('branch_manager', 'Branch Manager', 'branch',
   'Runs one branch and approves loans within it. Answers the third-role question left open in PRD §7.', 2),
  ('loan_officer', 'Loan Officer', 'branch',
   'Registers clients, prepares loans and records payments. Cannot approve or reverse.', 3),
  ('accountant', 'Accountant', 'institution',
   'Maintains expense and income records and compiles BOT reports. No lending authority.', 4),
  ('auditor', 'Auditor', 'institution',
   'Reads everything, including the audit log. Writes nothing.', 5);

CREATE TABLE reference.role_permissions (
  role_code       text NOT NULL REFERENCES reference.roles (code),
  permission_code text NOT NULL REFERENCES reference.permissions (code),
  PRIMARY KEY (role_code, permission_code)
);

-- Institution administrator: everything.
INSERT INTO reference.role_permissions (role_code, permission_code)
SELECT 'institution_admin', code FROM reference.permissions;

-- Auditor: every read, and nothing else. A reader that can write is not an auditor.
INSERT INTO reference.role_permissions (role_code, permission_code)
SELECT 'auditor', code FROM reference.permissions
 WHERE code LIKE '%.read';

-- Branch manager: runs a branch, and approves within it.
INSERT INTO reference.role_permissions (role_code, permission_code) VALUES
  ('branch_manager', 'client.read'),
  ('branch_manager', 'client.create'),
  ('branch_manager', 'client.update'),
  ('branch_manager', 'client.deactivate'),
  ('branch_manager', 'branch.read'),
  ('branch_manager', 'user.read'),
  ('branch_manager', 'loan.read'),
  ('branch_manager', 'loan.create'),
  ('branch_manager', 'loan.approve'),
  ('branch_manager', 'loan.disburse'),
  ('branch_manager', 'payment.read'),
  ('branch_manager', 'payment.create'),
  ('branch_manager', 'payment.reverse'),
  ('branch_manager', 'savings.read'),
  ('branch_manager', 'savings.manage'),
  ('branch_manager', 'complaint.read'),
  ('branch_manager', 'complaint.manage'),
  ('branch_manager', 'expense.read'),
  ('branch_manager', 'report.read');

-- Loan officer: prepares work for someone else to approve.
--
-- Deliberately without loan.approve and payment.reverse. Segregation of duties
-- is not a UI preference — the officer who creates an application must not be
-- the one who approves it.
INSERT INTO reference.role_permissions (role_code, permission_code) VALUES
  ('loan_officer', 'client.read'),
  ('loan_officer', 'client.create'),
  ('loan_officer', 'client.update'),
  ('loan_officer', 'branch.read'),
  ('loan_officer', 'loan.read'),
  ('loan_officer', 'loan.create'),
  ('loan_officer', 'payment.read'),
  ('loan_officer', 'payment.create'),
  ('loan_officer', 'savings.read'),
  ('loan_officer', 'complaint.read'),
  ('loan_officer', 'complaint.manage');

-- Accountant: the books and the returns, no lending authority.
INSERT INTO reference.role_permissions (role_code, permission_code) VALUES
  ('accountant', 'client.read'),
  ('accountant', 'branch.read'),
  ('accountant', 'loan.read'),
  ('accountant', 'payment.read'),
  ('accountant', 'savings.read'),
  ('accountant', 'share.read'),
  ('accountant', 'expense.read'),
  ('accountant', 'expense.manage'),
  ('accountant', 'complaint.read'),
  ('accountant', 'report.read'),
  ('accountant', 'report.generate');

GRANT SELECT ON reference.permissions, reference.roles, reference.role_permissions TO mfi_app;

-- ---------------------------------------------------------------------------
-- branches: composite key for referential tenancy
-- ---------------------------------------------------------------------------

-- Lets child tables reference (branch_id, institution_id) together, so a row
-- cannot point at a branch belonging to a different institution. Row-level
-- security governs what a session may *see*; this governs what the data may
-- *say*, which is a different guarantee and is not implied by the first.
ALTER TABLE branches ADD CONSTRAINT branches_id_institution_key UNIQUE (id, institution_id);

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id                uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id    uuid        NOT NULL REFERENCES institutions (id) ON DELETE RESTRICT,

  -- NULL means institution-wide (administrators, accountants, auditors).
  -- The composite reference guarantees the branch belongs to the same institution.
  branch_id         uuid,

  email             text        NOT NULL CHECK (position('@' IN email) > 1),
  full_name         text        NOT NULL CHECK (length(btrim(full_name)) > 0),

  -- NULL until an invited user sets one. A row with no hash cannot authenticate,
  -- which is what makes an invitation safe to create ahead of acceptance.
  password_hash     text,

  status            text        NOT NULL DEFAULT 'invited'
                                CHECK (status IN ('invited', 'active', 'suspended')),

  email_verified_at timestamptz,
  last_login_at     timestamptz,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT users_id_institution_key UNIQUE (id, institution_id),
  CONSTRAINT users_branch_within_institution
    FOREIGN KEY (branch_id, institution_id)
    REFERENCES branches (id, institution_id) ON DELETE RESTRICT,

  -- An active user must be able to authenticate; an invited one must not yet.
  CONSTRAINT users_active_requires_password
    CHECK (status <> 'active' OR password_hash IS NOT NULL)
);

COMMENT ON TABLE users IS 'Staff accounts. Authentication is by email, which is unique across all institutions.';

-- Email identifies a user at login, before any institution is known, so it must
-- be unique globally rather than per tenant. Case-insensitive because users do
-- not reliably type their own address the same way twice.
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE INDEX users_institution_status_idx ON users (institution_id, status);
CREATE INDEX users_branch_idx ON users (branch_id) WHERE branch_id IS NOT NULL;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY users_insert ON users
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY users_update ON users
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

-- No DELETE policy. A user who has approved a loan or recorded a payment is
-- referenced by that history; the account is suspended, never removed.
GRANT SELECT, INSERT, UPDATE ON users TO mfi_app;

-- ---------------------------------------------------------------------------
-- user_roles
-- ---------------------------------------------------------------------------

CREATE TABLE user_roles (
  institution_id uuid        NOT NULL,
  user_id        uuid        NOT NULL,
  role_code      text        NOT NULL REFERENCES reference.roles (code),

  granted_at     timestamptz NOT NULL DEFAULT now(),
  granted_by     uuid        REFERENCES users (id),

  PRIMARY KEY (user_id, role_code),

  -- Ties the grant to the same institution as the user it applies to, so a role
  -- row cannot be tagged to a tenant its subject does not belong to.
  CONSTRAINT user_roles_user_within_institution
    FOREIGN KEY (user_id, institution_id)
    REFERENCES users (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX user_roles_institution_idx ON user_roles (institution_id);

ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles FORCE ROW LEVEL SECURITY;

CREATE POLICY user_roles_select ON user_roles
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY user_roles_insert ON user_roles
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY user_roles_delete ON user_roles
  FOR DELETE TO mfi_app
  USING (institution_id = current_institution_id());

GRANT SELECT, INSERT, DELETE ON user_roles TO mfi_app;

-- Permissions held by a user, resolved through their roles.
--
-- SECURITY DEFINER with a pinned search_path so it can read the reference
-- catalogue regardless of the caller's own path, and so a caller cannot
-- substitute their own `reference` schema.
CREATE OR REPLACE FUNCTION user_permissions(p_user_id uuid) RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, reference, pg_temp
AS $$
  SELECT DISTINCT rp.permission_code
    FROM user_roles ur
    JOIN reference.role_permissions rp ON rp.role_code = ur.role_code
   WHERE ur.user_id = p_user_id;
$$;

COMMENT ON FUNCTION user_permissions(uuid) IS
  'Distinct permission codes held by a user through their assigned roles.';

GRANT EXECUTE ON FUNCTION user_permissions(uuid) TO mfi_app;

-- Whether the acting user holds a permission. Intended for policy predicates.
CREATE OR REPLACE FUNCTION has_permission(p_permission text) RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_user_id() IS NOT NULL
     AND EXISTS (SELECT 1 FROM user_permissions(current_user_id()) AS code WHERE code = p_permission);
$$;

GRANT EXECUTE ON FUNCTION has_permission(text) TO mfi_app;

-- ---------------------------------------------------------------------------
-- invitations
-- ---------------------------------------------------------------------------

-- How an institution gains its second user.
CREATE TABLE invitations (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL REFERENCES institutions (id) ON DELETE CASCADE,
  branch_id      uuid,

  email          text        NOT NULL CHECK (position('@' IN email) > 1),
  full_name      text        NOT NULL CHECK (length(btrim(full_name)) > 0),
  role_code      text        NOT NULL REFERENCES reference.roles (code),

  -- Only the hash is stored. The invitation token exists in the email that was
  -- sent and nowhere else, so a database disclosure does not yield usable
  -- invitations.
  token_hash     text        NOT NULL UNIQUE,

  invited_by     uuid        NOT NULL REFERENCES users (id),
  expires_at     timestamptz NOT NULL,
  accepted_at    timestamptz,
  revoked_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT invitations_branch_within_institution
    FOREIGN KEY (branch_id, institution_id)
    REFERENCES branches (id, institution_id) ON DELETE RESTRICT,

  CONSTRAINT invitations_not_both_accepted_and_revoked
    CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);

-- One live invitation per address per institution. Re-inviting means revoking
-- the previous one, so an old link cannot still be redeemed afterwards.
CREATE UNIQUE INDEX invitations_one_pending_per_email
  ON invitations (institution_id, lower(email))
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE INDEX invitations_institution_idx ON invitations (institution_id);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;

CREATE POLICY invitations_select ON invitations
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY invitations_insert ON invitations
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY invitations_update ON invitations
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON invitations TO mfi_app;

-- ---------------------------------------------------------------------------
-- refresh_tokens
-- ---------------------------------------------------------------------------

-- Rotating refresh tokens with reuse detection.
--
-- Each successful refresh consumes one token and issues another in the same
-- family. Presenting an already-consumed token means it was captured — the
-- legitimate holder has since rotated past it — so the whole family is revoked
-- and the session ends. Without a family, a stolen token is indistinguishable
-- from a legitimate one and grants access until it expires.
CREATE TABLE refresh_tokens (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL,
  user_id        uuid        NOT NULL,

  -- Constant across a rotation chain, so revoking one revokes the lineage.
  family_id      uuid        NOT NULL,

  token_hash     text        NOT NULL UNIQUE,

  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  revoked_at     timestamptz,
  revoked_reason text,

  user_agent     text,
  ip_address     inet,

  CONSTRAINT refresh_tokens_user_within_institution
    FOREIGN KEY (user_id, institution_id)
    REFERENCES users (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX refresh_tokens_institution_idx ON refresh_tokens (institution_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_active_idx
  ON refresh_tokens (user_id)
  WHERE used_at IS NULL AND revoked_at IS NULL;

ALTER TABLE refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE refresh_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY refresh_tokens_select ON refresh_tokens
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY refresh_tokens_insert ON refresh_tokens
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY refresh_tokens_update ON refresh_tokens
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON refresh_tokens TO mfi_app;

-- ---------------------------------------------------------------------------
-- user_tokens
-- ---------------------------------------------------------------------------

-- Single-use, expiring tokens for email verification and password reset.
--
-- Two purposes in one table because their shape and lifecycle are identical.
-- Keeping them distinct matters for a different reason: the previous system
-- offered only password reset, so a user whose verification email was lost had
-- no route back — the two operations were conflated in the interface even
-- though they are not the same thing (APP FLOW §2).
CREATE TABLE user_tokens (
  id             uuid        PRIMARY KEY DEFAULT uuid_generate_v7(),
  institution_id uuid        NOT NULL,
  user_id        uuid        NOT NULL,

  purpose        text        NOT NULL
                             CHECK (purpose IN ('email_verification', 'password_reset')),

  token_hash     text        NOT NULL UNIQUE,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT user_tokens_user_within_institution
    FOREIGN KEY (user_id, institution_id)
    REFERENCES users (id, institution_id) ON DELETE CASCADE
);

CREATE INDEX user_tokens_institution_idx ON user_tokens (institution_id);
CREATE INDEX user_tokens_user_purpose_idx
  ON user_tokens (user_id, purpose)
  WHERE consumed_at IS NULL;

ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY user_tokens_select ON user_tokens
  FOR SELECT TO mfi_app
  USING (institution_id = current_institution_id());

CREATE POLICY user_tokens_insert ON user_tokens
  FOR INSERT TO mfi_app
  WITH CHECK (institution_id = current_institution_id());

CREATE POLICY user_tokens_update ON user_tokens
  FOR UPDATE TO mfi_app
  USING (institution_id = current_institution_id())
  WITH CHECK (institution_id = current_institution_id());

GRANT SELECT, INSERT, UPDATE ON user_tokens TO mfi_app;
