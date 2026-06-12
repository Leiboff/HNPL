-- HNPL First-Payment-Gated Payouts
-- Introduces 'pending_first_payment': a plan has been accepted by the patient
-- but the payout to the practice is held until the first payment is confirmed
-- collected by HNPL. The admin then advances the plan to 'active' and releases
-- the payout.

-- ============================================================
-- plans: extend the status CHECK constraint
-- ============================================================

-- PostgreSQL does not support ALTER CONSTRAINT; drop and recreate.
-- Previous definition was set in 0007_plan_acceptance.sql.
ALTER TABLE plans
    DROP CONSTRAINT IF EXISTS plans_status_check;

ALTER TABLE plans
    ADD CONSTRAINT plans_status_check
    CHECK (status IN (
        'pending_acceptance',
        'pending_first_payment',
        'active',
        'completed',
        'defaulted',
        'cancelled',
        'declined'
    ));

-- ============================================================
-- Admin UPDATE policies — already covered, nothing to add
-- ============================================================

-- admins_all_plans    (0002): FOR ALL USING (is_platform_admin()) — covers UPDATE on plans
-- admins_all_payments (0002): FOR ALL USING (is_platform_admin()) — covers UPDATE on payments
-- admins_all_payouts  (0002): FOR ALL USING (is_platform_admin()) — covers UPDATE on payouts
