-- ─── Patient onboarding gate ─────────────────────────────────────────────
--
-- Adds the columns the stepped onboarding flow needs on top of the
-- existing verification columns:
--
--   • onboarding_completed     — write-once-true cache. When TRUE, the
--                                patient has finished every step that
--                                applied to them at the time; a later
--                                flag flip does NOT retro-lock them.
--   • onboarding_completed_at  — stamp for audit / support.
--   • credit_check_status      — nullable / 'pending' / 'passed' / 'failed'.
--                                Only meaningful when ENABLE_CREDIT_CHECK
--                                is true; the runtime check treats
--                                flag-off as auto-pass.
--   • credit_check_completed_at — stamp.
--   • liveness_verified_at     — stamp; same flag-off semantics.
--
-- Existing columns re-used (from earlier migrations):
--   auth.users.email_confirmed_at  — email verified
--   profiles.phone                 — captured at signup / phone step
--   profiles.phone_verified_at     — 0052 OTP mechanism
--   profiles.sa_id_number          — encrypted via AES-256-GCM (idEncryption.ts)
--   profiles.salary_day            — 0005; integer day-of-month 1..31
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_completed        BOOLEAN     NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS onboarding_completed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS credit_check_status         TEXT,
  ADD COLUMN IF NOT EXISTS credit_check_completed_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS liveness_verified_at        TIMESTAMPTZ;

-- CHECK constraint on credit_check_status. Deferred to a DO block so a
-- re-run of the migration doesn't fail on a duplicate constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'profiles_credit_check_status_chk'
      AND conrelid = 'public.profiles'::regclass
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_credit_check_status_chk
      CHECK (
        credit_check_status IS NULL
        OR credit_check_status IN ('pending', 'passed', 'failed')
      );
  END IF;
END $$;

-- ─── Backfill ────────────────────────────────────────────────────────────
--
-- Any profile that already satisfies the CURRENT (flag-agnostic) onboarding
-- criteria gets onboarding_completed=TRUE so returning users never see the
-- new gate. Non-patient roles get TRUE trivially — the gate only enforces
-- against patients, but keeping the flag consistent avoids odd states.
--
-- Criteria for a patient to be "grandfathered":
--   • email confirmed in auth.users
--   • phone_verified_at IS NOT NULL
--   • sa_id_number IS NOT NULL
--   • salary_day IS NOT NULL

UPDATE public.profiles p
SET onboarding_completed    = TRUE,
    onboarding_completed_at = COALESCE(p.onboarding_completed_at, NOW())
WHERE p.onboarding_completed = FALSE
  AND (
    p.role <> 'patient'
    OR (
      p.phone_verified_at IS NOT NULL
      AND p.sa_id_number IS NOT NULL
      AND p.salary_day IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM auth.users au
        WHERE au.id = p.id
          AND au.email_confirmed_at IS NOT NULL
      )
    )
  );

-- Column comments — living documentation for anyone reading the schema.
COMMENT ON COLUMN public.profiles.onboarding_completed IS
  'Cached: TRUE once every applicable onboarding step passed. Write-once-true; flag flips (ENABLE_CREDIT_CHECK / ENABLE_LIVENESS) do NOT retro-lock existing patients.';
COMMENT ON COLUMN public.profiles.credit_check_status IS
  'Nullable / pending / passed / failed. Only meaningful when ENABLE_CREDIT_CHECK is on; flag-off treats absence as auto-pass at runtime.';
COMMENT ON COLUMN public.profiles.liveness_verified_at IS
  'Timestamp of a successful liveness ceremony. Only meaningful when ENABLE_LIVENESS is on; flag-off treats absence as auto-pass at runtime.';
