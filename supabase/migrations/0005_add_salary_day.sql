-- Add salary_day to profiles.
-- Stores the day of the month (1–31) on which the patient receives their salary,
-- used to schedule payment collection near payday. NULL until the patient sets it.

ALTER TABLE profiles
    ADD COLUMN salary_day INTEGER
        CHECK (salary_day IS NULL OR (salary_day >= 1 AND salary_day <= 31));

-- RLS note: no new policy required. The existing "users_update_own_profile"
-- policy (USING id = auth.uid(), WITH CHECK id = auth.uid()) already permits
-- each user to update any column on their own profile row, including salary_day.
