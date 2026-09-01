-- ─── A rate limiter that survives more than one lambda ──────────────────
--
-- THE DEFECT (audit 2026-09-01, F-14 / F-17)
--
-- Two problems, one cause.
--
-- (a) The three limiters that exist — lib/crm/publicLeadRateLimit,
--     lib/contact/contactRateLimit, and the one inside
--     /api/reverse-geocode — are in-process `Map`s. All three say so in
--     their own comments: on Vercel each instance has its own memory, so
--     the budget is per-lambda and an attacker with any concurrency simply
--     lands elsewhere.
--
-- (b) The paths with a real per-call CASH cost have no limiter at all:
--
--       signUpPatient              a Supabase transactional email
--       resendConfirmation         another one, for any address, on demand
--       initiateCheckout           an auth user + a Peach checkout
--       startIdentityVerification  a Didit session — a PAID KYC unit
--       redeemDeviceRegistrationCode  free guesses against an 8-digit code
--
--     redeemDeviceRegistrationCode is the sharpest of those. It is
--     anon-reachable, and the code space is GLOBAL — the RPC matches
--     code_hash across every practice at once, so a blind guesser hits
--     whichever practice currently has a live code and the effective hit
--     rate scales with how many are outstanding platform-wide.
--
-- WHY POSTGRES AND NOT REDIS
--
-- The OTP caps (0052 / 0055) already work exactly this way and are the
-- most load-bearing limits in the system. Adding a second mechanism with
-- its own failure modes, for limits that are less critical than the ones
-- already in SQL, would be the strange choice. If throughput ever makes
-- this the wrong home, the call sites go through one helper
-- (lib/security/rateLimit.ts) and can be repointed there.
--
-- FAIL-OPEN, DELIBERATELY
--
-- consume_rate_limit returning a permit on error, and the helper treating
-- a failed RPC as "allowed", is a decision rather than an oversight. These
-- limits sit in front of signup, the contact form and the checkout door;
-- a database blip that locked every one of them would be a worse and far
-- more likely outage than the abuse they exist to damp. The limits that
-- must NOT fail open — OTP sends, OTP attempts, till PIN attempts — are
-- not implemented here and are unchanged.

CREATE TABLE IF NOT EXISTS rate_limit_hits (
  id          BIGSERIAL   PRIMARY KEY,
  -- 'signup', 'checkout_initiate', 'identity_session', … — the surface.
  bucket      TEXT        NOT NULL,
  -- What is being limited: an IP, a user id, an email. Callers key by
  -- BOTH where they can (see lib/security/rateLimit.ts) — either alone is
  -- rotatable, and requiring an attacker to rotate both is the point.
  subject     TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query shape: count this (bucket, subject) since a cutoff.
CREATE INDEX IF NOT EXISTS rate_limit_hits_lookup_idx
  ON rate_limit_hits (bucket, subject, occurred_at DESC);

ALTER TABLE rate_limit_hits ENABLE ROW LEVEL SECURITY;
-- No policies. Reached only through the SECURITY DEFINER function below
-- and by the service-role client. Same lockdown as phone_verifications.

COMMENT ON TABLE rate_limit_hits IS
  'Shared-store rate limiting (0124). Replaces the per-instance in-memory '
  'Maps, which on Vercel gave each lambda its own budget. Written only via '
  'consume_rate_limit. Prune with delete_expired_rate_limit_hits.';

-- ─── consume_rate_limit ─────────────────────────────────────────────────
--
-- Count-then-insert in ONE statement so two concurrent callers cannot both
-- see the same sub-limit count and both be let through. The count is taken
-- inside the INSERT's WHERE clause, so the row is written only if the
-- budget was still available at the moment of writing.
--
-- Returns TRUE when the caller may proceed.

CREATE OR REPLACE FUNCTION consume_rate_limit(
  p_bucket      TEXT,
  p_subject     TEXT,
  p_max         INT,
  p_window_secs INT
) RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted int;
BEGIN
  IF p_subject IS NULL OR p_subject = '' THEN
    -- Nothing to key on. Allow rather than refuse: an unresolvable subject
    -- is our problem, not the caller's, and the surfaces this guards must
    -- not go dark because a header was missing.
    RETURN true;
  END IF;

  INSERT INTO rate_limit_hits (bucket, subject)
  SELECT p_bucket, p_subject
   WHERE (
     SELECT count(*)
       FROM rate_limit_hits
      WHERE bucket  = p_bucket
        AND subject = p_subject
        AND occurred_at > now() - make_interval(secs => p_window_secs)
   ) < p_max;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

-- Callable by the anon role: signup, the contact form, the public lead
-- form and till registration all run before any session exists. The
-- function can only ever spend budget — there is no read surface and no
-- way to grant yourself one.
GRANT EXECUTE ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) TO anon, authenticated, service_role;

COMMENT ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) IS
  'Atomic fixed-window rate limit. Returns true when the caller is within '
  'budget, and records the hit in the same statement so concurrent callers '
  'cannot both pass a sub-limit count. See lib/security/rateLimit.ts.';

-- ─── Pruning ────────────────────────────────────────────────────────────
--
-- Called from the daily collect-instalments cron rather than given a cron
-- entry of its own: it is housekeeping, it does not need its own schedule,
-- and a fourth Vercel cron for a DELETE would be noise.

CREATE OR REPLACE FUNCTION delete_expired_rate_limit_hits(p_older_than_secs INT DEFAULT 86400)
RETURNS INT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted int;
BEGIN
  DELETE FROM rate_limit_hits
   WHERE occurred_at < now() - make_interval(secs => p_older_than_secs);
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION delete_expired_rate_limit_hits(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_expired_rate_limit_hits(INT) TO service_role;

COMMENT ON FUNCTION delete_expired_rate_limit_hits(INT) IS
  'Housekeeping for rate_limit_hits. Service-role only — an anon caller '
  'able to prune the table could clear their own budget.';
