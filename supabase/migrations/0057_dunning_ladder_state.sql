-- ─── Failed-instalment dunning ladder — state schema ────────────────────
--
-- Adds the columns + status + event-types that drive the recovery flow
-- described in lib/payments/dunning.ts. Mechanic in one sentence:
--
--   Two attempts per pair (~1 day apart); pairs ~6 days apart; a flat
--   R100 fee attaches on every SECOND consecutive failed attempt and
--   resets the "consecutive fails since last fee" counter; the ladder
--   caps at min(R300, 50% of original bill); cap-hit → terminal
--   `defaulted` (debt still owed, still self-settleable, flagged for
--   admin/collections).
--
-- This migration ONLY changes schema shape. The runtime logic lives in
-- lib/payments/dunning.ts and is exercised from
--   • app/api/webhooks/paystack/route.ts  (charge.failed advances the ladder)
--   • app/api/cron/collect-instalments/route.ts  (selects by next_attempt_date)
--   • lib/payments/selfSettleInstalment.ts       (patient-initiated charge,
--                                                  shares the atomic claim)

-- ── 1. payments — ladder state columns ──────────────────────────────────

-- "Consecutive failed attempts SINCE the last fee was applied". Resets
-- to 0 when a fee attaches. The 2-fails-per-fee rule reads as:
-- after a failure, if (counter+1 >= 2) → apply fee + reset to 0.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS consecutive_failed_attempts INTEGER NOT NULL DEFAULT 0;

-- Cumulative dunning fees attached to THIS instalment, in cents. The
-- charge amount each attempt = payments.amount + dunning_fees_cents/100,
-- so a later success recovers everything owed in one go.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS dunning_fees_cents INTEGER NOT NULL DEFAULT 0;

-- When the cron should pick this row up next. NULL on the original
-- "scheduled" row (cron uses due_date for the first attempt) and on
-- terminal states ('collected', 'defaulted', 'written_off'). Set every
-- time the ladder advances.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS next_attempt_date DATE;

-- Guard against same-day double-attempt. The cron SELECT filters on
-- (last_dunning_attempt_date IS NULL OR last_dunning_attempt_date < today)
-- and the atomic claim WHERE re-checks the same — so a cron re-run
-- within the same UTC day is a no-op for already-attempted rows.
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS last_dunning_attempt_date DATE;

-- ── 2. payments.status — extend to include 'defaulted' ──────────────────
--
-- New terminal state for "cap reached, debt still owed". Distinct from
-- 'written_off' (explicit forgiveness, no debt).
ALTER TABLE payments
  DROP CONSTRAINT IF EXISTS payments_status_check;

ALTER TABLE payments
  ADD CONSTRAINT payments_status_check
  CHECK (status IN (
    'scheduled', 'processing', 'collected', 'failed',
    'retried', 'written_off', 'defaulted'
  ));

-- Index for the cron's "give me failed rows due to be retried today"
-- scan. Partial index keeps it tiny — only the rows actively in the
-- ladder are indexed.
CREATE INDEX IF NOT EXISTS payments_next_attempt_date_idx
  ON payments (next_attempt_date)
  WHERE status = 'failed' AND next_attempt_date IS NOT NULL;

-- ── 3. plan_events — extend event_type CHECK with ladder events ─────────
--
-- Append-only audit row per significant ladder event. Read by the
-- patient (own plans) + admin (everywhere) via existing RLS in 0038.
ALTER TABLE plan_events
  DROP CONSTRAINT IF EXISTS plan_events_event_type_check;

ALTER TABLE plan_events
  ADD CONSTRAINT plan_events_event_type_check
  CHECK (event_type IN (
    'collection_card_changed',
    'instalment_attempt_failed',
    'instalment_attempt_succeeded',
    'dunning_fee_applied',
    'instalment_defaulted',
    'instalment_self_settled'
  ));
