-- HNPL Payout on Accept
-- The acceptPlan Server Action runs as the patient. It needs to INSERT a
-- payouts row when the patient accepts a plan.
--
-- The practice_admins_select_payouts SELECT policy already exists (0002).
-- This migration only adds the patient INSERT policy.

CREATE POLICY "patients_insert_payout_on_accept" ON payouts
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.id = payouts.plan_id
              AND plans.patient_id = auth.uid()
        )
    );
