-- Phase 2: Capability-based permissions.
--
-- GROUP 1: Swap 7 management policies from is_practice_admin() → is_practice_manager().
-- GROUP 2: Add is_practice_biller() helper; tighten billing INSERT policies.
-- GROUP 3: Fix 3 dead 'practice_admin' policies (role = 'practice_admin' never matched).
--
-- is_practice_admin() and is_practice_manager() remain defined. is_practice_admin()
-- is no longer referenced by any RLS policy after this migration — it becomes dead
-- code, available for removal in a future cleanup migration.

-- ═══════════════════════════════════════════════════════════════════════════════
-- GROUP 2 HELPER (defined first — GROUP 1 and 3 policies below reference it)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Returns true if the current user is an active member of the given practice
-- with billing capability (can_create_bills OR can_manage_practice).
CREATE OR REPLACE FUNCTION is_practice_biller(p_practice_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM practice_members
    WHERE practice_id = p_practice_id
      AND user_id = auth.uid()
      AND active = true
      AND (can_create_bills = true OR can_manage_practice = true)
  );
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- GROUP 1: Swap is_practice_admin → is_practice_manager on 7 management policies
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 1a. practices: UPDATE ────────────────────────────────────────────────────
-- Before: USING (is_practice_admin(id))
-- After:  USING (is_practice_manager(id))

DROP POLICY IF EXISTS "practice_admins_update_own_practice" ON practices;

CREATE POLICY "practice_admins_update_own_practice" ON practices
    FOR UPDATE
    USING (is_practice_manager(id));

-- ── 1b. practice_members: SELECT ─────────────────────────────────────────────
-- Before: USING (is_practice_admin(practice_id))
-- After:  USING (is_practice_manager(practice_id))

DROP POLICY IF EXISTS "practice_admins_select_members" ON practice_members;

CREATE POLICY "practice_admins_select_members" ON practice_members
    FOR SELECT
    USING (is_practice_manager(practice_id));

-- ── 1c. practice_members: INSERT ─────────────────────────────────────────────
-- Before: WITH CHECK (is_practice_admin(practice_id))
-- After:  WITH CHECK (is_practice_manager(practice_id))

DROP POLICY IF EXISTS "practice_admins_insert_members" ON practice_members;

CREATE POLICY "practice_admins_insert_members" ON practice_members
    FOR INSERT
    WITH CHECK (is_practice_manager(practice_id));

-- ── 1d. practice_members: UPDATE ─────────────────────────────────────────────
-- Before: USING (is_practice_admin(practice_id))
-- After:  USING (is_practice_manager(practice_id))

DROP POLICY IF EXISTS "practice_admins_update_members" ON practice_members;

CREATE POLICY "practice_admins_update_members" ON practice_members
    FOR UPDATE
    USING (is_practice_manager(practice_id));

-- ── 1e. practice_members: DELETE ─────────────────────────────────────────────
-- Before: USING (is_practice_admin(practice_id))
-- After:  USING (is_practice_manager(practice_id))

DROP POLICY IF EXISTS "practice_admins_delete_members" ON practice_members;

CREATE POLICY "practice_admins_delete_members" ON practice_members
    FOR DELETE
    USING (is_practice_manager(practice_id));

-- ── 1f. payouts: SELECT ───────────────────────────────────────────────────────
-- Before: USING (is_practice_admin(practice_id))
-- After:  USING (is_practice_manager(practice_id))

DROP POLICY IF EXISTS "practice_admins_select_payouts" ON payouts;

CREATE POLICY "practice_admins_select_payouts" ON payouts
    FOR SELECT
    USING (is_practice_manager(practice_id));

-- ── 1g. profiles: SELECT (member profile read for provider dropdown) ──────────
-- Before: is_practice_admin(target_member.practice_id)
-- After:  is_practice_manager(target_member.practice_id)

DROP POLICY IF EXISTS "practice_admin_select_member_profiles" ON profiles;

CREATE POLICY "practice_admin_select_member_profiles" ON profiles
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1
            FROM practice_members target_member
            WHERE target_member.user_id = profiles.id
              AND is_practice_manager(target_member.practice_id)
        )
    );

-- ═══════════════════════════════════════════════════════════════════════════════
-- GROUP 2: Tighten billing INSERT policies to require biller capability
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 2a. applications: INSERT ──────────────────────────────────────────────────
-- Before: WITH CHECK (is_practice_member(practice_id))
-- After:  WITH CHECK (is_practice_biller(practice_id))

DROP POLICY IF EXISTS "practice_members_insert_applications" ON applications;

CREATE POLICY "practice_members_insert_applications" ON applications
    FOR INSERT
    WITH CHECK (is_practice_biller(practice_id));

-- ── 2b. plans: INSERT ─────────────────────────────────────────────────────────
-- Before: WITH CHECK (is_practice_member(practice_id))
-- After:  WITH CHECK (is_practice_biller(practice_id))

DROP POLICY IF EXISTS "practice_members_insert_plans" ON plans;

CREATE POLICY "practice_members_insert_plans" ON plans
    FOR INSERT
    WITH CHECK (is_practice_biller(practice_id));

-- ═══════════════════════════════════════════════════════════════════════════════
-- GROUP 3: Fix dead 'practice_admin' policies
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- All three checked pm.role = 'practice_admin', which never matched because
-- practice_members.role only stores 'admin', 'staff', or 'provider'.
-- These policies have been silently non-functional since 0021/0022.

-- ── 3a. practice_admin_manage_members (practice_members, ALL) ─────────────────
-- DROPPED entirely. The five individual member-management policies recreated in
-- Group 1 (select/insert/update/delete on practice_members via is_practice_manager)
-- cover everything this FOR ALL policy was intended to do. Keeping a FOR ALL
-- alongside specific-operation policies creates overlapping grants that make
-- reasoning about access harder, with no benefit.

DROP POLICY IF EXISTS "practice_admin_manage_members" ON practice_members;

-- ── 3b. practice_admin_select_invitations (patient_invitations, SELECT) ───────
-- Replaced with is_practice_biller: whoever can bill can see their invitations.
-- (Restricting to managers only would mean non-manager billers couldn't see
-- the invitations they themselves created via Scenario B bill creation.)

DROP POLICY IF EXISTS "practice_admin_select_invitations" ON patient_invitations;

CREATE POLICY "practice_admin_select_invitations" ON patient_invitations
    FOR SELECT
    USING (is_practice_biller(practice_id));

-- ── 3c. practice_admin_insert_invitations (patient_invitations, INSERT) ────────
-- Same reasoning: uses is_practice_biller so any biller can create Scenario B
-- invitations. The createBill action runs as the session user, so this INSERT
-- policy must match billing capability, not management capability.

DROP POLICY IF EXISTS "practice_admin_insert_invitations" ON patient_invitations;

CREATE POLICY "practice_admin_insert_invitations" ON patient_invitations
    FOR INSERT
    WITH CHECK (is_practice_biller(practice_id));