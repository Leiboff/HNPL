-- ─── push_subscriptions ───────────────────────────────────────────────
--
-- Stores Web Push subscriptions tied to a patient profile. The presence
-- of an active (deleted_at IS NULL) row IS the patient's preference —
-- when they toggle notifications off we soft-delete the row, and the
-- sender filters them out by that same predicate. No second
-- "notifications_enabled" column to drift out of sync with reality.
--
-- One patient can have multiple devices; the endpoint URL is the
-- Web Push provider's unique handle per device + per browser
-- registration. UNIQUE on endpoint guards against silent duplicates
-- when the patient re-subscribes from the same browser.
--
-- Soft-delete (deleted_at) rather than hard-delete so we don't lose
-- the audit trail of "was subscribed on date X, opted out on date Y".
-- Re-subscribing from the same browser produces the same endpoint
-- which we re-activate via UPSERT in the API route.
--
-- RLS:
--   • Patient can SELECT / INSERT / UPDATE / DELETE their own rows
--     (toggle in settings is patient-driven).
--   • Service-role bypasses RLS — the sender uses the service role
--     when looking up subscriptions to notify (the webhook is the
--     caller and isn't acting on behalf of a user session).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  endpoint      TEXT        NOT NULL UNIQUE,
  -- Web Push keys (base64url-encoded). p256dh is the client public
  -- key, auth is the auth secret. Both are required to encrypt a
  -- push payload per RFC 8291.
  p256dh        TEXT        NOT NULL,
  auth          TEXT        NOT NULL,
  user_agent    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- NULL = subscription is active. A timestamp here = patient opted
  -- out at that moment; we keep the row for audit but exclude it from
  -- the sender.
  deleted_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS push_subscriptions_user_active_idx
  ON push_subscriptions(user_id)
  WHERE deleted_at IS NULL;

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

-- ── Patient policies — own-row scope ─────────────────────────────────
CREATE POLICY "push_subs_patient_select" ON push_subscriptions
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "push_subs_patient_insert" ON push_subscriptions
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subs_patient_update" ON push_subscriptions
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "push_subs_patient_delete" ON push_subscriptions
  FOR DELETE
  USING (user_id = auth.uid());

-- updated_at maintenance — match the convention already used on other
-- tables (no shared trigger function in the project yet; inline keeps
-- this migration self-contained).
CREATE OR REPLACE FUNCTION push_subscriptions_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS push_subscriptions_touch_updated_at_trg ON push_subscriptions;
CREATE TRIGGER push_subscriptions_touch_updated_at_trg
  BEFORE UPDATE ON push_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION push_subscriptions_touch_updated_at();

COMMENT ON TABLE push_subscriptions IS
  'Web Push subscriptions per patient device. Active subs have '
  'deleted_at IS NULL; the in-app settings toggle soft-deletes by '
  'setting deleted_at and unsubscribes the browser via the PushManager '
  'API. The sender filters on the same predicate so the toggle is '
  'authoritative everywhere.';
