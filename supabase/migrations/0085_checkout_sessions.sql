-- ─── POS counter checkout sessions ──────────────────────────────────────────
--
-- BACKGROUND
--   The existing bill-issuance spine (patient_invitations, migration 0021/
--   0049) is built around "email is proof of inbox control" — a 7-day
--   token emailed to the patient. The POS/counter checkout flow issues a
--   bill from a teller-entered SA ID number instead of an email, rendered
--   as an on-screen QR with a short (~2 min) TTL. Overloading
--   patient_invitations with these two very different identity/TTL models
--   would mean relaxing its `email NOT NULL` contract and bolting on
--   session-stage tracking it was never designed for — see the practice-
--   bill-POS-checkout investigation for the full reasoning.
--
--   checkout_sessions is deliberately separate. It mirrors
--   patient_invitations' shape (token, plan_id, practice_id, expires_at)
--   but carries the SA ID (encrypted, same AES-256-GCM as
--   profiles.sa_id_number) instead of an email, and a `stage` column the
--   patient_invitations model never needed.
--
-- SECURITY / POPIA
--   The SA ID is written here ONCE, immediately, by the till's
--   issueCounterSession server action, and never returned back to the
--   till/reception client — the till only ever sees the QR token + a
--   generic "session created" confirmation. Reads of this table are
--   scoped to practice billers (is_practice_biller, migration 0035); the
--   only anon-reachable surface is the token-scoped RPC below, mirroring
--   get_invitation_by_token's closed-surface pattern from migration 0049.
--
-- SCOPE OF THIS MIGRATION (amended in place — see below; this table has
-- never shipped anywhere, so amending beats layering incremental ALTERs
-- on a not-yet-live table)
--   Table + token-lookup RPC + scanned-stamp RPC + the first-timer
--   hard-stop expiry function + confirm-at-counter columns. NOT included
--   here (deliberately, still out of scope):
--     • till_device_id / device auth — no till_devices table exists yet.
--     • realtime publication membership — the multi-session board is a
--       separate PR; adding this table to supabase_realtime belongs with
--       that feature, not before it has a reader.
--
-- AMENDMENT — first-timer hard-stop (expire_stale_checkout_session)
--   Locked requirement: an incomplete/abandoned session must NOT leave
--   its plan sitting as a pending off-site bill. expire_stale_checkout_
--   session(p_token, p_force) is the single canonical transition:
--   session -> stage='expired', plan -> status='declined' (reusing the
--   EXISTING declined status/semantics from app/patient/actions.ts's
--   declinePlan — see lib/patient/planBucket.ts's "no plan, no money
--   taken" — NOT a new parallel state). declinePlan itself isn't called
--   directly: it's patient-session-authenticated and scoped to
--   status='pending_acceptance' only, neither of which fits a system-
--   triggered close on a plan that may have no patient_id yet, or that
--   may already be at 'pending_first_payment' (scanned but abandoned
--   mid-capture).
--
--   p_force=false (the lazy fail-safe path, called from every read site
--   below) only acts once expires_at has actually passed. p_force=true
--   (the till's explicit "Start next patient" abandonment) acts
--   immediately regardless of the clock — a teller moving on IS
--   abandonment, independent of whether the 2-minute timer has run out.
--   Both paths lock the plan row (FOR UPDATE) before deciding, so a
--   concurrent activateFirstInstalment can never race with this function
--   — completion always wins (if the plan already left pending_
--   acceptance/pending_first_payment, this is a no-op).
--
--   Wired into every meaningful "next touch" of a token so a session can
--   never be silently left dangling even if the till's own prompt calls
--   are missed (dropped request, closed tab): get_checkout_session_by_
--   token and stamp_checkout_session_scanned both call it first now
--   (both therefore VOLATILE, not STABLE); the app-side resolveCheckoutToken
--   (app/checkout/[token]/actions.ts) calls it too.
--
-- AMENDMENT — confirm-at-counter (confirmed_by / confirmed_at)
--   The teller's own acknowledgment of a completed session, separate
--   from and after the patient's own automatic payment confirmation.
--   See app/practice/pos/actions.ts's acknowledgeCounterSession.

CREATE TABLE IF NOT EXISTS checkout_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  token        TEXT        UNIQUE NOT NULL,
  practice_id  UUID        NOT NULL REFERENCES practices(id),
  plan_id      UUID        NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  -- Encrypted (lib/idEncryption.ts encryptId — same v1:iv:tag:ciphertext
  -- format as profiles.sa_id_number). Never selected by any anon-facing
  -- policy or RPC in plaintext.
  sa_id_number TEXT        NOT NULL,
  cell_e164    TEXT,
  stage        TEXT        NOT NULL DEFAULT 'created'
                 CHECK (stage IN ('created', 'scanned', 'completed', 'declined', 'expired')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  scanned_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  -- Teller's own acknowledgment of a completed session — separate from,
  -- and after, the patient's automatic payment confirmation. Only
  -- settable via acknowledgeCounterSession (app/practice/pos/actions.ts)
  -- on a session already in stage='completed'.
  confirmed_by UUID        REFERENCES profiles(id),
  confirmed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS checkout_sessions_token_idx       ON checkout_sessions(token);
CREATE INDEX IF NOT EXISTS checkout_sessions_practice_id_idx ON checkout_sessions(practice_id);

ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY;

-- Practice billers can see their own practice's sessions (till UI +,
-- later, the multi-session board). No anon/authenticated-patient policy —
-- the token RPC below is the only anon-reachable surface, matching
-- patient_invitations' posture post-0049.
CREATE POLICY "practice_biller_select_checkout_sessions"
  ON checkout_sessions FOR SELECT
  USING (is_practice_biller(practice_id));

-- Inserts/updates happen exclusively via server actions running with the
-- service-role client (issueCounterSession, the checkout completion
-- route) — no INSERT/UPDATE policy is granted to anon or authenticated.

-- ── First-timer hard-stop: the canonical expire/decline transition ─────
-- See the AMENDMENT comment at the top of this file for the full
-- reasoning. Locks BOTH the session and plan rows (FOR UPDATE) before
-- deciding, so a concurrent activateFirstInstalment (which flips
-- plans.status via its own UPDATE ... WHERE status = ...) can never
-- interleave with this decision — a plan that already left pending_
-- acceptance/pending_first_payment (i.e. completed, or already
-- declined/cancelled some other way) is never touched.
--
-- p_force=false: only acts once expires_at has actually passed (the
-- lazy fail-safe path — called from every read site in this file).
-- p_force=true: acts immediately regardless of the clock (the till's
-- explicit "Start next patient" abandonment — moving on IS abandonment,
-- independent of the timer).
--
-- Not anon/authenticated-executable — this makes a real state change
-- (declines a plan). The only callers are: (1) nested calls from the
-- SECURITY DEFINER functions below, which run under this function's
-- own definer privileges regardless of grants, and (2) app/practice/
-- pos/actions.ts's expireCounterSession, which calls it via the
-- service-role client after its own practice-membership check —
-- authorization lives in that check, not in a broad RPC grant.
CREATE OR REPLACE FUNCTION expire_stale_checkout_session(
  p_token TEXT,
  p_force BOOLEAN DEFAULT false
) RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_session     checkout_sessions%ROWTYPE;
  v_plan_status TEXT;
BEGIN
  SELECT * INTO v_session FROM checkout_sessions WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Already terminal — completion (or a prior decline/expiry) wins.
  IF v_session.stage NOT IN ('created', 'scanned') THEN
    RETURN;
  END IF;

  IF NOT p_force AND v_session.expires_at > now() THEN
    RETURN;
  END IF;

  SELECT status INTO v_plan_status FROM plans WHERE id = v_session.plan_id FOR UPDATE;

  IF v_plan_status IN ('pending_acceptance', 'pending_first_payment') THEN
    UPDATE plans            SET status = 'declined' WHERE id = v_session.plan_id;
    UPDATE checkout_sessions SET stage  = 'expired'  WHERE id = v_session.id;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION expire_stale_checkout_session(TEXT, BOOLEAN) TO service_role;

COMMENT ON FUNCTION expire_stale_checkout_session(TEXT, BOOLEAN) IS
  'First-timer hard-stop: declines the plan (reusing the existing '
  'declined status) and stamps checkout_sessions.stage=''expired'' when a '
  'session is abandoned — either because expires_at has passed '
  '(p_force=false, the lazy fail-safe) or because the till explicitly '
  'moved on via "Start next patient" (p_force=true). Row-locks the plan '
  'before deciding so a concurrent activateFirstInstalment always wins. '
  'Not anon/authenticated-executable — see the callers listed above this '
  'function for the authorization boundary.';

-- ── Token lookup RPC ────────────────────────────────────────────────────
-- Sibling to get_invitation_by_token (migration 0049): returns a single
-- row only when the session is non-expired and not yet completed/
-- declined. No email (none exists for this path). sa_id_number is
-- returned ENCRYPTED — the caller (a Next.js Server Component running
-- server-side only) decrypts + masks it before any value reaches a
-- client-rendered prop; this function never exposes plaintext.
--
-- Calls expire_stale_checkout_session first (the lazy fail-safe) so a
-- session nobody ever explicitly closed still promptly declines its
-- plan the moment anyone next touches this token — hence VOLATILE, not
-- STABLE, now. The fail-safe call doesn't change what this SELECT
-- returns (an expired session was already excluded by the WHERE clause
-- below); it closes the associated PLAN, which the SELECT alone never did.
CREATE OR REPLACE FUNCTION get_checkout_session_by_token(p_token TEXT)
RETURNS TABLE (
  plan_id            UUID,
  practice_name      TEXT,
  plan_total_amount  NUMERIC,
  invoice_number     TEXT,
  practice_reference TEXT,
  sa_id_number       TEXT
)
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT expire_stale_checkout_session(p_token);

  SELECT
    pl.id               AS plan_id,
    p.name              AS practice_name,
    pl.total_amount     AS plan_total_amount,
    pl.invoice_number,
    pl.practice_reference,
    cs.sa_id_number
  FROM checkout_sessions cs
  JOIN plans     pl ON pl.id = cs.plan_id
  JOIN practices p  ON p.id  = cs.practice_id
  WHERE cs.token = p_token
    AND cs.stage IN ('created', 'scanned')
    AND cs.expires_at > now()
    AND pl.status NOT IN ('completed', 'cancelled', 'declined')
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_checkout_session_by_token(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION get_checkout_session_by_token(TEXT) IS
  'Exact-token lookup for the anonymous /checkout/[token] page when the '
  'token is a POS counter session rather than an emailed invitation. '
  'Returns a single row for a session that is non-expired AND still in '
  'created/scanned stage AND whose plan is still acceptable; empty '
  'otherwise. sa_id_number is returned encrypted, never plaintext. Calls '
  'expire_stale_checkout_session first as a lazy fail-safe (see that '
  'function''s comment).';

-- ── Scanned stamp RPC ───────────────────────────────────────────────────
-- Fire-and-forget stamp on first successful load, mirroring
-- stamp_invitation_viewed (migration 0050). Idempotent — only advances
-- stage from 'created' to 'scanned'; a re-load after scanning is a no-op.
-- Also calls the lazy fail-safe first, same reasoning as the lookup RPC
-- above — a re-load of an already-expired token should promptly decline
-- its plan too, not just silently fail to advance the stage.
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
         scanned_at = now()
   WHERE token      = p_token
     AND stage      = 'created'
     AND expires_at > now();
$$;

GRANT EXECUTE ON FUNCTION stamp_checkout_session_scanned(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION stamp_checkout_session_scanned(TEXT) IS
  'Fire-and-forget stage advance created -> scanned on first load of '
  '/checkout/[token] for a POS session token. Idempotent (no-op once '
  'scanned or expired). Anon-callable: the patient is unauthenticated at '
  'that point. Calls expire_stale_checkout_session first as a lazy '
  'fail-safe.';
