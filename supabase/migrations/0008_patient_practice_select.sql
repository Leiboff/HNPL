-- HNPL Patient Practice Select
-- Patients need to read the practice name when viewing their payment plans.
-- Scoped to practices the patient is actually linked to via a plan.

CREATE POLICY "patients_select_practice_for_own_plans" ON practices
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM plans
            WHERE plans.practice_id = practices.id
              AND plans.patient_id = auth.uid()
        )
    );
