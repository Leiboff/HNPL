-- Billing address fields on patient profiles.
-- All nullable — collected progressively, not required at sign-up.
-- RLS: "users_update_own_profile" (added in 0002_rls_policies.sql) already
-- covers UPDATE on profiles WHERE id = auth.uid(), so no new policy is needed.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS address_line1 TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS address_line2 TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS suburb       TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS city         TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS province     TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS postal_code  TEXT;
