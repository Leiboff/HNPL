-- profiles_role_check allowed 'practice_staff' but not 'practice_provider'.
-- The multi-tenant work renamed the provider concept to 'practice_provider'.
-- Add it (keeping practice_staff for backwards-compatibility).
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('patient', 'practice_admin', 'practice_provider', 'practice_staff', 'admin'));
