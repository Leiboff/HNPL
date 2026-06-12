-- Replaces handle_new_user() to read all profile fields from raw_user_meta_data.
-- The trigger itself (on_auth_user_created) was created in 0023 and remains unchanged.
-- Signup actions now pass all fields via options.data / user_metadata so the trigger
-- creates a complete profile row in one atomic write — no placeholder rows, no second upsert.

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
    NEW.raw_user_meta_data->>'sa_id_number',
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
