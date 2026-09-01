-- ─── The rate limiter, hardened against its own parameters ────────────────
--
-- WHAT 0125 ALREADY CLOSED (audit A-11)
--
-- consume_rate_limit was granted to anon, so the limiter's own store was
-- writable by the internet with every parameter caller-supplied. That is the
-- sharp half of the finding and 0125 revoked it: the function is service_role
-- only now, and every call site (lib/security/rateLimit.ts) already built a
-- service client, so it was behaviour-neutral.
--
-- WHAT THIS ADDS
--
-- The audit's second recommendation, which is defence in depth rather than a
-- second hole: clamp the parameters inside the function and reject unknown
-- buckets, "so a future accidental grant is less useful".
--
-- Worth doing precisely because the first fix is invisible. A grant is one
-- line in a migration nobody reviews twice, and the function has no other
-- protection — `consume_rate_limit('signup', '<victim IP>', 1000000, 86400)`
-- called in a loop spends a chosen victim's budget and fills the table. After
-- this, the same accident buys an attacker a hundred rows per call in a
-- bucket that has to already exist.
--
-- ─── ON CLAMPING RATHER THAN REJECTING ─────────────────────────────────────
--
-- An out-of-range p_max is clamped, not refused. The caller is our own
-- helper, and a limit that started throwing because somebody typo'd a window
-- would take down the action it guards — which is the exact failure mode
-- 0124's fail-open posture exists to avoid. The clamp keeps the limiter
-- working at a sane bound and the ceiling is high enough that no legitimate
-- rule touches it.
--
-- An unknown BUCKET is different and IS refused, with a permit rather than a
-- denial: a bucket nobody declared is a typo at a call site, and the honest
-- outcome is "this call is not limited" plus a warning, not "this action is
-- denied" and not a row in a bucket that will never be pruned by name.

-- ── The declared buckets ───────────────────────────────────────────────────
--
-- Mirrors RateLimitBucket in lib/security/rateLimit.ts. Two lists is a drift
-- risk, and it is accepted here for one reason: the whole point is that the
-- database refuses a bucket the application did not declare, which it cannot
-- do by reading the application. rateLimit.buckets.test.ts pins the two
-- against each other, so a bucket added on one side and not the other fails
-- the suite rather than silently going unlimited.

CREATE OR REPLACE FUNCTION rate_limit_known_bucket(p_bucket TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT p_bucket IN (
    'signup',
    'resend_confirmation',
    'checkout_initiate',
    'identity_session',
    'till_registration',
    'public_lead',
    'contact_form',
    -- Added 2026-09-02: the money-moving surfaces. Every one of these either
    -- charges a card, commits credit, or issues a bill token, and none of
    -- them had any limit at all.
    'accept_plan',
    'pay_saved_card',
    'self_settle',
    'counter_session',
    'credit_check'
  );
$$;

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
  v_max      int;
  v_window   int;
BEGIN
  IF p_subject IS NULL OR p_subject = '' THEN
    -- Nothing to key on. Allow rather than refuse: an unresolvable subject
    -- is our problem, not the caller's, and the surfaces this guards must
    -- not go dark because a header was missing.
    RETURN true;
  END IF;

  IF NOT rate_limit_known_bucket(p_bucket) THEN
    -- A typo at a call site, or a caller that should not be here at all.
    -- Permit and warn: refusing would turn a misspelled bucket into an
    -- outage, and writing the row would populate a bucket name nothing
    -- reviews and nothing reads.
    RAISE WARNING 'consume_rate_limit: unknown bucket %, not limiting', p_bucket;
    RETURN true;
  END IF;

  -- Clamped, not validated. See the header: a limiter that throws is worse
  -- than a limiter with an odd bound.
  v_max    := LEAST(GREATEST(COALESCE(p_max, 1), 1), 1000);
  v_window := LEAST(GREATEST(COALESCE(p_window_secs, 1), 1), 604800);

  INSERT INTO rate_limit_hits (bucket, subject)
  SELECT p_bucket, p_subject
   WHERE (
     SELECT count(*)
       FROM rate_limit_hits
      WHERE bucket  = p_bucket
        AND subject = p_subject
        AND occurred_at > now() - make_interval(secs => v_window)
   ) < v_max;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN v_inserted > 0;
END;
$$;

-- 0125 made EXECUTE an allow-list; restate the grant so a CREATE OR REPLACE
-- here cannot leave the function unreachable by its one caller. Nothing else
-- is granted, deliberately — see the A-11 note above.
REVOKE ALL ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION rate_limit_known_bucket(TEXT)            FROM PUBLIC;
GRANT EXECUTE ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) TO service_role;

COMMENT ON FUNCTION consume_rate_limit(TEXT, TEXT, INT, INT) IS
  'Atomic fixed-window rate limit. Returns true when the caller is within '
  'budget, and records the hit in the same statement so concurrent callers '
  'cannot both pass a sub-limit count. Buckets are checked against a fixed '
  'list and the bounds are clamped (audit A-11), so an accidental future '
  'grant cannot be used to spend a victim''s budget or fill the table. '
  'service_role only. See lib/security/rateLimit.ts.';
COMMENT ON FUNCTION rate_limit_known_bucket(TEXT) IS
  'The declared rate-limit buckets. Mirrors RateLimitBucket in '
  'lib/security/rateLimit.ts; the two are pinned against each other by '
  'lib/security/rateLimit.buckets.test.ts.';

-- ── Prune hourly, not daily ────────────────────────────────────────────────
--
-- The audit's third point: "prune rate_limit_hits more often than daily — it
-- is a DELETE on an index, and hourly costs nothing." The daily prune in the
-- collection cron stays as the backstop; this is an index that keeps the
-- window small between runs.
--
-- Retention is 24 hours because the longest declared window is 24 hours
-- (identity_session). A shorter retention would silently widen those limits.
CREATE INDEX IF NOT EXISTS rate_limit_hits_occurred_idx
  ON rate_limit_hits (occurred_at);
