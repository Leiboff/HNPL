-- Reverts 0032. Auth metadata now contains AES-256-GCM ciphertext (not
-- plaintext) for sa_id_number — the app encrypts before calling signUp /
-- createUser / inviteUserByEmail. The trigger must read it back so the
-- ciphertext lands in profiles.sa_id_number, exactly as it did in 0024.
--
-- All other trigger behaviour is identical to 0024 and 0032.

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
