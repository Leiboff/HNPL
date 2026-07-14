-- ─── CRM threaded replies — RFC Message-ID + reply-From capture ───────
--
-- Follows 0072. Two additive nullable columns on crm_activities so
-- the timeline "Reply" action can:
--
--   • prefill "To:" from the received reply's From address (reply_from)
--   • inject In-Reply-To / References headers on the outbound reply
--     using the anchor message's RFC 822 Message-ID (message_rfc_id)
--
-- Both columns are nullable because pre-0073 rows don't have the values.
-- Reply mode gracefully falls back to threadId-only sends for such rows
-- (Gmail server-side threading still works for gmail.com recipients;
-- external clients may fork the thread — acceptable per spec).
--
-- No RLS change; no scope change (Gmail Message-Id header is served
-- under the existing gmail.readonly scope via metadataHeaders).

ALTER TABLE crm_activities
  ADD COLUMN IF NOT EXISTS message_rfc_id TEXT,
  ADD COLUMN IF NOT EXISTS reply_from     TEXT;

-- Look up an activity by its RFC Message-ID quickly. This is what
-- gets stamped into In-Reply-To/References of downstream replies —
-- useful for de-duping and for any future "which reply went to
-- what" audit.
CREATE INDEX IF NOT EXISTS crm_activities_message_rfc_id_idx
  ON crm_activities(message_rfc_id)
  WHERE message_rfc_id IS NOT NULL;

COMMENT ON COLUMN crm_activities.message_rfc_id IS
  'RFC 822 Message-Id header of the email this activity represents. '
  'Populated on outbound (post-send lookback) and inbound (via '
  'metadataHeaders=Message-Id). Nullable for legacy rows.';
COMMENT ON COLUMN crm_activities.reply_from IS
  'For email_reply rows: the sender''s From address (used as "To" '
  'when the CRM user replies back from the timeline).';
