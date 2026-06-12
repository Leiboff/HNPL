-- Profiles are now created by the handle_new_user() trigger (SECURITY DEFINER)
-- on auth.users INSERT, so the application no longer needs a client-facing
-- INSERT policy. Service-role inserts bypass RLS and are unaffected.
DROP POLICY IF EXISTS users_insert_own_profile ON profiles;
