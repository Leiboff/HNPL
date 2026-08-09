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
-- SCOPE OF THIS MIGRATION
--   Table + the token-lookup RPC + the scanned-stamp RPC (mirrors
--   stamp_invitation_viewed from migration 0050) only. NOT included here
--   (deliberately, out of scope for this PR):
--     • till_device_id / device auth — no till_devices table exists yet.
--     • realtime publication membership — the multi-session board is a
--       separate PR; adding this table to supabase_realtime belongs with
--       that feature, not before it has a reader.
--     • confirm-at-counter columns — separate PR.

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
  expires_at   TIMESTAMPTZ NOT NULL
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

-- ── Token lookup RPC ────────────────────────────────────────────────────
-- Sibling to get_invitation_by_token (migration 0049): returns a single
-- row only when the session is non-expired and not yet completed/
-- declined. No email (none exists for this path). sa_id_number is
-- returned ENCRYPTED — the caller (a Next.js Server Component running
-- server-side only) decrypts + masks it before any value reaches a
-- client-rendered prop; this function never exposes plaintext.
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
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
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
  'otherwise. sa_id_number is returned encrypted, never plaintext.';

-- ── Scanned stamp RPC ───────────────────────────────────────────────────
-- Fire-and-forget stamp on first successful load, mirroring
-- stamp_invitation_viewed (migration 0050). Idempotent — only advances
-- stage from 'created' to 'scanned'; a re-load after scanning is a no-op.
CREATE OR REPLACE FUNCTION stamp_checkout_session_scanned(p_token TEXT)
RETURNS VOID
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
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
  'that point.';
