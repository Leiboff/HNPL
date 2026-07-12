-- ─── Add 'sales' role for the internal CRM ───────────────────────────────
--
-- Extends profiles_role_check to allow a new role: 'sales'. Sales users
-- can only reach the /crm surface — no admin approvals, banking,
-- fee_percent, patient PII, or practice operational data. Platform
-- admins (role='admin') can also reach /crm.
--
-- The 0054 protect_profiles_columns() trigger already blocks
-- session-client writes to profiles.role. That trigger fires for the
-- new 'sales' value too — no additional lock is needed. Sales-role
-- assignment happens via the /admin/sales-team screen using the
-- service-role client (bypasses the trigger), same discipline as
-- practice approval.
--
-- Additive-only: the existing five roles remain valid. No profiles
-- rows change state as a result of this migration.

ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;

ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN (
    'patient',
    'practice_admin',
    'practice_provider',
    'practice_staff',
    'admin',
    'sales'
  ));

COMMENT ON CONSTRAINT profiles_role_check ON profiles IS
  'Role enum. Sales role added in 0067 for the internal CRM surface — '
  'gated to /crm only. Column-lock trigger from 0054 remains in force.';
