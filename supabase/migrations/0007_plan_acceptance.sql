-- HNPL Plan Acceptance
-- Extends plan statuses for the patient acceptance flow and adds
-- the patient UPDATE policies needed to accept or decline a plan.

-- ============================================================
-- plans: extend the status CHECK constraint
-- ============================================================

-- PostgreSQL does not support ALTER CONSTRAINT, so we drop and recreate.
-- The constraint was created implicitly by the column definition in 0001;
-- pg_get_constraintdef returns a name like plans_status_check.
ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_status_check;

ALTER TABLE plans
    ADD CONSTRAINT plans_status_check
    CHECK (status IN ('pending_acceptance', 'active', 'completed', 'defaulted', 'cancelled', 'declined'));

-- ============================================================
-- plans: patient UPDATE policy
-- ============================================================

-- Patients were given SELECT on their own plans but no UPDATE.
-- This allows a patient to update only their own plan row.
CREATE POLICY "patients_update_own_plans" ON plans
    FOR UPDATE
    USING (patient_id = auth.uid())
    WITH CHECK (patient_id = auth.uid());

-- ============================================================
-- payments: patient UPDATE policy
-- ============================================================

-- Patients were given SELECT on their own payments but no UPDATE.
-- Accepting a plan marks the first payment's status; this allows it.
CREATE POLICY "patients_update_own_payments" ON payments
    FOR UPDATE
    USING (patient_id = auth.uid())
    WITH CHECK (patient_id = auth.uid());
