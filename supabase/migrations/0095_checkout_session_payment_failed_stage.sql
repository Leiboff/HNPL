-- ─── checkout_sessions.stage — add 'payment_failed' ─────────────────────────
--
-- WHY
--   Migration 0085 gave checkout_sessions a stage machine with two ways for a
--   session to end badly: 'expired' (the QR timed out, or the teller pressed
--   "Start next patient") and 'declined' (the patient refused the bill, wired
--   up in lib/checkout/declineCheckoutSessions.ts). It has no way to say the
--   most common bad ending of all: the card didn't go through.
--
--   That gap froze sessions. When the first instalment charge fails, the
--   Peach webhook's payment.failure branch sets plans.status='cancelled'
--   (app/api/payments/peach/webhook/route.ts) and the checkout completion page
--   has already early-returned before its own stage write, so the session sits
--   at 'scanned' — and stays there permanently, because
--   expire_stale_checkout_session only advances a stage while the plan is
--   still in ('pending_acceptance', 'pending_first_payment'). The till's
--   "Today at this till" strip therefore reported "Waiting on patient" for a
--   bill whose card had been declined.
--
-- WHY NOT REUSE AN EXISTING VALUE
--   'declined' is the patient refusing the bill. At a counter those two mean
--   opposite things and need opposite responses — "try another card" versus
--   "this patient says the bill isn't theirs" — so they cannot share a stage,
--   and a receptionist reading "Patient declined" about a card failure would
--   act on the wrong one. 'expired' is about the clock, which is not what
--   happened here. A generic 'cancelled' would carry no more information than
--   'expired' already does, so the value is named for the event.
--
-- WHY A NEW MIGRATION RATHER THAN AMENDING 0085
--   0085's own header notes it was amended in place because its table "has
--   never shipped anywhere". That is no longer true — the till has shipped, so
--   0085 may already be recorded as applied, and the CLI would skip an amended
--   copy of it. A separate version always lands.
--
-- 'payment_failed' IS TERMINAL, WITH ONE DELIBERATE EXCEPTION
--   lib/checkout/declineCheckoutSessions.ts will not move a session out of it
--   (its predicate only ever touches 'created'/'scanned'), and neither will
--   expire_stale_checkout_session. The exception is the completion route's own
--   `.neq('stage', 'completed')` write: a patient who retries with a different
--   card and succeeds SHOULD end at 'completed', and that weaker guard is what
--   lets the retry finish the story. Intended, and asserted in
--   lib/checkout/paymentFailedStage.test.ts.

-- The CHECK in 0085 is declared inline and unnamed, so Postgres derived its
-- name. Rather than trusting that derivation, find the stage constraint by
-- what it CONSTRAINS and drop it by its real name — a DROP ... IF EXISTS on a
-- guessed name would silently do nothing and leave the old constraint in
-- place, still rejecting every 'payment_failed' write with the ADD below
-- appearing to have succeeded.
DO $$
DECLARE
  v_name TEXT;
BEGIN
  SELECT con.conname
    INTO v_name
    FROM pg_constraint con
    JOIN pg_class     rel ON rel.oid = con.conrelid
   WHERE rel.relname   = 'checkout_sessions'
     AND con.contype   = 'c'
     AND pg_get_constraintdef(con.oid) LIKE '%stage%';

  IF v_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE checkout_sessions DROP CONSTRAINT %I', v_name);
  END IF;
END $$;

ALTER TABLE checkout_sessions
  ADD CONSTRAINT checkout_sessions_stage_check
  CHECK (stage IN ('created', 'scanned', 'completed', 'declined', 'expired', 'payment_failed'));

COMMENT ON CONSTRAINT checkout_sessions_stage_check ON checkout_sessions IS
  'Stage machine for a POS counter checkout session. Open: created, scanned. '
  'Terminal: completed (the patient paid), declined (the patient refused the '
  'bill), expired (the QR timed out or the teller moved on), payment_failed '
  '(the first instalment charge was rejected). Every value has a writer — see '
  'lib/checkout/paymentFailedStage.test.ts, which fails if one stops being '
  'written or a new one is added without one.';
