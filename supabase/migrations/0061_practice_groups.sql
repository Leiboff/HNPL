-- ─── Practice groups (brand/branch foundation, Phase 1) ────────────────
--
-- Adds a thin "brand" layer above practices so one brand can have many
-- branches (Lamberti Physiotherapy: 7; future retail chains: 50+).
-- Additive only — a practice with NULL group_id is a standalone practice
-- and EVERY existing flow stays byte-for-byte unchanged (asserted by
-- regression tests).
--
-- Model:
--   • A branch IS a practice (full row, own address/coords/staff/
--     trading-gate). Nothing duplicated.
--   • A brand/group is a row in practice_groups that holds the shared
--     name + optional central banking.
--   • A brand-admin is a row in practice_group_members at the group
--     level (mirrors the per-practice practice_members pattern at the
--     group tier).
--
-- Banking resolution (used by lib/practice/banking.ts):
--   when settling a branch, prefer the branch's own banking; fall back
--   to the group's banking; if neither set, branch is not settleable
--   (trading gate fails for branches; standalone unchanged).
--
-- Permissions:
--   • Brand-admin can SEE / MANAGE branches in their group (read plans/
--     bills/practices/practice_members where the practice's group_id =
--     a group the user is brand-admin of).
--   • Brand-admin CANNOT approve a branch — the 0054 column locks on
--     status/approved_at/approved_by/fee_percent already block any
--     non-service-role UPDATE, so brand-admin going through PostgREST
--     is blocked. Branch approval stays on the platform-admin path.
--   • Branch-admin (practice_members) stays scoped to the one branch.
--   • Standalone practice (group_id = NULL): zero policy change.

-- ── 1. practice_groups ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS practice_groups (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                 TEXT NOT NULL,
  logo_url             TEXT,
  -- Central banking — mirrors the practice columns. Either populate
  -- these (central-billed chain) or leave NULL (branch-billed brand);
  -- the banking-resolution helper handles both shapes.
  bank_name            TEXT,
  bank_account_number  TEXT,
  branch_code          TEXT,
  account_holder       TEXT,
  account_type         TEXT,
  status               TEXT NOT NULL DEFAULT 'active',
  created_by           UUID REFERENCES profiles(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE practice_groups
  DROP CONSTRAINT IF EXISTS practice_groups_status_check;
ALTER TABLE practice_groups
  ADD  CONSTRAINT practice_groups_status_check
  CHECK (status IN ('active', 'inactive'));

ALTER TABLE practice_groups
  DROP CONSTRAINT IF EXISTS practice_groups_account_type_check;
ALTER TABLE practice_groups
  ADD  CONSTRAINT practice_groups_account_type_check
  CHECK (account_type IS NULL OR account_type IN ('current', 'savings'));

-- ── 2. practices.group_id (nullable) ────────────────────────────────────

ALTER TABLE practices
  ADD COLUMN IF NOT EXISTS group_id UUID REFERENCES practice_groups(id);

-- Partial index — only branches are indexed; standalone practices
-- (group_id IS NULL) are the bulk of rows and don't need this index.
CREATE INDEX IF NOT EXISTS practices_group_id_idx
  ON practices (group_id)
  WHERE group_id IS NOT NULL;

-- ── 3. practice_group_members (brand-admin tier) ────────────────────────
--
-- Mirrors the practice_members pattern but at the group level.
-- role is constrained to 'brand_admin' for Phase 1; future tiers
-- (brand_staff, brand_viewer) bolt on by extending the CHECK list.
CREATE TABLE IF NOT EXISTS practice_group_members (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id    UUID NOT NULL REFERENCES practice_groups(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES profiles(id)        ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'brand_admin',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);

ALTER TABLE practice_group_members
  DROP CONSTRAINT IF EXISTS practice_group_members_role_check;
ALTER TABLE practice_group_members
  ADD  CONSTRAINT practice_group_members_role_check
  CHECK (role IN ('brand_admin'));

CREATE INDEX IF NOT EXISTS practice_group_members_user_id_idx
  ON practice_group_members (user_id) WHERE active = true;

-- ── 4. Helper: is_brand_admin(group_id) ─────────────────────────────────
--
-- Mirrors is_practice_admin / is_practice_manager — STABLE SECURITY
-- DEFINER so RLS policies on practice_group_members can reference it
-- without recursive evaluation.
CREATE OR REPLACE FUNCTION is_brand_admin(p_group_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_group_members
     WHERE group_id = p_group_id
       AND user_id  = auth.uid()
       AND active   = true
  );
$$;

-- ── 5. Helper: is_brand_admin_of_practice(practice_id) ──────────────────
--
-- "Is the caller a brand-admin of the group this practice belongs to?"
-- The widening predicate used by every practice-scoped RLS policy that
-- now also grants brand-admin access. Returns false for standalone
-- practices (no group_id) — they fall through to is_practice_member /
-- is_practice_admin / is_practice_manager exactly as before.
CREATE OR REPLACE FUNCTION is_brand_admin_of_practice(p_practice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM practices p
      JOIN practice_group_members pgm
        ON pgm.group_id = p.group_id
     WHERE p.id        = p_practice_id
       AND p.group_id IS NOT NULL
       AND pgm.user_id = auth.uid()
       AND pgm.active  = true
  );
$$;

-- ── 6. RLS on practice_groups ───────────────────────────────────────────

ALTER TABLE practice_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_admin_all_practice_groups" ON practice_groups;
CREATE POLICY "platform_admin_all_practice_groups"
  ON practice_groups
  FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS "brand_admin_select_own_group" ON practice_groups;
CREATE POLICY "brand_admin_select_own_group"
  ON practice_groups
  FOR SELECT
  USING (is_brand_admin(id));

-- A practice-member of any branch in the group can read the group row
-- (so the branch-side UI can show "Part of <brand>" without elevating).
DROP POLICY IF EXISTS "branch_members_select_own_group" ON practice_groups;
CREATE POLICY "branch_members_select_own_group"
  ON practice_groups
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM practices p
        JOIN practice_members pm ON pm.practice_id = p.id
       WHERE p.group_id = practice_groups.id
         AND pm.user_id = auth.uid()
         AND pm.active  = true
    )
  );

-- ── 7. RLS on practice_group_members ────────────────────────────────────

ALTER TABLE practice_group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "platform_admin_all_practice_group_members" ON practice_group_members;
CREATE POLICY "platform_admin_all_practice_group_members"
  ON practice_group_members
  FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

-- A brand-admin can see who else is in their group's member list.
DROP POLICY IF EXISTS "brand_admin_select_own_group_members" ON practice_group_members;
CREATE POLICY "brand_admin_select_own_group_members"
  ON practice_group_members
  FOR SELECT
  USING (is_brand_admin(group_id));

-- A user can always see their own brand-admin row.
DROP POLICY IF EXISTS "self_select_practice_group_members" ON practice_group_members;
CREATE POLICY "self_select_practice_group_members"
  ON practice_group_members
  FOR SELECT
  USING (user_id = auth.uid());

-- ── 8. Widen existing per-practice RLS to include brand-admin ───────────
--
-- The KEY constraint: every existing per-practice policy stays in
-- effect; we ADD brand-admin via an additional permissive SELECT
-- policy. This means standalone practices (group_id IS NULL) are
-- unchanged — is_brand_admin_of_practice returns false for them, so
-- the old policies are the entire access surface. Branches gain a
-- second permissive SELECT pathway for brand-admins.

-- practices: brand-admin can SELECT branches in their group.
DROP POLICY IF EXISTS "brand_admin_select_branches" ON practices;
CREATE POLICY "brand_admin_select_branches"
  ON practices
  FOR SELECT
  USING (is_brand_admin_of_practice(id));

-- practice_members: brand-admin can SELECT members of branches in
-- their group (read-only at the database layer; create/update/delete
-- of branch members goes through a server action with explicit
-- guardBrandAdminOfPractice authz so the column-lock surface stays
-- the same as today's branch-admin flow).
DROP POLICY IF EXISTS "brand_admin_select_branch_members" ON practice_members;
CREATE POLICY "brand_admin_select_branch_members"
  ON practice_members
  FOR SELECT
  USING (is_brand_admin_of_practice(practice_id));

-- plans: brand-admin can SELECT plans on any branch in their group.
DROP POLICY IF EXISTS "brand_admin_select_branch_plans" ON plans;
CREATE POLICY "brand_admin_select_branch_plans"
  ON plans
  FOR SELECT
  USING (is_brand_admin_of_practice(practice_id));

-- payments: brand-admin can SELECT payments belonging to any plan on
-- any branch in their group.
DROP POLICY IF EXISTS "brand_admin_select_branch_payments" ON payments;
CREATE POLICY "brand_admin_select_branch_payments"
  ON payments
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM plans
       WHERE plans.id = payments.plan_id
         AND is_brand_admin_of_practice(plans.practice_id)
    )
  );

-- payouts: brand-admin can SELECT payouts for any branch in their group.
DROP POLICY IF EXISTS "brand_admin_select_branch_payouts" ON payouts;
CREATE POLICY "brand_admin_select_branch_payouts"
  ON payouts
  FOR SELECT
  USING (is_brand_admin_of_practice(practice_id));

-- ── 9. NOTE: branch INSERT / column-lock posture ────────────────────────
--
-- Brand-admin creates a branch via a server action (NOT a direct
-- PostgREST INSERT) — the action uses the service-role client to set
-- group_id at INSERT time, and forces status='pending'. The 0054
-- BEFORE UPDATE trigger on practices then blocks any subsequent
-- status / approved_at / approved_by / fee_percent change from a
-- session-client call, so a brand-admin cannot self-approve via
-- direct REST either. Approval continues to flow through
-- app/admin/practices/actions.ts approvePractice (platform-admin only).
