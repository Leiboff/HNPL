-- ─── One-off reconcile — Peach charge 000.100.110 succeeded but sync
-- ─── activation write never ran (fixed by activateFirstInstalment).
--
-- Context: on 2026-07-22 the widget/token flow succeeded and Peach
-- MIT returned 000.100.110 (money moved), but payWithSavedCard did
-- not flip terminal state before this commit landed. The webhook was
-- also not reconciling.
--
-- Uses payments.peach_payment_id 'bnc3mywzpjoilcy7' as the anchor —
-- unique per attempt — and derives the plan_id from it. Prefix-safe
-- if you want to double-check first: SELECT id, plan_id, status FROM
-- payments WHERE peach_payment_id = 'bnc3mywzpjoilcy7';
--
-- Run inside a transaction. All writes are idempotent (guarded by
-- current status), so re-running is safe.

BEGIN;

-- 1) Payment → collected
UPDATE payments
   SET status       = 'collected',
       collected_at = NOW()
 WHERE peach_payment_id = 'bnc3mywzpjoilcy7'
   AND status != 'collected';

-- 2) Plan → active (only if still pending_first_payment)
UPDATE plans
   SET status = 'active'
 WHERE id = (
   SELECT plan_id FROM payments WHERE peach_payment_id = 'bnc3mywzpjoilcy7'
 )
   AND status = 'pending_first_payment';

-- 3) Payout row — insert one if none exists yet for this plan.
--    Fee snapshot uses the practice's current fee_percent (default 6%
--    when null). Provider payouts are not backfilled here; if the
--    practice_member elected provider destination, edit the row after
--    inserting.
INSERT INTO payouts (id, practice_id, plan_id, gross_amount, fee_amount, net_amount, status, payout_destination)
SELECT
  gen_random_uuid(),
  p.practice_id,
  p.id,
  p.total_amount,
  ROUND(p.total_amount * (COALESCE(pr.fee_percent, 6) / 100.0), 2),
  ROUND(p.total_amount - (p.total_amount * (COALESCE(pr.fee_percent, 6) / 100.0)), 2),
  'pending',
  'practice'
FROM plans p
LEFT JOIN practices pr ON pr.id = p.practice_id
WHERE p.id = (
  SELECT plan_id FROM payments WHERE peach_payment_id = 'bnc3mywzpjoilcy7'
)
  AND NOT EXISTS (SELECT 1 FROM payouts WHERE plan_id = p.id);

COMMIT;

-- Verify (run separately after commit):
--
-- SELECT p.id, p.status, pay.status AS payment_status, pay.collected_at, po.id AS payout_id, po.gross_amount, po.net_amount
--   FROM plans p
--   JOIN payments pay ON pay.plan_id = p.id AND pay.peach_payment_id = 'bnc3mywzpjoilcy7'
--   LEFT JOIN payouts po ON po.plan_id = p.id;
