-- ─── payout_batches: weekly settlement batching ───────────────────────────
--
-- WHY THIS EXISTS
-- ───────────────
-- Until now a practice's settlement was plan-by-plan: activateFirstInstalment
-- inserts one payouts row per plan (full plan net, upfront — BetterNow carries
-- the patient credit risk), and a platform admin flipped each row to 'paid'
-- individually in /admin/payouts while moving the money by EFT outside the app.
--
-- That is unreconcilable for the practice. A merchant checking a deposit
-- against their bank statement needs a bounded set: "this deposit is exactly
-- these plans, activated between these two instants". A pile of independently
-- flipped rows can't answer that.
--
-- So settlement becomes weekly and bounded:
--   • One batch per practice per week, closed automatically early Thursday
--     morning SAST — as soon as the window has shut and nothing is left to
--     wait for.
--   • Covering plans ACTIVATED Thursday 00:00:00 → Wednesday 23:59:59 SAST.
--   • Paid on the Friday. Settlement itself stays a human action — this table
--     automates the BATCHING and the WINDOW, not the bank transfer, and the
--     closing of one week's batch never depends on a previous one having been
--     marked paid.
--
-- The model is unchanged and deliberately so: payouts stays ONE ROW PER PLAN
-- (payouts.plan_id UNIQUE, migration 0087), activateFirstInstalment stays its
-- only creator, and instalments 2..N produce no payout activity. Batching is
-- a grouping layer over existing rows, not a new source of them.
--
-- WINDOW REPRESENTATION
-- ─────────────────────
-- window_start / window_end are TIMESTAMPTZ instants, stored as the UTC
-- equivalents of Thursday 00:00:00 SAST. The interval is HALF-OPEN:
-- [window_start, window_end). That is how "through Wednesday 23:59:59" is
-- pinned without depending on whether the last representable instant is
-- .999 or .999999 — Thursday 00:00:00 SAST belongs to the NEXT window, full
-- stop. SAST is UTC+2 year-round with no DST, so the offset is a constant,
-- but the boundary is still computed from an explicit +02:00 offset rather
-- than left implicit in UTC arithmetic (see lib/payments/payoutWindow.ts).
--
-- IDEMPOTENCY — enforced HERE, not in application logic
-- ─────────────────────────────────────────────────────
-- 0087 exists because an app-level check-then-insert guard lost a race
-- between two concurrent serverless invocations. The same discipline applies
-- to batching, via two independent DB-level guarantees:
--
--   1. "A payouts row belongs to at most ONE batch" — payouts.batch_id is a
--      single nullable FK column. A row physically cannot hold two batch ids.
--      This is why membership is a column and not a payout_batch_items join
--      table: a join table would need its own UNIQUE(payout_id) to say the
--      same thing, and would let a bug insert a second membership row first
--      and fail second. Here the impossible state is unrepresentable.
--
--   2. "At most one batch per practice per window" — UNIQUE (practice_id,
--      window_start). A duplicate batch row is a constraint violation, not a
--      logic error, so a re-run or a concurrent invocation cannot create one.
--
-- Membership itself is claimed by an atomic conditional UPDATE
-- (SET batch_id = $1 WHERE batch_id IS NULL AND ...), the same atomic-claim
-- pattern lib/payments/chargeInstalment.ts uses: under READ COMMITTED the
-- loser of a race re-evaluates the predicate after the winner commits, sees
-- a non-null batch_id and skips the row. No advisory locks, no app-level
-- mutual exclusion.

CREATE TABLE IF NOT EXISTS payout_batches (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  practice_id   UUID          NOT NULL REFERENCES practices(id),

  -- Inclusive start / EXCLUSIVE end. Both are Thursday 00:00:00 SAST.
  window_start  TIMESTAMPTZ   NOT NULL,
  window_end    TIMESTAMPTZ   NOT NULL,

  -- Sum of payouts.net_amount over the batch's members, and how many plans
  -- that is. Denormalised deliberately: the practice-facing figure must be
  -- the number that was true when the batch closed. payouts.net_amount was
  -- itself computed from practices.fee_percent at activation time, so a
  -- later commission change cannot retroactively move a settled batch.
  total_net     NUMERIC(12,2) NOT NULL DEFAULT 0,
  plan_count    INTEGER       NOT NULL DEFAULT 0,

  -- 'pending' = batched, awaiting the EFT. 'paid' = admin has confirmed the
  -- transfer left. Deliberately only two states: there is no in-app bank
  -- integration to report 'processing' or 'failed' from.
  status        TEXT          NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid')),

  run_at        TIMESTAMPTZ   NOT NULL DEFAULT now(),
  paid_at       TIMESTAMPTZ,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),

  -- Guarantee 2 above. window_start alone identifies the window because
  -- window_end is always exactly 7 days after it.
  CONSTRAINT payout_batches_practice_window_key UNIQUE (practice_id, window_start),

  -- A batch cannot be marked paid without a timestamp, and cannot carry one
  -- while pending — otherwise "paid" and "when" could disagree, which is the
  -- kind of drift that makes a reconciliation surface untrustworthy.
  CONSTRAINT payout_batches_paid_at_consistent CHECK (
    (status = 'paid' AND paid_at IS NOT NULL) OR
    (status = 'pending' AND paid_at IS NULL)
  ),

  CONSTRAINT payout_batches_window_ordered CHECK (window_end > window_start)
);

CREATE INDEX IF NOT EXISTS payout_batches_practice_idx
  ON payout_batches (practice_id, window_start DESC);

CREATE INDEX IF NOT EXISTS payout_batches_status_idx
  ON payout_batches (status, window_start DESC);

-- ── payouts.batch_id — guarantee 1 above ────────────────────────────────
ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES payout_batches(id);

CREATE INDEX IF NOT EXISTS payouts_batch_idx
  ON payouts (batch_id);

-- The runner's hot query: unbatched pending rows for a practice inside a
-- window. Partial index — batched rows are the overwhelming majority over
-- time and are never scanned by the claim.
CREATE INDEX IF NOT EXISTS payouts_unbatched_claim_idx
  ON payouts (practice_id, created_at)
  WHERE batch_id IS NULL AND status = 'pending';

-- ── RLS ─────────────────────────────────────────────────────────────────
--
-- Mirrors the existing access surface on payouts (0002 + 0061): platform
-- admins have full access; a practice's own members and the brand-admins of
-- its group can read their practice's batches. There is no INSERT/UPDATE
-- policy for practice-side callers at all — the runner writes via the
-- service-role client (which bypasses RLS) and mark-paid is a platform-admin
-- server action. A practice must never be able to mark its own money paid.

ALTER TABLE payout_batches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admins_all_payout_batches" ON payout_batches;
CREATE POLICY "admins_all_payout_batches"
  ON payout_batches
  FOR ALL
  USING (is_platform_admin())
  WITH CHECK (is_platform_admin());

DROP POLICY IF EXISTS "practice_members_select_payout_batches" ON payout_batches;
CREATE POLICY "practice_members_select_payout_batches"
  ON payout_batches
  FOR SELECT
  USING (is_practice_member(practice_id));

DROP POLICY IF EXISTS "brand_admin_select_payout_batches" ON payout_batches;
CREATE POLICY "brand_admin_select_payout_batches"
  ON payout_batches
  FOR SELECT
  USING (is_brand_admin_of_practice(practice_id));

-- ── Comments ────────────────────────────────────────────────────────────
COMMENT ON TABLE payout_batches IS
  'One row per practice per weekly settlement window. Groups payouts rows so a practice can reconcile a single bank deposit against an exact, bounded set of activated plans. Does not move money — settlement stays a platform-admin action.';
COMMENT ON COLUMN payout_batches.window_start IS
  'Thursday 00:00:00 SAST, INCLUSIVE. Stored as the equivalent UTC instant.';
COMMENT ON COLUMN payout_batches.window_end IS
  'The following Thursday 00:00:00 SAST, EXCLUSIVE — i.e. through Wednesday 23:59:59.999… SAST. Half-open so the boundary needs no millisecond reasoning.';
COMMENT ON COLUMN payout_batches.total_net IS
  'SUM of member payouts.net_amount. Never recomputed from fee_percent — the fee was captured per plan at activation.';
COMMENT ON COLUMN payouts.batch_id IS
  'The weekly settlement batch this payout was claimed into, or NULL if not yet batched. A single column BY DESIGN: it makes "in two batches at once" unrepresentable rather than merely forbidden.';
