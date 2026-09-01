-- ─── The phone-OTP user RPCs bind to their caller ───────────────────────
--
-- THE DEFECT (audit 2026-09-02, A-06)
--
-- `prepare_phone_verification_for_user` and `verify_phone_otp_for_user` take
-- the target account as a parameter and never compare it to `auth.uid()`.
-- 0055 added a check, but it checks the PHONE, not the CALLER: p_phone must
-- match the target profile's `phone` or `phone_pending`. Nothing anywhere
-- asks whether the caller is that user.
--
-- 0099's header reasons that "profiles.phone is already patient-writable …
-- so a caller could always point the guard at a number of their choosing."
-- True for the caller's OWN profile. Not true for somebody else's — and the
-- guard is applied to the profile named by p_user_id.
--
-- What that bought an authenticated attacker, both proved in
-- security-audit-2026-09-02-otp-rpc.rpc.test.ts:
--
--   • ATTEMPT BURN. Five calls to verify_phone_otp_for_user(victim, …,
--     'guess') and the row returns 'too_many_attempts'. The victim, holding
--     the correct code, is locked out of the phone step — which blocks
--     onboarding, which blocks requireOnboarded, which blocks them
--     accepting any bill. Repeatable indefinitely.
--   • A PHONE-NUMBER ORACLE. 'phone_mismatch' vs 'ok' distinguishes a wrong
--     candidate number from the right one, so numbers can be tested against
--     a known user id until one lands. A patient's cellphone linked to a
--     healthcare payment record is special personal information.
--
-- ─── WHY THIS IS STILL WORTH ADDING AFTER 0125 ─────────────────────────
--
-- 0125 already removed `authenticated` from both functions, so there is no
-- browser path to them today. This is the second layer, and the reason it
-- exists is written in this repo's own history: migration 0007 added a
-- column-unrestricted write policy that stood for a hundred migrations
-- before 0121 removed it. A grant that is correct today is not a property of
-- the function. A check inside the function is.
--
-- ─── THE SHAPE, AND WHY IT IS NOT A BARE auth.uid() COMPARISON ──────────
--
-- After 0125 the ONLY callers are service-role clients — the three server
-- actions in app/(auth)/verify-phone/actions.ts and
-- app/patient/account/phoneChangeActions.ts, each sourcing the id from
-- `getUser()` on the session client first. Under service_role `auth.uid()`
-- is NULL, so a bare `auth.uid() = p_user_id` would refuse every legitimate
-- call and take the phone gate down.
--
-- So the predicate is the one this schema already uses for exactly this
-- situation: `hnpl_write_is_privileged()` (0121) — service_role, or a
-- SECURITY DEFINER caller that opted in via set_config. Privileged callers
-- pass; anything else must be the user itself.
--
-- ─── RETURN CODES ARE DELIBERATELY NOT NEW ─────────────────────────────
--
-- 'invalid_user' on prepare and 'not_found' on verify — both already in each
-- function's vocabulary, and both already reachable for innocent reasons. A
-- new code would tell an attacker they had found a real account and guessed
-- the wrong caller, which is the oracle this migration exists to remove.
-- The application maps both to copy that does not distinguish them.
--
-- EVERY OTHER LINE IS BYTE-IDENTICAL TO 0099 / 0053. Only the guard is new.
--
-- ─── A LATENT BUG IN hnpl_write_is_privileged(), FOUND WRITING THIS ─────
--
-- 0121 defined it as:
--
--     SELECT auth.role() = 'service_role'
--         OR current_setting('app.privileged_write', true) = 'on';
--
-- `current_setting(…, true)` returns NULL when the setting is unset — which
-- is always, in normal operation — so `NULL = 'on'` is NULL and the whole
-- expression is `false OR NULL` = **NULL**, not false. Measured, not
-- guessed: `select hnpl_write_is_privileged()` as an authenticated caller
-- returns NULL.
--
-- 0121's three triggers survive that by luck of polarity. They ask
-- `IF hnpl_write_is_privileged() THEN <allow>`, plpgsql treats NULL as not
-- true, and they fall through to their RAISE — fail-closed, correct.
--
-- Any caller phrasing it the other way round does NOT survive it:
-- `IF NOT hnpl_write_is_privileged() AND <not the owner> THEN <refuse>`
-- evaluates to `NOT NULL AND true` = NULL, the branch never fires, and the
-- guard silently permits everything. That is precisely the shape a
-- caller-binding check wants, and the first draft of this migration had it.
--
-- So the predicate is repaired here rather than worked around: COALESCE to
-- false, and STRICT-safe. The three existing triggers are unaffected (false
-- and NULL behave identically in their positive test), and every future
-- caller can negate it safely. The guards below additionally use
-- `IS NOT TRUE` rather than `NOT`, so they stay correct even if someone
-- reverts the predicate.

CREATE OR REPLACE FUNCTION hnpl_write_is_privileged()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(auth.role() = 'service_role', false)
      OR COALESCE(current_setting('app.privileged_write', true) = 'on', false);
$$;

COMMENT ON FUNCTION hnpl_write_is_privileged() IS
  'The 0054 bypass predicate, shared by every column-lock trigger. True for '
  'the service-role clients and for a SECURITY DEFINER caller that opted in '
  'via set_config(''app.privileged_write'', ''on'', true). As of 0126 it '
  'returns FALSE rather than NULL when neither holds — the 0121 definition '
  'returned NULL, which is safe under `IF f() THEN allow` and fails OPEN '
  'under `IF NOT f() THEN refuse`.';

-- ── prepare_phone_verification_for_user ────────────────────────────────

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
  -- ── Caller binding (0126, audit A-06) ────────────────────────────────
  -- A non-privileged caller may only act on itself. Same return code as a
  -- non-existent user, so this is not an oracle.
  IF hnpl_write_is_privileged() IS NOT TRUE
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
    RETURN 'invalid_user';
  END IF;

  -- ── Existence + confirmed-email gate (unchanged from 0053) ─────────
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
     WHERE id = p_user_id
       AND email_confirmed_at IS NOT NULL
  ) THEN
    RETURN 'invalid_user';
  END IF;

  -- ── Phone-match check (0055, widened 0099) ───────────────────────────
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
  'Organic-signup + phone-change variant. As of 0126 a non-privileged caller '
  'may only act on its own auth.uid() (audit A-06); privileged callers '
  '(service_role) pass, which is every real call site. Returns {ok, too_soon, '
  'daily_limit, user_daily_limit, invalid_user, phone_mismatch}. Caps '
  'unchanged from 0055/0099: 30s cooldown, 5 per (user,phone)/24h, 10 per '
  'user/24h.';

-- ── verify_phone_otp_for_user ──────────────────────────────────────────

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
  -- ── Caller binding (0126, audit A-06) ────────────────────────────────
  -- 'not_found' rather than a new code: a cross-account attempt now looks
  -- exactly like a row that was never prepared, so neither the existence of
  -- the account nor the correctness of the phone leaks. This is also the
  -- line that stops the attempt-burn lockout — the counter is never reached.
  IF hnpl_write_is_privileged() IS NOT TRUE
     AND (auth.uid() IS NULL OR auth.uid() IS DISTINCT FROM p_user_id) THEN
    RETURN 'not_found';
  END IF;

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

COMMENT ON FUNCTION verify_phone_otp_for_user(UUID, TEXT, TEXT) IS
  'Organic-signup variant, keyed by user_id. As of 0126 a non-privileged '
  'caller may only act on its own auth.uid() and gets ''not_found'' otherwise '
  '(audit A-06) — indistinguishable from an unprepared row, so it is not an '
  'oracle and the attempt counter is never reachable across accounts. '
  'Atomic semantics and return vocabulary unchanged from 0053.';

-- Grants are unchanged: 0125 left both service_role-only, and CREATE OR
-- REPLACE preserves that.
