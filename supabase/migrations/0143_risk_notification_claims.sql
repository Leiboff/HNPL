-- ─── Exactly-once notification claims for the risk controls ─────────────
--
-- 0142 records every non-allow decision (risk_events) and every held
-- subject (risk_reviews). This adds the bookkeeping that turns those rows
-- into an email nobody gets twice.
--
-- ─── WHY A CLAIM AND NOT A TIMESTAMP FILTER ─────────────────────────────
--
-- The obvious implementation is "select everything newer than the last run
-- and send it". Two things break it, and both happen:
--
--   • Two overlapping cron invocations — a retry, a manual trigger, a
--     platform double-delivery — both read the same window and both send.
--     Waking an operator twice at 03:00 is how an alert channel gets muted,
--     and a muted channel is worse than no channel.
--   • A send that fails halfway leaves no record of which rows made it out,
--     so the next run either re-sends everything or skips it all.
--
-- So the pattern is a CLAIM: one statement marks the rows as claimed and
-- returns them, under the row locks the UPDATE takes. A second caller
-- racing it gets an empty set rather than a duplicate. Same shape as
-- `runPayoutBatches`'s conditional batch_id claim (0090) and
-- `chargeInstalment`'s payment claim, for the same reason.
--
-- ─── AND WHY THE STAMP IS SET BEFORE THE EMAIL, NOT AFTER ───────────────
--
-- Deliberate, and it is the safer direction of the two. Stamping after a
-- successful send would mean a crash between send and stamp re-sends the
-- batch; stamping first means a crash between stamp and send LOSES that
-- batch's email. Losing one digest is recoverable — the rows are still in
-- risk_events and risk_reviews, still on /admin/risk, and the next digest
-- carries anything new. Duplicating pages is not recoverable, because the
-- cost is paid in whether anyone still reads them.

ALTER TABLE risk_events  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;
ALTER TABLE risk_reviews ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Partial indexes on exactly the claim predicate: the un-notified rows are
-- a tiny, shrinking set against tables that grow, so a full index here
-- would be almost entirely dead weight.
CREATE INDEX IF NOT EXISTS risk_events_unnotified_idx
  ON risk_events (occurred_at)
  WHERE notified_at IS NULL;
CREATE INDEX IF NOT EXISTS risk_reviews_unnotified_idx
  ON risk_reviews (opened_at)
  WHERE notified_at IS NULL;

COMMENT ON COLUMN risk_events.notified_at IS
  'When this decision was included in an operator notification (0143). '
  'NULL = not yet sent. Claimed by claim_risk_notifications, which stamps '
  'and returns in one statement so concurrent senders cannot duplicate.';
COMMENT ON COLUMN risk_reviews.notified_at IS
  'When this review was first included in an operator notification (0143). '
  'Set once, on the row opening — a review that is re-hit bumps hit_count '
  'rather than re-notifying, so a ring hammering one wall produces one '
  'email and not two hundred.';

-- ─── claim_risk_notifications ───────────────────────────────────────────
--
-- Claims and returns everything an operator has not been told about yet:
-- newly opened reviews, non-allow decisions, and the kill switches and
-- exhausted budgets that are current platform state rather than events.
--
-- The last two are NOT claimed, because they are conditions and not
-- occurrences. An engaged kill switch should appear on every digest for as
-- long as it is engaged — that is the point of a digest — whereas a
-- decision should appear once. Claiming a condition would report it the
-- first time and then go quiet while it was still true.
--
-- Returns one JSONB document rather than several result sets so the caller
-- makes one round trip and cannot see a half-claimed state.

CREATE OR REPLACE FUNCTION claim_risk_notifications(
  p_max_reviews INT DEFAULT 100,
  p_max_events  INT DEFAULT 200
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reviews  JSONB;
  v_events   JSONB;
  v_switches JSONB;
  v_budgets  JSONB;
  v_max_rev  INT := LEAST(GREATEST(COALESCE(p_max_reviews, 100), 1), 1000);
  v_max_evt  INT := LEAST(GREATEST(COALESCE(p_max_events, 200), 1), 2000);
  v_today    DATE := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  -- ── Reviews: claim and return ─────────────────────────────────────────
  --
  -- Only rows still open. A review that was opened and decided between two
  -- digests needs no email — somebody already dealt with it, and reporting
  -- it would be asking them to look at their own work.
  WITH claimed AS (
    UPDATE risk_reviews
       SET notified_at = now()
     WHERE id IN (
       SELECT id FROM risk_reviews
        WHERE notified_at IS NULL
          AND state IN ('open', 'in_review')
        ORDER BY score DESC, last_hit_at DESC
        LIMIT v_max_rev
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, event, state, account_id, practice_id, score, hit_count,
              opened_at, reasons
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(claimed) ORDER BY claimed.score DESC), '[]'::jsonb)
    INTO v_reviews FROM claimed;

  -- ── Decisions: claim and return ───────────────────────────────────────
  WITH claimed AS (
    UPDATE risk_events
       SET notified_at = now()
     WHERE id IN (
       SELECT id FROM risk_events
        WHERE notified_at IS NULL
        ORDER BY occurred_at DESC
        LIMIT v_max_evt
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id, event, decision, score, reasons, account_id, practice_id,
              occurred_at
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(claimed) ORDER BY claimed.occurred_at DESC), '[]'::jsonb)
    INTO v_events FROM claimed;

  -- ── Conditions: reported every time, never claimed ────────────────────
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'name', name, 'reason', reason, 'changed_at', changed_at)), '[]'::jsonb)
    INTO v_switches
    FROM risk_kill_switches
   WHERE engaged;

  -- Today's budget usage, so a digest can say "the KYC budget is 90% spent"
  -- before it is exhausted. The limits live in lib/risk/policy.ts, so the
  -- caller compares; this only reports what has been consumed.
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'budget', budget, 'consumed', consumed)), '[]'::jsonb)
    INTO v_budgets
    FROM risk_budget_usage
   WHERE usage_day = v_today;

  RETURN jsonb_build_object(
    'reviews',  v_reviews,
    'events',   v_events,
    'switches', v_switches,
    'budgets',  v_budgets);
END;
$$;

REVOKE ALL ON FUNCTION claim_risk_notifications(INT, INT) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION claim_risk_notifications(INT, INT) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION claim_risk_notifications(INT, INT) IS
  'Claims un-notified risk reviews and decisions in one statement and '
  'returns them with the current kill-switch and budget state (0143). The '
  'claim is what makes the operator digest exactly-once under concurrent '
  'senders. Conditions (switches, budgets) are reported on every call '
  'rather than claimed, because they are state and not occurrences.';

-- ─── Undo a claim ───────────────────────────────────────────────────────
--
-- For the one recoverable failure the ordering above accepts: the rows were
-- stamped and the send then failed outright. Releasing them puts the batch
-- back in the next digest rather than silently dropping it.
--
-- Scoped to ids the caller just claimed, so this cannot be used to force a
-- re-send of the whole history.

CREATE OR REPLACE FUNCTION release_risk_notifications(
  p_review_ids UUID[],
  p_event_ids  UUID[]
) RETURNS JSONB
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_reviews INT := 0;
  v_events  INT := 0;
BEGIN
  IF p_review_ids IS NOT NULL AND array_length(p_review_ids, 1) > 0 THEN
    UPDATE risk_reviews SET notified_at = NULL WHERE id = ANY(p_review_ids);
    GET DIAGNOSTICS v_reviews = ROW_COUNT;
  END IF;
  IF p_event_ids IS NOT NULL AND array_length(p_event_ids, 1) > 0 THEN
    UPDATE risk_events SET notified_at = NULL WHERE id = ANY(p_event_ids);
    GET DIAGNOSTICS v_events = ROW_COUNT;
  END IF;
  RETURN jsonb_build_object('reviews', v_reviews, 'events', v_events);
END;
$$;

REVOKE ALL ON FUNCTION release_risk_notifications(UUID[], UUID[]) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION release_risk_notifications(UUID[], UUID[]) TO service_role;
  END IF;
END $$;

COMMENT ON FUNCTION release_risk_notifications(UUID[], UUID[]) IS
  'Clears notified_at on rows a failed send had already claimed (0143), so '
  'the batch returns to the next digest instead of being lost.';
