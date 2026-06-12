-- sa_id_number is no longer passed through auth.users.raw_user_meta_data.
-- Signup actions now write the encrypted value directly to profiles via a
-- service-role UPDATE after the auth account is created. The trigger must
-- insert NULL for sa_id_number so it does not overwrite the encrypted value
-- with an empty string on any race condition or retry.
--
-- All other trigger behaviour is preserved exactly.

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id, email, role, first_name, last_name, phone,
    sa_id_number, salary_day, hpcsa_number,
    must_change_password, verification_status, created_at
  )
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'role', 'patient'),
    COALESCE(NEW.raw_user_meta_data->>'first_name', ''),
    COALESCE(NEW.raw_user_meta_data->>'last_name', ''),
    NEW.raw_user_meta_data->>'phone',
    NULL,
    CASE
      WHEN NEW.raw_user_meta_data->>'salary_day' IS NOT NULL
      THEN (NEW.raw_user_meta_data->>'salary_day')::int
      ELSE NULL
    END,
    NEW.raw_user_meta_data->>'hpcsa_number',
    COALESCE((NEW.raw_user_meta_data->>'must_change_password')::boolean, false),
    'unverified',
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;
