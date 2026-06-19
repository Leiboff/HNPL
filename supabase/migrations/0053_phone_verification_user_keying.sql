-- ─── Phone-verification: add user_id keying mode (organic signup) ───────
--
-- Migration 0052 built phone OTP keyed on invitation_token because the
-- checkout flow has no account yet at OTP time. Organic signup is
-- different: by the time the phone gate runs, the user is fully
-- authenticated (email OTP confirmed it). For that path we key by
-- user_id directly — cleaner and avoids manufacturing a fake token.
--
-- Both keying modes must coexist in the same table. Constraint logic:
--   • invitation_token  → nullable; previously NOT NULL.
--   • user_id           → new, nullable, FK to auth.users with
--                          ON DELETE CASCADE.
--   • XOR CHECK         → exactly one of (invitation_token, user_id)
--                          must be present on every row.
--   • Unique key        → was a single UNIQUE (invitation_token,
--                          phone_e164) constraint. Replaced with two
--                          partial unique INDEXES — one per keying
--                          mode — so a (NULL, NULL) row can't sneak
--                          past uniqueness via NULL's loose semantics.
--
-- RPCs follow the same pattern as 0052 — same rate limits, same
-- attempt cap, same expiry, same coded-string returns. Two new
-- functions parallel the existing ones, keyed by user_id:
--   • prepare_phone_verification_for_user(user_id, phone, code_hash)
--   • verify_phone_otp_for_user(user_id, phone, code_hash)
--
-- They are granted to AUTHENTICATED ONLY (not anon) — the signup phone
-- gate runs after email OTP, so the caller always has a session by
-- the time these RPCs are reachable. Anonymous traffic must use the
-- existing invitation_token-keyed RPCs.
--
-- The checkout flow keeps working unchanged: its existing call sites
-- pass invitation_token to the existing RPCs, which still match the
-- partial unique index on (invitation_token, phone_e164).

-- ── 1. Make invitation_token nullable + add user_id ─────────────────────
ALTER TABLE phone_verifications
  ALTER COLUMN invitation_token DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS user_id UUID
    REFERENCES auth.users(id) ON DELETE CASCADE;

-- ── 2. Replace the table-level UNIQUE (invitation_token, phone_e164) ────
-- with two partial unique INDEXES, one per keying mode. The old
-- constraint name comes from Postgres's auto-naming when 0052 declared
-- UNIQUE inline on CREATE TABLE — DROP IF EXISTS keeps this safe.
ALTER TABLE phone_verifications
  DROP CONSTRAINT IF EXISTS phone_verifications_invitation_token_phone_e164_key;

CREATE UNIQUE INDEX IF NOT EXISTS phone_verifications_token_phone_uniq
  ON phone_verifications (invitation_token, phone_e164)
  WHERE invitation_token IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS phone_verifications_user_phone_uniq
  ON phone_verifications (user_id, phone_e164)
  WHERE user_id IS NOT NULL;

-- ── 3. XOR CHECK: exactly one of the two keys is set ────────────────────
-- (a IS NOT NULL)::int + (b IS NOT NULL)::int = 1 is the standard
-- portable way to express XOR in plain SQL. Without this guard, a
-- buggy caller could write a row with neither key (orphan) or both
-- (ambiguous lookup).
ALTER TABLE phone_verifications
  ADD CONSTRAINT phone_verifications_xor_key
  CHECK (
    (invitation_token IS NOT NULL)::int + (user_id IS NOT NULL)::int = 1
  );

COMMENT ON COLUMN phone_verifications.user_id IS
  'Organic-signup keying mode. Set when the phone gate runs after '
  'email OTP and the patient is already authenticated. Mutually '
  'exclusive with invitation_token (XOR check constraint).';

-- ── 4. prepare_phone_verification_for_user ──────────────────────────────
--
-- Parallels prepare_phone_verification (0052). Same rate limits, same
-- 10-minute code expiry, same coded-string returns:
--   'ok' | 'too_soon' | 'daily_limit' | 'invalid_user'
--
-- The only differences from the invitation-keyed variant:
--   • Existence check is "user_id is real AND email-confirmed" rather
--     than "invitation_token is a live invitation". An unconfirmed
--     user (somehow reaching this RPC) gets 'invalid_user'.
--   • Row matched by (user_id, phone_e164), upsert via the partial
--     unique index added above.
--
-- Granted to AUTHENTICATED only — there is no anonymous path to this
-- function; the signup phone step runs post-email-OTP with a session.

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
  v_existing phone_verifications%ROWTYPE;
BEGIN
  -- Caller must be a real, email-confirmed auth user. Anyone reaching
  -- here without confirming email shouldn't be able to spend SMS
  -- credit on our account — the same rationale that guards the
  -- invitation-keyed variant's invitation-liveness check.
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id = p_user_id
       AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN 'invalid_user';
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

GRANT EXECUTE ON FUNCTION prepare_phone_verification_for_user(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION prepare_phone_verification_for_user(UUID, TEXT, TEXT) IS
  'Organic-signup variant of prepare_phone_verification, keyed by '
  'user_id instead of invitation_token. Anon callers cannot invoke '
  'this function — only authenticated email-confirmed users.';

-- ── 5. verify_phone_otp_for_user ────────────────────────────────────────
--
-- Parallels verify_phone_otp (0052). Same locking + atomic update,
-- same {ok, not_found, expired, too_many_attempts, wrong_code} return
-- vocabulary. Granted to AUTHENTICATED only.

CREATE OR REPLACE FUNCTION verify_phone_otp_for_user(
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
  v_row phone_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM phone_verifications
   WHERE user_id = p_user_id AND phone_e164 = p_phone
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF v_row.verified_at IS NOT NULL THEN
    RETURN 'ok';
  END IF;

  IF v_row.attempts >= 5 THEN
    RETURN 'too_many_attempts';
  END IF;

  IF v_row.expires_at <= now() THEN
    RETURN 'expired';
  END IF;

  IF v_row.code_hash = p_code_hash THEN
    UPDATE phone_verifications
       SET verified_at = now()
     WHERE id = v_row.id;
    RETURN 'ok';
  END IF;

  UPDATE phone_verifications
     SET attempts = attempts + 1
   WHERE id = v_row.id;

  IF v_row.attempts + 1 >= 5 THEN
    RETURN 'too_many_attempts';
  END IF;
  RETURN 'wrong_code';
END;
$$;

GRANT EXECUTE ON FUNCTION verify_phone_otp_for_user(UUID, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION verify_phone_otp_for_user(UUID, TEXT, TEXT) IS
  'Organic-signup variant of verify_phone_otp, keyed by user_id. '
  'Same atomic semantics + coded-string returns as the invitation '
  'variant. Granted to authenticated only.';
