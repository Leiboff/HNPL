-- ─── Phone OTP gate: recognize POS counter-session tokens too ──────────────
--
-- BACKGROUND
--   prepare_phone_verification (migration 0052) gates on the token
--   pointing at a live patient_invitations row — the ONLY token space
--   that existed at the time. Migration 0085 added a second token space
--   (checkout_sessions, for the POS counter QR flow), and /checkout/
--   [token]'s CheckoutForm phone-OTP step (PhoneOtpStep -> requestPhoneOtp
--   -> prepare_phone_verification) is unchanged for that flow — it still
--   calls this RPC with a checkout_sessions token. Without this fix every
--   POS-issued session would fail phone verification with 'invalid_token',
--   even though the token is completely valid.
--
-- FIX
--   Widen the liveness predicate to accept EITHER a live
--   patient_invitations row OR a live checkout_sessions row (stage
--   created/scanned, unexpired). Everything else about the RPC —
--   rate limits, hashing, the phone_verifications table itself — is
--   unchanged; phone_verifications is keyed by the raw token string
--   regardless of which table it came from, so no schema change is
--   needed there.

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
  -- Token must point at a real, unaccepted, unexpired invitation OR a
  -- real, not-yet-completed, unexpired POS counter session.
  IF NOT EXISTS (
    SELECT 1 FROM patient_invitations
     WHERE token = p_token
       AND accepted_at IS NULL
       AND expires_at  > now()
  ) AND NOT EXISTS (
    SELECT 1 FROM checkout_sessions
     WHERE token = p_token
       AND stage IN ('created', 'scanned')
       AND expires_at > now()
  ) THEN
    RETURN 'invalid_token';
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

COMMENT ON FUNCTION prepare_phone_verification(TEXT, TEXT, TEXT) IS
  'Server action: generate 6-digit code, hash it with PHONE_OTP_PEPPER, '
  'then call this. Token may be a patient_invitations token OR a '
  'checkout_sessions token (migration 0085/0086). Returns one of {ok, '
  'too_soon, daily_limit, invalid_token}. On ok the server sends the SMS '
  'containing the raw OTP code (which never reaches this RPC or the '
  'table).';
