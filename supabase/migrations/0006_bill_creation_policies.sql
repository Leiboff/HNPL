-- HNPL Bill Creation RLS Policies
-- Enables practice members to create bills (applications + plans + payments)
-- and to look up patient profiles by email during the flow.

-- ============================================================
-- profiles: practice members need to look up patient profiles
-- ============================================================

-- Scoped to role = 'patient' so practitioners cannot read other
-- practitioners' or admin profiles via this policy.
CREATE POLICY "practice_members_select_patient_profiles" ON profiles
    FOR SELECT
    USING (
        role = 'patient'
        AND EXISTS (
            SELECT 1 FROM practice_members pm
            WHERE pm.user_id = auth.uid()
              AND pm.active = true
        )
    );

-- ============================================================
-- applications
-- ============================================================

CREATE POLICY "practice_members_insert_applications" ON applications
    FOR INSERT
    WITH CHECK (is_practice_member(practice_id));

-- DELETE used for rollback if plan or payment insertion fails.
CREATE POLICY "practice_members_delete_applications" ON applications
    FOR DELETE
    USING (is_practice_member(practice_id));

-- ============================================================
-- plans
-- ============================================================

CREATE POLICY "practice_members_insert_plans" ON plans
    FOR INSERT
    WITH CHECK (is_practice_member(practice_id));

-- DELETE used for rollback if payment insertion fails.
CREATE POLICY "practice_members_delete_plans" ON plans
    FOR DELETE
    USING (is_practice_member(practice_id));

-- ============================================================
-- payments
-- ============================================================

-- Joins through plans to reach practice_id, consistent with the
-- existing practice_members_select_payments SELECT policy.
CREATE POLICY "practice_members_insert_payments" ON payments
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.id = payments.plan_id
              AND is_practice_member(plans.practice_id)
        )
    );
