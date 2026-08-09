-- ─── payouts: one row per plan, enforced at the DB level ───────────────────
--
-- BACKGROUND (Audit A, practice-bill-POS-checkout follow-up)
--   lib/payments/activateFirstInstalment.ts inserts the payouts row for a
--   plan's first-instalment activation. Three independent callers can each
--   invoke it for the SAME plan: the anon checkout return route, the
--   portal payment-complete return route, and the Peach webhook. The
--   webhook guards itself against re-entry (it checks plans.status before
--   calling the helper), but the OTHER TWO callers call the helper
--   UNCONDITIONALLY whenever their own preconditions match — they do not
--   check plans.status first. So a call ordering where the webhook lands
--   first (activating the plan + inserting the payout) and one of the
--   return routes runs afterward is real, not hypothetical.
--
--   The helper's existing guard against a duplicate payout is a plain
--   SELECT-then-INSERT:
--     SELECT id FROM payouts WHERE plan_id = ... LIMIT 1
--     -- if empty --
--     INSERT INTO payouts (...) VALUES (...)
--   That's a classic TOCTOU race: if two calls' SELECTs both run before
--   either INSERT commits (two concurrent serverless invocations — the
--   webhook and a return route arriving within the same narrow window),
--   both see "no existing row" and both insert, producing two payouts
--   rows for one plan. There is no unique constraint today to stop it.
--
-- FIX
--   1. Defensively dedupe any pre-existing duplicate (keep the earliest
--      row per plan_id; this migration is a no-op if none exist, which is
--      the expected case — this table has no production data on this
--      branch, but the dedupe makes the migration safe to run anywhere).
--   2. Add a UNIQUE constraint on payouts.plan_id so a second INSERT for
--      the same plan is rejected at the database level regardless of any
--      application-level race. The paired code fix (same PR) switches the
--      insert to an upsert with ignoreDuplicates, so the rejected second
--      insert becomes a benign no-op instead of a hard error.

DELETE FROM payouts p
 WHERE EXISTS (
   SELECT 1 FROM payouts p2
    WHERE p2.plan_id = p.plan_id
      AND (p2.created_at, p2.id) < (p.created_at, p.id)
 );

ALTER TABLE payouts
  ADD CONSTRAINT payouts_plan_id_unique UNIQUE (plan_id);

COMMENT ON CONSTRAINT payouts_plan_id_unique ON payouts IS
  'One payout row per plan. Enforced at the DB level so a race between '
  'activateFirstInstalment callers (anon checkout return, portal payment- '
  'complete return, Peach webhook) can never produce a duplicate payout — '
  'the losing INSERT is rejected and the caller (activateFirstInstalment) '
  'treats that as an idempotent no-op via upsert(..., ignoreDuplicates).';
