-- Add salary_amount to profiles.
--
-- Companion to salary_day (0005): the day is WHEN a patient is paid, this is
-- HOW MUCH — captured at signup (onboarding identity step, alongside the SA
-- ID + salary day) and editable afterwards from Account -> Personal details.
-- NULL until the patient sets it. Rands, decimal (matches plans.total_amount
-- / profiles.approved_credit_limit — this codebase stores money as decimal
-- rand, not cents, outside the underwriting-policy layer).
--
-- Not currently read by any pricing or scheduling logic — capture only, same
-- as salary_day was before lib/finance.ts's scheduler consumed it.

ALTER TABLE profiles
    ADD COLUMN salary_amount NUMERIC(12,2)
        CHECK (salary_amount IS NULL OR salary_amount > 0);

-- RLS note: no new policy required. The existing "users_update_own_profile"
-- policy (USING id = auth.uid(), WITH CHECK id = auth.uid()) already permits
-- each user to update any column on their own profile row, including
-- salary_amount — same as salary_day. Not listed in migration 0054's
-- protect_profiles_columns() lock, so it stays patient-editable.
