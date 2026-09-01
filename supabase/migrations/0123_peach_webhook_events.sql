-- ─── Peach webhook replay ledger ────────────────────────────────────────
--
-- THE DEFECT (audit 2026-09-01, F-09b)
--
-- The Peach signature covers `${timestamp}.${webhookId}.${url}.${payload}`
-- and x-webhook-id is unique per delivery — but the route never recorded
-- it, and verifyWebhookSignature never looked at the timestamp. A captured
-- delivery therefore verified forever.
--
-- Idempotency was entirely precondition-based ("if plan.status === 'active'
-- return"). That holds for an exact duplicate arriving against unchanged
-- state, and stops holding the moment anything moves the row back — which
-- F-06 showed was reachable. Preconditions are a good second layer and a
-- bad only layer.
--
-- Same shape as didit_webhook_events (0102): a primary key on the delivery
-- id, and the INSERT's 23505 IS the "have we seen this before" check. No
-- separate SELECT, so two concurrent deliveries of one retried event cannot
-- both pass.
--
-- WHY THE ROUTE RECORDS IT *AFTER* PROCESSING, NOT BEFORE
--
-- Learned from F-13, the ordering bug in the Didit receiver: it claims the
-- event id up front, so its own deliberate 500-for-retry path re-entered,
-- found the row already there, and answered "duplicate" — permanently
-- losing the verification it had asked to have retried. The Peach route
-- records on the way out, and its handlers are individually precondition-
-- guarded, so a mid-flight crash re-processes safely rather than being
-- silently swallowed.

CREATE TABLE IF NOT EXISTS peach_webhook_events (
  -- x-webhook-id, verbatim. Part of the signed message, so a forged value
  -- cannot be substituted without breaking the HMAC.
  webhook_id   TEXT        PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Diagnostics only. Never the payload: it carries card fingerprints.
  event_type   TEXT,
  reference    TEXT
);

CREATE INDEX IF NOT EXISTS peach_webhook_events_received_at_idx
  ON peach_webhook_events (received_at DESC);

ALTER TABLE peach_webhook_events ENABLE ROW LEVEL SECURITY;

-- No policies, deliberately — same posture as phone_verifications (0052)
-- and didit_webhook_events. The only writer is the webhook route on the
-- service-role client, which bypasses RLS; nothing else has any business
-- reading a delivery ledger.

COMMENT ON TABLE peach_webhook_events IS
  'Replay ledger for /api/payments/peach/webhook, keyed on the signed '
  'x-webhook-id. Written AFTER the handlers run (see the 0123 header for '
  'why the Didit receiver''s write-first ordering is a bug, not a model). '
  'Rows are safe to prune beyond the signature freshness window.';
