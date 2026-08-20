-- ─── One-off reconcile — Peach MIT charge for instalment 1 succeeded
-- ─── (card registered + saved) but the terminal-state write never ran.
--
-- Context: patient jnleiboff+malks@gmail.com / plan 5b2cb349-17bd-4f45-
-- ac79-628bb762fc76 (Weinberg Physios, created 2026-07-20). The card
-- used for the plan (VISA …0091, peach registration
-- 8ac7a4a29f7efca4019f817b1dda302e) was registered and saved to
-- payment_methods, and that same registration id is stamped onto the
-- plan row — both of which only happen after Peach confirms the card.
-- Instalment 1 (payments.id b8862a3f-6524-4393-a273-cef860abc41f,
-- peach_payment_id 'bnc1iuxgvyrxfubx') was left at status='processing'
-- from 2026-07-20 with no resolution 31 days later: the same stuck
-- state documented in scripts/reconcile-plan-8f80d0df.sql, where
-- activateFirstInstalment's write never landed (sync path and webhook
-- both missed). Symptom in the app: Plans tab stuck on "Setting up
-- your first payment…" while Home showed the instalment as an
-- upcoming "next payment" that was actually 31 days overdue.
--
-- This mirrors that script's fix for this plan/payment. All writes are
-- idempotent (guarded by current status), so re-running is safe.

BEGIN;

-- 1) Payment → collected
UPDATE payments
   SET status       = 'collected',
       collected_at = created_at
 WHERE id = 'b8862a3f-6524-4393-a273-cef860abc41f'
   AND status != 'collected';

-- 2) Plan → active (only if still pending_first_payment)
UPDATE plans
   SET status = 'active'
 WHERE id = '5b2cb349-17bd-4f45-ac79-628bb762fc76'
   AND status = 'pending_first_payment';

-- 3) Payout row — insert one if none exists yet for this plan.
--    Fee snapshot uses the practice's current fee_percent (default 6%
--    when null), matching activateFirstInstalment's calculation.
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
WHERE p.id = '5b2cb349-17bd-4f45-ac79-628bb762fc76'
  AND NOT EXISTS (SELECT 1 FROM payouts WHERE plan_id = p.id);

COMMIT;

-- Verify (run separately after commit):
--
-- SELECT p.id, p.status, pay.status AS payment_status, pay.collected_at, po.id AS payout_id, po.gross_amount, po.net_amount
--   FROM plans p
--   JOIN payments pay ON pay.plan_id = p.id AND pay.id = 'b8862a3f-6524-4393-a273-cef860abc41f'
--   LEFT JOIN payouts po ON po.plan_id = p.id;
