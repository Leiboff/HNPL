-- ─── The identity signal ledger: making a ring visible at all ───────────
--
-- WHAT IS MISSING TODAY
--
-- The identity stack (0102 Didit, 0103 DHA, 0104 provenance) verifies one
-- applicant at a time and writes the result onto that applicant's own
-- profile row. Ask it "is this person real?" and it answers well. Ask it
-- "did these nine people arrive on one handset inside an hour?" and there
-- is no table that could hold the answer — every signal that would show it
-- is discarded the moment the request ends.
--
-- That is the entire gap. Against rented-identity rings (see the header of
-- lib/security/identityGraph.ts for why per-applicant verification cannot
-- see them by construction), correlation is the only control that works,
-- and correlation needs history.
--
-- This migration adds that history, and nothing else. It makes no
-- decision: identity_signals is an append-only ledger, and every judgement
-- about what a link means lives in the pure TypeScript that reads it.
--
-- ─── WHY THIS IS NOT A SURVEILLANCE TABLE ──────────────────────────────
--
-- The obvious implementation of this idea stores IPs, User-Agents and
-- phone numbers beside a user id. That table would be a POPIA liability
-- and a more attractive breach target than the credit data it protects —
-- it would reconstruct, for every patient, where they were and on what
-- device, every time they touched a healthcare product. We would be
-- holding a movement log of sick people.
--
-- So `signal_hash` is an HMAC-SHA256 under CORRELATION_HMAC_KEY, computed
-- in the application (lib/security/correlationKeys.ts), exactly as
-- profiles.sa_id_lookup_hash already handles SA ID numbers. The database
-- never sees an IP, a device or a number — only opaque 64-hex values that
-- are equal when the underlying values were equal.
--
-- The property that makes this safe rather than merely obscured: without
-- the key, a stolen ledger cannot be reversed even for a small domain. A
-- bare SHA-256 of an IPv4 address is a 2^32 brute-force — minutes of GPU.
-- Keyed, it is not attackable at all. The key must therefore live only in
-- the application environment and never in the database.
--
-- ─── WHY IDENTITY AND NOT ACCOUNT ──────────────────────────────────────
--
-- Rows carry `identity_hash` — profiles.sa_id_lookup_hash, the blind index
-- from 0096 — as well as `profile_id`. The counting in
-- count_identity_links is over DISTINCT identity_hash, deliberately:
--
--   • counting profiles would let one real patient with three abandoned
--     signups look like a three-person ring;
--   • counting rows would let one patient who reconnects each morning look
--     like a hundred.
--
-- identity_hash is NULL until a patient completes verification, and rows
-- with a NULL identity are excluded from every count. An unverified signup
-- can therefore contribute signals to its OWN later assessment but can
-- never inflate anyone else's — which is what stops the ledger from being
-- usable to frame a competitor's customers by spraying signups.
--
-- ─── RETENTION ─────────────────────────────────────────────────────────
--
-- Purpose-limited data with a fixed life. delete_expired_identity_signals
-- is the same shape as 0124's rate-limit reaper and is meant to run on the
-- same schedule. 180 days is chosen against the fraud pattern rather than
-- rounded: a rented-identity ring works through its stack in days to
-- weeks, and a signal older than a couple of quarters has no bearing on
-- whether today's applicant is part of one.

CREATE TABLE IF NOT EXISTS identity_signals (
  id            BIGSERIAL   PRIMARY KEY,

  -- Which account produced this signal. Kept for investigation and for the
  -- self-exclusion the RPC performs; NOT what links are counted over.
  profile_id    UUID        REFERENCES profiles(id) ON DELETE CASCADE,

  -- profiles.sa_id_lookup_hash at the time of writing, or NULL when the
  -- account has not completed identity verification. See above for why
  -- NULL rows are counted for nobody.
  identity_hash TEXT,

  -- 'device' | 'ip' | 'subnet' | 'email' | 'phone' | 'card'.
  -- Constrained rather than free text: an unknown kind here would be
  -- silently uncounted by the RPC, which is the kind of failure that looks
  -- like "the control is working" for months.
  kind          TEXT        NOT NULL
    CHECK (kind IN ('device', 'ip', 'subnet', 'email', 'phone', 'card')),

  -- The keyed blind index. Never a raw value. 64 hex chars from SHA-256;
  -- the length check is a cheap guard against a caller that skipped the
  -- HMAC and wrote a plaintext IP straight in.
  signal_hash   TEXT        NOT NULL
    CHECK (signal_hash ~ '^[0-9a-f]{64}$'),

  -- Where the signal was observed: 'signup', 'identity', 'checkout',
  -- 'accept_plan'. Free text on purpose — surfaces get added often and a
  -- CHECK here would turn a new call site into a runtime error on a path
  -- that must never break a customer's signup.
  surface       TEXT,

  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query shape the RPC issues: given (kind, signal_hash), find the
-- distinct identities on it, optionally since a cutoff.
CREATE INDEX IF NOT EXISTS identity_signals_lookup_idx
  ON identity_signals (kind, signal_hash, occurred_at DESC);

-- For investigation ("everything this account touched") and for the
-- ON DELETE CASCADE to be cheap.
CREATE INDEX IF NOT EXISTS identity_signals_profile_idx
  ON identity_signals (profile_id, occurred_at DESC);

ALTER TABLE identity_signals ENABLE ROW LEVEL SECURITY;

-- No policies, exactly as rate_limit_hits (0124). Nothing reaches this
-- table except the SECURITY DEFINER functions below and the service role.
-- A patient must not be able to read it: the counts are a fraud control,
-- and an attacker who can query "how many identities share my device"
-- gets a free oracle for tuning their ring under the threshold.

-- ─── record_identity_signal ────────────────────────────────────────────
--
-- Append one observation. Returns nothing and raises nothing the caller
-- needs to handle.
--
-- FAIL-OPEN, DELIBERATELY, LIKE 0124's LIMITER
--
-- This sits on the signup and checkout paths. A ledger that is unwritable
-- must degrade to "we learn nothing from this request", never to "this
-- patient cannot sign up" — the outage it would cause is worse and far
-- more likely than the fraud it would prevent. The exception handler is
-- the whole point of the function.
CREATE OR REPLACE FUNCTION record_identity_signal(
  p_profile_id    UUID,
  p_identity_hash TEXT,
  p_kind          TEXT,
  p_signal_hash   TEXT,
  p_surface       TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO identity_signals (profile_id, identity_hash, kind, signal_hash, surface)
  VALUES (p_profile_id, p_identity_hash, p_kind, p_signal_hash, p_surface);
EXCEPTION WHEN OTHERS THEN
  -- Includes the CHECK violations above. A malformed signal is dropped and
  -- the request continues; correctness of the ledger is never worth a
  -- failed signup.
  RETURN;
END;
$$;

-- ─── count_identity_links ──────────────────────────────────────────────
--
-- For each (kind, signal_hash) the caller presents, how many OTHER
-- distinct verified identities stand on it, and how many of those first
-- appeared inside the recency window.
--
-- The two counts are returned together, from one pass, because
-- identityGraph.ts needs both for the same key and issuing them as
-- separate round trips would let them disagree.
--
-- EXCLUDING THE APPLICANT IS THE CALLER'S DECISION MADE HERE
--
-- p_identity_hash is the applicant's own identity, and every count below
-- excludes it. Leaving that to the caller was the alternative and is
-- worse: forgetting it produces an off-by-one that reads as "one other
-- person is on your device" for every patient in the system, which is
-- both wrong and exactly the kind of wrong that survives review because
-- the number looks plausible.
--
-- NULL identity_hash rows are excluded throughout — an unverified account
-- is nobody, and must not be countable toward anyone else's ring.
CREATE OR REPLACE FUNCTION count_identity_links(
  p_identity_hash TEXT,
  p_kinds         TEXT[],
  p_hashes        TEXT[],
  p_recent_hours  INT DEFAULT 24
)
RETURNS TABLE (kind TEXT, distinct_identities INT, recent_identities INT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH probes AS (
    SELECT u.kind, u.signal_hash
    FROM unnest(p_kinds, p_hashes) AS u(kind, signal_hash)
  )
  SELECT
    p.kind,
    COUNT(DISTINCT s.identity_hash)::INT AS distinct_identities,
    COUNT(DISTINCT s.identity_hash) FILTER (
      WHERE s.occurred_at >= now() - make_interval(hours => GREATEST(p_recent_hours, 0))
    )::INT AS recent_identities
  FROM probes p
  LEFT JOIN identity_signals s
    ON  s.kind          = p.kind
    AND s.signal_hash   = p.signal_hash
    AND s.identity_hash IS NOT NULL
    AND s.identity_hash IS DISTINCT FROM p_identity_hash
  GROUP BY p.kind;
$$;

-- ─── delete_expired_identity_signals ───────────────────────────────────
--
-- Retention, same shape as 0124's reaper.
CREATE OR REPLACE FUNCTION delete_expired_identity_signals(p_retain_days INT DEFAULT 180)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  removed INT;
BEGIN
  DELETE FROM identity_signals
  WHERE occurred_at < now() - make_interval(days => GREATEST(p_retain_days, 1));
  GET DIAGNOSTICS removed = ROW_COUNT;
  RETURN removed;
END;
$$;

-- ─── Privileges ────────────────────────────────────────────────────────
--
-- service_role only, for all three. This is the difference from 0124,
-- where consume_rate_limit is granted to anon/authenticated because the
-- limiter must work on the anonymous signup path before any session
-- exists.
--
-- Nothing here is reachable from a browser session. Every call site runs
-- in a Server Action or route handler holding the service key, and
-- count_identity_links in particular must NOT be exposed: it answers "how
-- many identities share this key", which in an attacker's hands is a
-- tuning oracle for keeping a ring one identity under every threshold.
REVOKE ALL ON FUNCTION record_identity_signal(UUID, TEXT, TEXT, TEXT, TEXT)  FROM PUBLIC;
REVOKE ALL ON FUNCTION count_identity_links(TEXT, TEXT[], TEXT[], INT)       FROM PUBLIC;
REVOKE ALL ON FUNCTION delete_expired_identity_signals(INT)                  FROM PUBLIC;

GRANT EXECUTE ON FUNCTION record_identity_signal(UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION count_identity_links(TEXT, TEXT[], TEXT[], INT)      TO service_role;
GRANT EXECUTE ON FUNCTION delete_expired_identity_signals(INT)                 TO service_role;

COMMENT ON TABLE identity_signals IS
  'Append-only, keyed-hash ledger of correlation signals (device/ip/subnet/email/phone/card). '
  'Holds no raw values — signal_hash is HMAC-SHA256 under CORRELATION_HMAC_KEY. '
  'Read only via count_identity_links; see lib/security/identityGraph.ts for what links mean.';
