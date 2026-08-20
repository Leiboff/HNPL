-- ─── Sweep — cancel first-instalment charges Peach never confirmed.
--
-- Context: a database-wide check for plans stuck on
-- status='pending_first_payment' turned up 22 plans, 18-88 days old,
-- whose instalment-1 payment never resolved out of 'processing'. Two
-- of them (reconciled separately — see scripts/reconcile-plan-
-- 5b2cb349.sql and scripts/reconcile-plan-2f0120cc.sql) had solid
-- evidence the charge actually succeeded: a peach_registration_id on
-- the plan matching a payment_methods card created at/just before the
-- charge attempt, which only happens after Peach confirms the card.
--
-- The 21 plans below have NO such evidence — either no
-- peach_payment_id was ever recorded (checkout abandoned before
-- reaching Peach), no peach_registration_id was ever stamped on the
-- plan (card/charge never confirmed), or the only matching card in
-- payment_methods was created well after the charge attempt (doesn't
-- corroborate that attempt). Nothing here shows Peach ever confirmed
-- money moved, so treating these as collected/active would fabricate
-- successful payments. Instead this applies exactly what the Peach
-- webhook's payment.failure handler would have done on a real decline
-- (app/api/payments/peach/webhook/route.ts, instalment-1 branch):
--   payments.status → 'failed'
--   plans.status    → 'cancelled'
--
-- Plan id list is the exact set returned by the sweep query below, run
-- immediately before this script — re-run it first if time has passed,
-- to confirm the set is unchanged before applying:
--
--   SELECT id FROM plans WHERE status = 'pending_first_payment' ORDER BY created_at;
--
-- All writes are guarded by current status, so re-running is safe.

BEGIN;

UPDATE payments
   SET status = 'failed',
       failure_reason = 'reconciled 2026-08-20: no Peach confirmation received after 18+ days stuck processing; treated as a failed/abandoned first-payment attempt'
 WHERE plan_id IN (
   'b73a34d5-0fc6-49ec-91e3-0ad3673c3855',
   'b7e67937-4068-4838-bd73-380f7cbfcf75',
   '619f9a05-79ae-4125-8d24-c81136916220',
   '5a97fce8-df14-4a26-8fa7-152f98229941',
   'b1b03c84-aaa1-4087-9062-371fb39fa0c9',
   'a2e1f28b-2dea-48fd-91f6-46f9181d446d',
   'f2c024a0-47b4-4140-8584-991c4b24c643',
   'e57f85dd-4b6a-4d1d-8b25-ac37f6cc625d',
   '77f1b68e-bbdb-403b-922a-052c45715d56',
   '3742aed0-9c01-4db8-b436-5ccf61c34104',
   '2444c543-5a35-4dbf-b389-e496faa5135b',
   'bd73c859-5cbb-4a23-8b6f-9ccff1a7de6a',
   'aef7c5fc-e569-452a-a37c-1de75ef7e8c0',
   '54dcf9cf-cafb-4b98-aac7-2baed3840b60',
   'c6eb12f9-efcf-4b78-98ee-259408d75315',
   '31907d81-37b9-46c6-b839-3d7388db0d8c',
   '38c44eac-7ff7-4fba-b4b7-9375451b1e06',
   'b2d561a7-049d-4217-8a03-76fca389c2df',
   '44051229-e810-49df-b775-ddf85ab57506',
   '4d5915e1-d86d-462e-9928-ea884615b7b7',
   '43dd8174-746a-4b36-b1ad-2a9306783825'
 )
   AND instalment_number = 1
   AND status = 'processing';

UPDATE plans
   SET status = 'cancelled'
 WHERE id IN (
   'b73a34d5-0fc6-49ec-91e3-0ad3673c3855',
   'b7e67937-4068-4838-bd73-380f7cbfcf75',
   '619f9a05-79ae-4125-8d24-c81136916220',
   '5a97fce8-df14-4a26-8fa7-152f98229941',
   'b1b03c84-aaa1-4087-9062-371fb39fa0c9',
   'a2e1f28b-2dea-48fd-91f6-46f9181d446d',
   'f2c024a0-47b4-4140-8584-991c4b24c643',
   'e57f85dd-4b6a-4d1d-8b25-ac37f6cc625d',
   '77f1b68e-bbdb-403b-922a-052c45715d56',
   '3742aed0-9c01-4db8-b436-5ccf61c34104',
   '2444c543-5a35-4dbf-b389-e496faa5135b',
   'bd73c859-5cbb-4a23-8b6f-9ccff1a7de6a',
   'aef7c5fc-e569-452a-a37c-1de75ef7e8c0',
   '54dcf9cf-cafb-4b98-aac7-2baed3840b60',
   'c6eb12f9-efcf-4b78-98ee-259408d75315',
   '31907d81-37b9-46c6-b839-3d7388db0d8c',
   '38c44eac-7ff7-4fba-b4b7-9375451b1e06',
   'b2d561a7-049d-4217-8a03-76fca389c2df',
   '44051229-e810-49df-b775-ddf85ab57506',
   '4d5915e1-d86d-462e-9928-ea884615b7b7',
   '43dd8174-746a-4b36-b1ad-2a9306783825'
 )
   AND status = 'pending_first_payment';

COMMIT;

-- Verify (run separately after commit):
--
-- SELECT status, count(*) FROM plans WHERE id IN (...) GROUP BY status;
-- SELECT status, count(*) FROM payments WHERE plan_id IN (...) AND instalment_number = 1 GROUP BY status;
