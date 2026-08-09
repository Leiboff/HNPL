-- ─── Resumable patient onboarding — draft activity timestamp ───────────
--
-- The stepped onboarding flow (0066) already persists every step
-- server-side straight onto `profiles` (phone, sa_id_number, salary_day,
-- credit_check_status, liveness_verified_at) — there's no separate
-- "draft" table to add. What's missing is a single timestamp so the
-- app can tell:
--
--   • whether an in-progress draft exists at all (non-NULL), so the
--     resume interstitial ("Welcome back — continue your application?")
--     only shows when there's genuinely something to resume, and
--   • how STALE it is, so a draft untouched for 30+ days is offered
--     only "Start over" (no continue option).
--
-- profiles.onboarding_last_active_at:
--   • NULL until the patient reaches the first point past verified
--     contact (email OTP confirmed, or Google's OAuth-verified email) —
--     i.e. the earliest moment a resumable draft is allowed to exist.
--     No draft, no timestamp, for anyone who bails before verifying.
--   • Bumped on every subsequent step write (see lib/onboarding/actions.ts
--     maybeFinalize + the phone-step advance call) and on "Start over"
--     (which resets the clock along with the draft fields).
--   • Read-only from the app's perspective via the service-role client —
--     every write to this column already goes through svc() (service
--     role), so no column-lock trigger changes are needed (same posture
--     as the other onboarding-step columns added in 0066, none of which
--     were added to the 0054/0065 protect_profiles_columns() lock).
--
-- Idempotent — safe to re-run.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS onboarding_last_active_at TIMESTAMPTZ;

COMMENT ON COLUMN public.profiles.onboarding_last_active_at IS
  'Stamped the first time a patient reaches verified contact (email OTP '
  'or Google OAuth) and bumped on every onboarding step write thereafter. '
  'NULL means no resumable draft exists yet (pre-verification, or already '
  'onboarding_completed). Used by the /onboarding resume gate to decide '
  '"nothing to resume" vs "show the Welcome back interstitial" vs '
  '"draft expired (30+ days) — Start over only".';
