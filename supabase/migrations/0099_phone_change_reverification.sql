-- ─── Phone changes must be re-verified ──────────────────────────────────
--
-- THE BUG
--
-- profiles.phone was directly writable by the patient (the account page did
-- `.update({ phone })` with the user's own client) while profiles.phone_verified_at
-- is column-locked to the OTP path (0054 / 0065). So a patient could change
-- their number and the timestamp stayed set from the ORIGINAL number's
-- verification: the system then believed an unverified number was verified.
--
-- That is not cosmetic. lib/payments/dunningNotifications.ts sends arrears
-- reminders with `if (ctx.phone) sendSms(ctx.phone, body)` — reading
-- profiles.phone through a join, with no verification check at any of its
-- three call sites. A patient who typed a wrong (or someone else's) number
-- had their payment-arrears SMS delivered to it.
--
-- THE FIX, AND WHY IT IS A STAGING COLUMN
--
-- profiles.phone now only ever holds a VERIFIED number. A change is staged in
-- phone_pending, an OTP is sent to the staged number, and only a successful
-- verification promotes it. Three properties fall out structurally rather than
-- by convention:
--
--   • The old number stays authoritative for the whole flow, so an abandoned
--     change leaves a working number rather than an unverified one. Nothing
--     needs to "roll back" — the pending value is simply never promoted.
--
--   • phone_verified_at always describes profiles.phone, because they are only
--     ever written together. It cannot carry over from a previous number.
--
--   • Every existing consumer of profiles.phone becomes trustworthy without
--     being touched. In particular dunning needs no change, which is the
--     right outcome: adding a verification gate there would risk suppressing
--     legitimate arrears reminders, and the real defect was upstream.
--
-- WHAT IS DELIBERATELY NOT DONE HERE
--
-- profiles.phone is still not column-locked, so a determined patient can
-- bypass the account-page flow and PATCH it directly via REST. That is
-- pre-existing, it is bounded by the per-user 10-sends-per-24h cap below, and
-- closing it means locking the column to service-role writes — which would
-- also have to account for app/provider/profile/page.tsx, the one remaining
-- surface that writes a phone with the user's own client. Separate task; see
-- the report.

-- ── 1. The staging column ─────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS phone_pending TEXT;

COMMENT ON COLUMN public.profiles.phone_pending IS
  'A phone number the patient has asked to change TO, in E.164, awaiting OTP '
  'verification. NEVER authoritative: nothing sends SMS here. On successful '
  'verification it is promoted into profiles.phone, phone_verified_at is '
  'stamped fresh, and this column is cleared. NULL means no change in flight. '
  'Introduced 0099 so an abandoned change leaves the previously-verified '
  'number intact.';

-- ── 2. Widen the prepare guard to accept the staged number ───────────────
--
-- 0055 added a phone-match check to close the SMS-credit burn vector from the
-- 2026-06-21 audit (H1): an authenticated caller could otherwise pass any
-- phone string and burn credit on arbitrary numbers. That check compared
-- p_phone against profiles.phone ONLY, which makes verifying a number BEFORE
-- it becomes profiles.phone impossible — the whole point of this migration.
--
-- So the guard now accepts p_phone matching profiles.phone OR
-- profiles.phone_pending. This does NOT widen the attack surface:
--
--   • profiles.phone is already patient-writable (it is not among the columns
--     protect_profiles_columns locks), so a caller could always point the
--     guard at a number of their choosing. phone_pending is the same
--     capability through a supported door.
--
--   • What actually bounds SMS burn is the per-user total cap — 10 sends per
--     24h keyed on user_id ALONE, independent of which phone or which column.
--     It is reproduced below unchanged.
--
-- EVERY CAP IS BYTE-IDENTICAL TO 0055. Only the match clause differs:
--   30s resend cooldown · 5 sends per (user, phone) / 24h ·
--   10 sends per user / 24h · 10-minute code expiry.
-- The 5-wrong-attempt cap lives in verify_phone_otp_for_user (0053), which
-- this migration does not touch at all — it has no phone-match check, so it
-- needed no change.

CREATE OR REPLACE FUNCTION prepare_phone_verification_for_user(
  p_user_id   UUID,
  p_phone     TEXT,
  p_code_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing        phone_verifications%ROWTYPE;
  v_profile_phone   text;
  v_profile_pending text;
  v_user_total      int;
BEGIN
  -- ── Existence + confirmed-email gate (unchanged from 0053) ─────────
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id = p_user_id
       AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN 'invalid_user';
  END IF;

  -- ── Phone-match check (0055, widened 0099) ───────────────────────────
  -- The caller may only verify a number that is already on their OWN
  -- profile: either the current one, or the one they have staged for a
  -- change. Anything else is still phone_mismatch.
  SELECT phone, phone_pending
    INTO v_profile_phone, v_profile_pending
    FROM profiles
   WHERE id = p_user_id;

  IF p_phone IS NULL
     OR (p_phone IS DISTINCT FROM v_profile_phone
         AND p_phone IS DISTINCT FROM v_profile_pending) THEN
    RETURN 'phone_mismatch';
  END IF;

  -- ── Per-user total cap (10 sends in 24h, ANY phone history) ────────
  -- Unchanged from 0055, and now load-bearing rather than belt-and-braces:
  -- with two acceptable target columns this is the cap that bounds burn.
  SELECT COALESCE(SUM(send_count), 0)::int
    INTO v_user_total
    FROM phone_verifications
   WHERE user_id = p_user_id
     AND last_sent_at > now() - INTERVAL '24 hours';

  IF v_user_total >= 10 THEN
    RETURN 'user_daily_limit';
  END IF;

  SELECT * INTO v_existing FROM phone_verifications
   WHERE user_id = p_user_id AND phone_e164 = p_phone;

  IF FOUND THEN
    IF v_existing.last_sent_at > now() - INTERVAL '30 seconds' THEN
      RETURN 'too_soon';
    END IF;
    IF v_existing.send_count >= 5
       AND v_existing.last_sent_at > now() - INTERVAL '24 hours' THEN
      RETURN 'daily_limit';
    END IF;

    IF v_existing.last_sent_at <= now() - INTERVAL '24 hours' THEN
      UPDATE phone_verifications
         SET code_hash    = p_code_hash,
             expires_at   = now() + INTERVAL '10 minutes',
             attempts     = 0,
             verified_at  = NULL,
             last_sent_at = now(),
             send_count   = 1
       WHERE user_id = p_user_id AND phone_e164 = p_phone;
    ELSE
      UPDATE phone_verifications
         SET code_hash    = p_code_hash,
             expires_at   = now() + INTERVAL '10 minutes',
             attempts     = 0,
             verified_at  = NULL,
             last_sent_at = now(),
             send_count   = send_count + 1
       WHERE user_id = p_user_id AND phone_e164 = p_phone;
    END IF;
  ELSE
    INSERT INTO phone_verifications (user_id, phone_e164, code_hash, expires_at)
    VALUES (p_user_id, p_phone, p_code_hash, now() + INTERVAL '10 minutes');
  END IF;

  RETURN 'ok';
END;
$$;

-- Grants are unchanged from 0053; CREATE OR REPLACE preserves them.

COMMENT ON FUNCTION prepare_phone_verification_for_user(UUID, TEXT, TEXT) IS
  'Organic-signup + phone-change variant. Returns {ok, too_soon, daily_limit, '
  'user_daily_limit, invalid_user, phone_mismatch}. phone_mismatch accepts '
  'profiles.phone OR profiles.phone_pending as of 0099 (verifying a NEW number '
  'before it becomes the account number). All caps unchanged from 0055: 30s '
  'cooldown, 5 per (user,phone)/24h, 10 per user/24h.';
