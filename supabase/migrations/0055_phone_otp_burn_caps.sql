-- ─── H1 — close the SMS-credit burn vector ──────────────────────────────
--
-- The audit (2026-06-21, H1) found two ways to burn our SMS credit
-- arbitrarily:
--
--   1. AUTH-PATH: any authenticated user could call the
--      prepare_phone_verification_for_user RPC with their OWN user_id
--      and an ARBITRARY phone — the existing rate limit is per
--      (user_id, phone), so spraying distinct phones bypassed the cap.
--      (Even tighter: a user could rotate their own profiles.phone
--      between calls, since /verify-phone reads phone from the
--      profile — fix 0054 closes the column to indirect-rotation via
--      direct REST, but the RPC itself was the deeper hole.)
--
--   2. TOKEN-PATH: an attacker with a leaked invitation token could
--      call the anon-callable prepare_phone_verification with any
--      phone. Same per-(token, phone) cap; same phone-spray bypass.
--      Cap was 5 / 24h per phone, but with N distinct phones the
--      attacker burned 5×N SMS / 24h. With one stolen token the cost
--      was bounded only by the rate of generating phone strings.
--
-- This migration closes both:
--
--   • Phone-match check on the user-keyed prepare: rejects if p_phone
--     ≠ the user's profile phone. Verification is for YOUR own number,
--     full stop.
--
--   • Per-token total-send cap (10 / 24h) on the token-keyed prepare,
--     independent of phone. Counts rows across ALL (token, *) pairs in
--     the last 24h. Legit decline-retry needs <10 (same phone, same
--     token, capped at 5 anyway); a spray attacker hits 10 at most.
--
--   • The same per-user total cap on the user-keyed RPC, for symmetry.
--     A user shouldn't be able to call requestPhoneOtpForUser more
--     than 10 times in 24h regardless of column rotation.
--
-- Existing per-(key, phone) caps (30s cooldown, 5 in 24h per phone)
-- stay in place — they bound the SAME (key, phone) pair. The new
-- caps bound the OUTER dimension.

-- ── prepare_phone_verification (token-keyed, anon-callable) ─────────────

CREATE OR REPLACE FUNCTION prepare_phone_verification(
  p_token     TEXT,
  p_phone     TEXT,
  p_code_hash TEXT
) RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing       phone_verifications%ROWTYPE;
  v_token_total    int;
BEGIN
  -- Token must point at a real, unaccepted, unexpired invitation.
  IF NOT EXISTS (
    SELECT 1 FROM patient_invitations
     WHERE token = p_token
       AND accepted_at IS NULL
       AND expires_at  > now()
  ) THEN
    RETURN 'invalid_token';
  END IF;

  -- ── Per-token total cap (10 sends in 24h, ANY phone) ──────────────
  -- Sum send_count across rows for this token whose last_sent_at is
  -- inside the rolling 24h window. Rows older than that have already
  -- "rolled over" their counter on a fresh send, so they don't
  -- contribute to the current-day total.
  SELECT COALESCE(SUM(send_count), 0)::int
    INTO v_token_total
    FROM phone_verifications
   WHERE invitation_token = p_token
     AND last_sent_at > now() - INTERVAL '24 hours';

  IF v_token_total >= 10 THEN
    RETURN 'token_daily_limit';
  END IF;

  SELECT * INTO v_existing FROM phone_verifications
   WHERE invitation_token = p_token AND phone_e164 = p_phone;

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
       WHERE invitation_token = p_token AND phone_e164 = p_phone;
    ELSE
      UPDATE phone_verifications
         SET code_hash    = p_code_hash,
             expires_at   = now() + INTERVAL '10 minutes',
             attempts     = 0,
             verified_at  = NULL,
             last_sent_at = now(),
             send_count   = send_count + 1
       WHERE invitation_token = p_token AND phone_e164 = p_phone;
    END IF;
  ELSE
    INSERT INTO phone_verifications (invitation_token, phone_e164, code_hash, expires_at)
    VALUES (p_token, p_phone, p_code_hash, now() + INTERVAL '10 minutes');
  END IF;

  RETURN 'ok';
END;
$$;

-- Grants are unchanged from 0052; CREATE OR REPLACE preserves them.

COMMENT ON FUNCTION prepare_phone_verification(TEXT, TEXT, TEXT) IS
  'Server action: generate 6-digit code, hash with PHONE_OTP_PEPPER, '
  'then call this. Returns one of {ok, too_soon, daily_limit, '
  'token_daily_limit, invalid_token}. token_daily_limit caps total '
  'sends per invitation token across all phones (10 in 24h) — closes '
  'the SMS-burn vector from the 2026-06-21 audit (H1).';

-- ── prepare_phone_verification_for_user (user-keyed, authed) ──────────────

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
  v_existing       phone_verifications%ROWTYPE;
  v_profile_phone  text;
  v_user_total     int;
BEGIN
  -- ── Existence + confirmed-email gate (unchanged from 0053) ─────────
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id = p_user_id
       AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN 'invalid_user';
  END IF;

  -- ── Phone-match check ────────────────────────────────────────────────
  -- The user can only verify their OWN profile.phone. Without this
  -- check, an authenticated user could call this RPC with any phone
  -- string and burn our SMS credit on arbitrary numbers (the audit's
  -- H1 user-path). Profile-side fix 0054 stops indirect rotation;
  -- THIS is the direct-RPC stop.
  SELECT phone INTO v_profile_phone FROM profiles WHERE id = p_user_id;
  IF v_profile_phone IS NULL OR p_phone IS DISTINCT FROM v_profile_phone THEN
    RETURN 'phone_mismatch';
  END IF;

  -- ── Per-user total cap (10 sends in 24h, ANY phone history) ────────
  -- Symmetric to the token-keyed RPC. Belt-and-braces — in practice
  -- the phone_mismatch check above already bounds a single user to
  -- one phone-target, but the cap is the second layer.
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

COMMENT ON FUNCTION prepare_phone_verification_for_user(UUID, TEXT, TEXT) IS
  'Organic-signup variant. Returns {ok, too_soon, daily_limit, '
  'user_daily_limit, invalid_user, phone_mismatch}. phone_mismatch + '
  'user_daily_limit added 2026-06-22 to close the SMS-burn vector '
  '(audit H1).';
