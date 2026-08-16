-- ═══════════════════════════════════════════════════════════════════════
-- Two independent fixes that both live in this table's RPC surface.
-- ═══════════════════════════════════════════════════════════════════════
--
-- 1. THE INVITATION CARRIES THE ID THE PRACTICE TYPED
--
--    Since bills gained a mandatory SA ID, the QR path enforces the key
--    end to end (checkout_sessions.sa_id_number is decrypted at checkout
--    and the client's value ignored) but the EMAIL path did not: the
--    practice's ID was validated, checked for conflicts, and then
--    discarded, and the patient typed their own at checkout with nothing
--    comparing the two. A practice could bill under one ID and the patient
--    claim under another and nothing would notice — the exact asymmetry the
--    mandatory-ID work exists to close, surviving in one branch.
--
--    NULLABLE, permanently. Invitations issued before this migration have
--    no ID and there is nothing to backfill from — the value was never
--    stored. app/checkout/[token]/page.tsx keys the 'unclaimed_invitation'
--    copy bucket off exactly that NULL.
--
--    NO LOOKUP HASH HERE, deliberately. profiles.sa_id_lookup_hash exists
--    to serve equality search and 0097's UNIQUE index; neither applies to
--    an invitation. The token is the key — we already have the exact row
--    before we need the ID, so the comparison is decrypt-and-compare. A
--    second store of ID-derived material with no consumer reads as
--    load-bearing to the next person who finds it.
--
-- 2. THE 2-MINUTE WINDOW WAS DOING TWO JOBS
--
--    checkout_sessions.expires_at governed both "how long may this QR sit
--    unscanned" and "how long may the patient take to finish". Only the
--    first has a security argument behind it — a stranger photographing a
--    QR off a shared reception screen. The second was simply too short: a
--    first-time patient enters an ID, verifies an OTP, clears
--    affordability, accepts terms and enters a card. Not a two-minute job,
--    and expiry does not merely lapse — expire_stale_checkout_session
--    DECLINES the plan, which is terminal. A slow signup at the counter
--    destroyed the bill.
--
--    Split into a SCAN window and a COMPLETION window, without a second
--    column: expires_at means "the deadline currently in force", and the
--    scan stamp moves it forward. Why not a completion_expires_at column —
--    get_checkout_session_by_token ALSO guards on expires_at > now(), so a
--    separate column would leave two independent "is this live?" tests to
--    keep in step, and a missed one would lock the patient out of their own
--    session mid-signup while the decliner thought it was fine. Moving one
--    value changes neither guard.
--
--    expire_stale_checkout_session is NOT touched. It remains the single
--    thing that declines a stale session; it just stops assuming the
--    deadline it reads is the one set at issuance.
--
--    THE WINDOW IS HARDCODED, NOT A PARAMETER. This function is
--    GRANTed to anon (0085), so a caller-supplied interval would let anyone
--    mint an arbitrarily long-lived session. lib/checkout/sessionTtl.ts
--    mirrors this value and a test pins the two equal.

-- ── 1. patient_invitations.sa_id_number ────────────────────────────────

ALTER TABLE patient_invitations
  ADD COLUMN IF NOT EXISTS sa_id_number TEXT;

COMMENT ON COLUMN patient_invitations.sa_id_number IS
  'The SA ID the practice captured when issuing this bill, AES-256-GCM '
  'encrypted in lib/idEncryption.ts''s v1:iv:tag:ciphertext format — the '
  'same shape as profiles.sa_id_number and checkout_sessions.sa_id_number. '
  'Compared against the ID the patient types at checkout, before any '
  'account is created or any plan is bound. NULL on invitations issued '
  'before migration 0098, which is a state the checkout copy handles '
  'explicitly rather than a value to backfill. Never returned in plaintext.';

-- ── 2. get_invitation_by_token returns it ──────────────────────────────
--
-- Encrypted, to an anon caller — the same posture
-- get_checkout_session_by_token already takes with the session's own
-- ciphertext. The checkout page needs it to run the claim for a signed-in
-- patient, exactly as it does for a counter session.

DROP FUNCTION IF EXISTS get_invitation_by_token(TEXT);

CREATE OR REPLACE FUNCTION get_invitation_by_token(p_token TEXT)
RETURNS TABLE (
  email                TEXT,
  practice_name        TEXT,
  plan_id              UUID,
  plan_total_amount    NUMERIC,
  invoice_number       TEXT,
  practice_reference   TEXT,
  sa_id_number         TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.email,
    p.name              AS practice_name,
    pl.id               AS plan_id,
    pl.total_amount     AS plan_total_amount,
    pl.invoice_number,
    pl.practice_reference,
    pi.sa_id_number
  FROM patient_invitations pi
  JOIN plans     pl ON pl.id = pi.plan_id
  JOIN practices p  ON p.id  = pi.practice_id
  WHERE pi.token = p_token
    AND pi.accepted_at IS NULL
    AND pi.expires_at  > now()
    AND pl.status NOT IN ('completed', 'cancelled', 'declined')
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION get_invitation_by_token(TEXT) IS
  'Anon-callable invitation lookup by token. sa_id_number is returned '
  'ENCRYPTED, never plaintext — matching get_checkout_session_by_token.';

-- ── 3. The scan stamp moves the deadline to the completion window ──────

CREATE OR REPLACE FUNCTION stamp_checkout_session_scanned(p_token TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT expire_stale_checkout_session(p_token);

  UPDATE checkout_sessions
     SET stage      = 'scanned',
         scanned_at = now(),
         -- The scan window is over the moment it is scanned; what remains
         -- is the patient's own time on their own phone. Extending here
         -- costs nothing against the photographed-QR threat, and since the
         -- plan is bound to an SA ID, a stranger who scanned a photographed
         -- code still cannot claim it unless their own ID matches.
         expires_at = now() + INTERVAL '1 hour'
   WHERE token      = p_token
     AND stage      = 'created'
     AND expires_at > now();
$$;

GRANT EXECUTE ON FUNCTION stamp_checkout_session_scanned(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION stamp_checkout_session_scanned(TEXT) IS
  'Marks a counter session scanned and moves expires_at to the COMPLETION '
  'window (1 hour). The interval is hardcoded, not a parameter: this '
  'function is anon-callable, so a caller-supplied window would let anyone '
  'mint an arbitrarily long-lived session. Mirrored by '
  'CHECKOUT_COMPLETION_TTL_MS in lib/checkout/sessionTtl.ts.';
