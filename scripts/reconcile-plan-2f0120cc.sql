-- ─── One-off reconcile — Peach MIT charge for instalment 1 succeeded
-- ─── (card registered + saved) but the terminal-state write never ran.
--
-- Context: plan 2f0120cc-2be5-411e-a727-7beb3457e2b2, patient
-- 47e2678c-65eb-4074-8f8d-29f925ead7f4. The card used for the plan
-- (VISA …0091, peach registration 8ac7a4a09f7efc81019f81621550724c)
-- was saved to payment_methods at 2026-07-20 21:15:20 — 37 seconds
-- before the instalment-1 charge attempt (payments.id
-- 0dc3601a-78d4-4838-9e93-d6411f470a20, peach_payment_id
-- 'bnc1ctv0zoo9o725') was recorded — and that same registration id is
-- stamped onto the plan row, which only happens after Peach confirms
-- the card. Left at status='processing' with no resolution for 30
-- days: the same stuck state as scripts/reconcile-plan-8f80d0df.sql
-- and scripts/reconcile-plan-5b2cb349.sql — activateFirstInstalment's
-- write never landed.
--
-- Found via a database-wide sweep for plans stuck on
-- pending_first_payment (see scripts/cancel-unconfirmed-first-payments.sql
-- for the rest of that sweep, which had no such corroborating card
-- evidence and were cancelled instead).
--
-- All writes are idempotent (guarded by current status), so re-running
-- is safe.

BEGIN;

UPDATE payments
   SET status       = 'collected',
       collected_at = created_at
 WHERE id = '0dc3601a-78d4-4838-9e93-d6411f470a20'
   AND status != 'collected';

UPDATE plans
   SET status = 'active'
 WHERE id = '2f0120cc-2be5-411e-a727-7beb3457e2b2'
   AND status = 'pending_first_payment';

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
WHERE p.id = '2f0120cc-2be5-411e-a727-7beb3457e2b2'
  AND NOT EXISTS (SELECT 1 FROM payouts WHERE plan_id = p.id);

COMMIT;
