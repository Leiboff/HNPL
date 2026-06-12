-- HNPL RLS Policies

-- ============================================================
-- Helper functions (SECURITY DEFINER bypasses RLS on the
-- tables they query, breaking recursive policy evaluation)
-- ============================================================

-- Returns true if the current user is a platform admin.
-- SECURITY DEFINER is required because the profiles SELECT
-- policy itself calls this function — without it, checking
-- role inside profiles would recurse infinitely.
CREATE OR REPLACE FUNCTION is_platform_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Returns true if the current user is an active member of the given practice.
-- SECURITY DEFINER avoids triggering RLS on practice_members
-- from within practice_members policies.
CREATE OR REPLACE FUNCTION is_practice_member(p_practice_id UUID)
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
  );
$$;

-- Returns true if the current user is an active admin of the given practice.
CREATE OR REPLACE FUNCTION is_practice_admin(p_practice_id UUID)
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
      AND role = 'admin'
      AND active = true
  );
$$;

-- ============================================================
-- profiles
-- ============================================================

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_select_own_profile" ON profiles
    FOR SELECT
    USING (id = auth.uid());

CREATE POLICY "users_insert_own_profile" ON profiles
    FOR INSERT
    WITH CHECK (id = auth.uid());

-- WITH CHECK mirrors USING to prevent a user from re-assigning
-- their profile id to another auth user's id on update.
CREATE POLICY "users_update_own_profile" ON profiles
    FOR UPDATE
    USING (id = auth.uid())
    WITH CHECK (id = auth.uid());

CREATE POLICY "admins_select_all_profiles" ON profiles
    FOR SELECT
    USING (is_platform_admin());

-- ============================================================
-- practices
-- ============================================================

ALTER TABLE practices ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practice_members_select_own_practice" ON practices
    FOR SELECT
    USING (is_practice_member(id));

CREATE POLICY "practice_admins_update_own_practice" ON practices
    FOR UPDATE
    USING (is_practice_admin(id));

-- Any authenticated user may create a practice (e.g. during onboarding),
-- but they must set themselves as the owner.
CREATE POLICY "authenticated_insert_practice" ON practices
    FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL AND owner_id = auth.uid());

CREATE POLICY "admins_select_all_practices" ON practices
    FOR SELECT
    USING (is_platform_admin());

CREATE POLICY "admins_update_all_practices" ON practices
    FOR UPDATE
    USING (is_platform_admin());

-- ============================================================
-- practice_members
-- ============================================================

ALTER TABLE practice_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_select_own_membership" ON practice_members
    FOR SELECT
    USING (user_id = auth.uid());

CREATE POLICY "practice_admins_select_members" ON practice_members
    FOR SELECT
    USING (is_practice_admin(practice_id));

CREATE POLICY "practice_admins_insert_members" ON practice_members
    FOR INSERT
    WITH CHECK (is_practice_admin(practice_id));

CREATE POLICY "practice_admins_update_members" ON practice_members
    FOR UPDATE
    USING (is_practice_admin(practice_id));

CREATE POLICY "practice_admins_delete_members" ON practice_members
    FOR DELETE
    USING (is_practice_admin(practice_id));

CREATE POLICY "admins_all_practice_members" ON practice_members
    FOR ALL
    USING (is_platform_admin());

-- ============================================================
-- applications
-- ============================================================

ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "patients_select_own_applications" ON applications
    FOR SELECT
    USING (patient_id = auth.uid());

CREATE POLICY "patients_insert_own_applications" ON applications
    FOR INSERT
    WITH CHECK (patient_id = auth.uid());

CREATE POLICY "practice_members_select_applications" ON applications
    FOR SELECT
    USING (is_practice_member(practice_id));

CREATE POLICY "admins_all_applications" ON applications
    FOR ALL
    USING (is_platform_admin());

-- ============================================================
-- plans
-- ============================================================

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY "patients_select_own_plans" ON plans
    FOR SELECT
    USING (patient_id = auth.uid());

CREATE POLICY "practice_members_select_plans" ON plans
    FOR SELECT
    USING (is_practice_member(practice_id));

CREATE POLICY "admins_all_plans" ON plans
    FOR ALL
    USING (is_platform_admin());

-- ============================================================
-- payments
-- ============================================================

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "patients_select_own_payments" ON payments
    FOR SELECT
    USING (patient_id = auth.uid());

-- Joining through plans to reach practice_id avoids denormalising
-- practice_id onto the payments table.
CREATE POLICY "practice_members_select_payments" ON payments
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.id = payments.plan_id
              AND is_practice_member(plans.practice_id)
        )
    );

CREATE POLICY "admins_all_payments" ON payments
    FOR ALL
    USING (is_platform_admin());

-- ============================================================
-- payouts
-- ============================================================

ALTER TABLE payouts ENABLE ROW LEVEL SECURITY;

-- Practice admins (not plain members) can see their practice's payouts.
-- No policy is granted to patients, so they see nothing.
CREATE POLICY "practice_admins_select_payouts" ON payouts
    FOR SELECT
    USING (is_practice_admin(practice_id));

CREATE POLICY "admins_all_payouts" ON payouts
    FOR ALL
    USING (is_platform_admin());
