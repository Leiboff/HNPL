-- HNPL Patient Insert Payments
-- Payment rows are now created at acceptance time (not bill creation).
-- The patient's session must be able to INSERT into payments for their own plans.

CREATE POLICY "patients_insert_payments_for_own_plans" ON payments
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.id = payments.plan_id
              AND plans.patient_id = auth.uid()
        )
    );
