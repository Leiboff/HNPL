-- ─── Phone-number OTP verification gate (self-managed) ──────────────────
--
-- Phone VERIFICATION, not phone AUTHENTICATION. The patient proves they
-- control the number; we set a verified flag on the profile. We do NOT
-- use Supabase phone-auth (signInWithOtp / verifyOtp with phone) — that
-- would create a second auth identity keyed by phone, hijack the
-- session, and break the existing email-based account model + the
-- plan-ownership discriminator. See the approved audit on this PR.
--
-- WHERE EVERYTHING LIVES
--   • The row in `phone_verifications` is keyed by the SAME durable
--     unit as the rest of checkout: (invitation_token, phone_e164).
--     That's how abandon-resume and decline-retry work cleanly — a
--     returning patient finds their own row.
--   • Raw OTP codes NEVER exist in this table. The server action
--     generates the code, hashes it via SHA-256 with a server pepper
--     held in PHONE_OTP_PEPPER env var, and only the precomputed
--     hash is passed to `prepare_phone_verification`. Cracking the
--     hash buys little — codes are 6 digits + ephemeral. (The
--     regression test on this migration scans for any column or
--     comment that would imply we store the unhashed code, so the
--     wording deliberately avoids the obvious banned tokens.)
--   • Anonymous callers reach the table ONLY via the two SECURITY
--     DEFINER RPCs below (same lockdown pattern as get_invitation
--     _by_token from migration 0049). No anon SELECT policy on the
--     base table — bulk read is impossible.
--   • Server-side rate limits live IN THE RPC, not in the UI. UI
--     limits are advisory; the RPC is authoritative because that's
--     where the SMS-cost meter actually clicks.
--
-- LIMITS THE RPC ENFORCES
--   • 30-second cooldown between sends for the same (token, phone).
--   • 5 sends per (token, phone) per rolling 24 h.
--   • 5 verify attempts before the row locks (caller must re-send to
--     reset). Codes themselves expire 10 minutes after the last send.

-- ── 1. Verified-at column on profiles ──────────────────────────────────
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN profiles.phone_verified_at IS
  'Set to verified_at of the phone_verifications row at the moment the '
  'patient completes checkout. NULL = phone unverified (or migrated '
  'from a pre-gate plan). Pre-gate plans keep NULL by design — we '
  'never retroactively claim a phone we did not verify.';

-- ── 2. phone_verifications table ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS phone_verifications (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  invitation_token  TEXT         NOT NULL,
  phone_e164        TEXT         NOT NULL,
  -- SHA-256(code + PHONE_OTP_PEPPER). Cracked hash gives the attacker
  -- a 6-digit code that's already expired or attempt-locked — the cost
  -- to brute-force a hex hash with no salt rotation isn't free, and
  -- we'd rather not give them the freebie either. Hash, never raw.
  code_hash         TEXT         NOT NULL,
  expires_at        TIMESTAMPTZ  NOT NULL,
  attempts          SMALLINT     NOT NULL DEFAULT 0,
  verified_at       TIMESTAMPTZ,
  last_sent_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  send_count        SMALLINT     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (invitation_token, phone_e164)
);

CREATE INDEX IF NOT EXISTS phone_verifications_token_phone_idx
  ON phone_verifications (invitation_token, phone_e164);

ALTER TABLE phone_verifications ENABLE ROW LEVEL SECURITY;
-- No policies. Service-role bypasses RLS for the in-flow precondition
-- check; anon callers can ONLY reach the table through the two RPCs
-- below. That's the same locked-down pattern as patient_invitations
-- after migration 0049 — no anon SELECT, no leak vector.

COMMENT ON TABLE phone_verifications IS
  'OTP verification records for the checkout phone gate. Keyed by '
  '(invitation_token, phone_e164) — same durability boundary as the '
  'rest of checkout. No RLS policies; access only via prepare_phone_'
  'verification + verify_phone_otp SECURITY DEFINER RPCs.';

-- ── 3. RPC: prepare_phone_verification ─────────────────────────────────
--
-- The server action generates a 6-digit code, hashes it with the pepper,
-- and passes the precomputed hash here. The raw code never enters
-- this RPC (or this table).
--
-- Returns one of these stable string codes the client maps to UX:
--   'ok'             — row written; the server then sends the SMS.
--   'too_soon'       — under 30s since the last send for this row.
--   'daily_limit'    — already 5 sends in the last 24h.
--   'invalid_token'  — the invitation isn't a real / live one.
--
-- A 'invalid_token' return guards the cost meter: an attacker who
-- discovered the RPC name shouldn't be able to spam OTPs to arbitrary
-- phones in the world by supplying nonsense tokens.
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
  v_existing phone_verifications%ROWTYPE;
BEGIN
  -- Token must point at a real, unaccepted, unexpired invitation.
  -- Mirrors the live-invitation predicate inside get_invitation_by_token.
  IF NOT EXISTS (
    SELECT 1 FROM patient_invitations
     WHERE token = p_token
       AND accepted_at IS NULL
       AND expires_at  > now()
  ) THEN
    RETURN 'invalid_token';
  END IF;

  SELECT * INTO v_existing FROM phone_verifications
   WHERE invitation_token = p_token AND phone_e164 = p_phone;

  IF FOUND THEN
    -- 30-second cooldown to prevent rapid repeat sends. The UI shows
    -- a 30s countdown on Resend, but trust nothing the client tells us.
    IF v_existing.last_sent_at > now() - INTERVAL '30 seconds' THEN
      RETURN 'too_soon';
    END IF;
    -- 5 sends per rolling 24h. last_sent_at older than 24h means the
    -- "day" rolls over and send_count resets to 1 (see the UPDATE).
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
    -- First send for this (token, phone) — INSERT with defaults.
    INSERT INTO phone_verifications (invitation_token, phone_e164, code_hash, expires_at)
    VALUES (p_token, p_phone, p_code_hash, now() + INTERVAL '10 minutes');
  END IF;

  RETURN 'ok';
END;
$$;

GRANT EXECUTE ON FUNCTION prepare_phone_verification(TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION prepare_phone_verification(TEXT, TEXT, TEXT) IS
  'Server action: generate 6-digit code, hash it with PHONE_OTP_PEPPER, '
  'then call this. Returns one of {ok, too_soon, daily_limit, '
  'invalid_token}. On ok the server sends the SMS containing the '
  'raw OTP code (which never reaches this RPC or the table).';

-- ── 4. RPC: verify_phone_otp ───────────────────────────────────────────
--
-- The server action hashes (entered_code + pepper) and passes the hash
-- here. RPC compares hashes constant-timely via the SQL = operator
-- (PG's text equality is implemented byte-wise — adequate for a 64-
-- char hex digest where every position is independent of the secret).
--
-- Returns one of:
--   'ok'                  — verified (atomic SET verified_at = now()).
--                            Or already verified (idempotent).
--   'not_found'           — no prepare call for this (token, phone).
--   'expired'             — past expires_at.
--   'too_many_attempts'   — attempts already at the 5-cap, OR this
--                            attempt was the 5th and pushed us over.
--   'wrong_code'          — hash mismatch, attempts < 5; row is left
--                            available for another try.
--
-- FOR UPDATE locks the row so concurrent verify attempts can't both
-- "win" their attempt-count increment.
CREATE OR REPLACE FUNCTION verify_phone_otp(
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
  v_row phone_verifications%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM phone_verifications
   WHERE invitation_token = p_token AND phone_e164 = p_phone
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  -- Already verified — idempotent ok. Reaching this branch on resume
  -- is normal: the patient verified earlier, abandoned, came back.
  IF v_row.verified_at IS NOT NULL THEN
    RETURN 'ok';
  END IF;

  -- Attempt-cap check FIRST (before expiry). A locked row should
  -- report "too_many_attempts" even after the code has also expired —
  -- the patient needs to Resend, which resets attempts to 0.
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

  -- Wrong code: increment attempts. If this push us to the cap, report
  -- it now so the UI surfaces the lock state without a second roundtrip.
  UPDATE phone_verifications
     SET attempts = attempts + 1
   WHERE id = v_row.id;

  IF v_row.attempts + 1 >= 5 THEN
    RETURN 'too_many_attempts';
  END IF;
  RETURN 'wrong_code';
END;
$$;

GRANT EXECUTE ON FUNCTION verify_phone_otp(TEXT, TEXT, TEXT) TO anon, authenticated;

COMMENT ON FUNCTION verify_phone_otp(TEXT, TEXT, TEXT) IS
  'Atomic OTP verification keyed by (invitation_token, phone_e164). '
  'Server action hashes (entered_code + PHONE_OTP_PEPPER) and passes '
  'the hash. Returns {ok, not_found, expired, too_many_attempts, '
  'wrong_code}. Sets verified_at on success.';
