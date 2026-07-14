-- ─── CRM email upgrades — multi-account, attribution, oversight,
-- ─── signatures, push notifications ───────────────────────────────
--
-- Follows 0071. All additive except one relaxed constraint:
--
--   1. crm_email_accounts:
--      • drop the user_id UNIQUE constraint; add composite
--        UNIQUE(user_id, gmail_address) so one user can connect
--        multiple Gmail addresses
--      • last_history_id text            — Pub/Sub push cursor
--      • watch_expires_at timestamptz    — set by users.watch response
--      • last_used_at timestamptz        — updated on every send;
--        drives "Send as" default in compose
--
--   2. crm_activities:
--      • sent_from text                  — sending address on
--        outbound emails and receiving address on inbound replies
--        so attribution can render "Sent by X · addr" and
--        "Reply to addr" cleanly. Nullable — rows predating this
--        column stay owner-only.
--
--   3. crm_signatures (new): per-user editable signature. Simple
--      structured fields (display_name, title, phone, email) merge
--      into a brand HTML template; power users can override with
--      raw HTML (sanitised at write-time). Text fallback for the
--      plain-text MIME part.
--
--      NOTE: Deliberately NOT fetched from Gmail. Company controls
--      consistency; no new OAuth scopes needed.
--
--   4. crm_audit_log (new): generic audit trail for
--      administrative actions (currently: admin-revoke of another
--      user's Gmail connection). Not a per-lead activity so
--      crm_activities is the wrong home — crm_activities requires
--      lead_id and revocation is not lead-scoped.

-- ── 1. crm_email_accounts — multi-address per user ────────────────

-- Drop the implicit UNIQUE on user_id. Postgres names it
-- <table>_<column>_key; guarded with IF EXISTS so re-application
-- against a legacy database is safe.
ALTER TABLE crm_email_accounts
  DROP CONSTRAINT IF EXISTS crm_email_accounts_user_id_key;

-- Composite unique so a user cannot connect the same address twice
-- but CAN connect several distinct addresses (e.g. jess@ + admin@).
ALTER TABLE crm_email_accounts
  ADD CONSTRAINT crm_email_accounts_user_address_key UNIQUE (user_id, gmail_address);

-- Gmail push (Pub/Sub) bookkeeping.
ALTER TABLE crm_email_accounts
  ADD COLUMN IF NOT EXISTS last_history_id     TEXT,
  ADD COLUMN IF NOT EXISTS watch_expires_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_used_at        TIMESTAMPTZ;

-- Fast lookup by gmail_address for the push handler's O(1) route
-- from Pub/Sub payload → account row.
CREATE INDEX IF NOT EXISTS crm_email_accounts_gmail_address_idx
  ON crm_email_accounts(lower(gmail_address));

-- Renewal-scan support: pick the near-expiry watches quickly.
CREATE INDEX IF NOT EXISTS crm_email_accounts_watch_expiry_idx
  ON crm_email_accounts(watch_expires_at)
  WHERE watch_expires_at IS NOT NULL;

COMMENT ON COLUMN crm_email_accounts.last_history_id  IS
  'Gmail historyId cursor. Advanced by push handler + poller safety-net.';
COMMENT ON COLUMN crm_email_accounts.watch_expires_at IS
  'users.watch expiration. Watches lapse ~7 days; daily renewal keeps them alive.';
COMMENT ON COLUMN crm_email_accounts.last_used_at     IS
  'Updated on every successful outbound send. Drives "Send as" default in compose.';

-- ── 2. crm_activities — sender attribution ────────────────────────

ALTER TABLE crm_activities
  ADD COLUMN IF NOT EXISTS sent_from TEXT;

COMMENT ON COLUMN crm_activities.sent_from IS
  'Email address used on this activity. For type=email: sender. '
  'For type=email_reply: the account address that received the reply. '
  'NULL for non-email activities and legacy rows.';

-- ── 3. crm_signatures ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_signatures (
  user_id       UUID        PRIMARY KEY REFERENCES profiles(id) ON DELETE CASCADE,

  -- Structured fields that feed the brand HTML template. If html_override
  -- is NULL, the template renders from these; otherwise html_override is
  -- used verbatim (already sanitised).
  display_name  TEXT,
  title         TEXT,
  phone         TEXT,
  email         TEXT,

  -- Optional raw-HTML override for power users. MUST be sanitised at the
  -- server-action layer before being written here — the DB stores the
  -- final safe HTML; no re-sanitisation on read.
  html_override TEXT,

  -- Plain-text fallback for the text/plain MIME part.
  text_fallback TEXT,

  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE crm_signatures ENABLE ROW LEVEL SECURITY;

-- Users can read + write their OWN signature. Admins can read all
-- (so oversight views can preview). Nobody can read others'.
CREATE POLICY "crm_signatures_self_select"
  ON crm_signatures FOR SELECT
  USING (user_id = auth.uid()
         OR (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "crm_signatures_self_insert"
  ON crm_signatures FOR INSERT
  WITH CHECK (
    user_id = auth.uid()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('sales', 'admin')
  );

CREATE POLICY "crm_signatures_self_update"
  ON crm_signatures FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (
    user_id = auth.uid()
    AND (SELECT role FROM profiles WHERE id = auth.uid()) IN ('sales', 'admin')
  );

CREATE POLICY "crm_signatures_self_delete"
  ON crm_signatures FOR DELETE
  USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION crm_signatures_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_signatures_touch_updated_at ON crm_signatures;
CREATE TRIGGER trg_crm_signatures_touch_updated_at
  BEFORE UPDATE ON crm_signatures
  FOR EACH ROW
  EXECUTE FUNCTION crm_signatures_touch_updated_at();

COMMENT ON TABLE crm_signatures IS
  'Per-user email signature. Managed IN the CRM (not fetched from Gmail) '
  'so the company controls brand consistency and no new OAuth scope is '
  'needed. Merge fields feed a brand HTML template; power users may '
  'override with raw HTML (sanitised by server actions at write-time).';

-- ── 4. crm_audit_log ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_audit_log (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  action       TEXT        NOT NULL,
    -- Free-form but conventional keys: 'gmail_account.revoked',
    -- 'gmail_account.watch_started', 'gmail_account.watch_stopped',
    -- future entries added as needed.
  target_type  TEXT,       -- 'crm_email_account', 'crm_lead', etc.
  target_id    UUID,
  details      JSONB,      -- action-specific payload (never contains tokens)
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_audit_log_action_idx      ON crm_audit_log(action);
CREATE INDEX IF NOT EXISTS crm_audit_log_actor_idx       ON crm_audit_log(actor_id);
CREATE INDEX IF NOT EXISTS crm_audit_log_target_idx      ON crm_audit_log(target_type, target_id);
CREATE INDEX IF NOT EXISTS crm_audit_log_occurred_idx    ON crm_audit_log(occurred_at DESC);

ALTER TABLE crm_audit_log ENABLE ROW LEVEL SECURITY;

-- Admins can read the audit trail. Sales/others cannot. Writes only
-- via the service role (server actions).
CREATE POLICY "crm_audit_log_admin_select"
  ON crm_audit_log FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

COMMENT ON TABLE crm_audit_log IS
  'Administrative audit trail. Writes only via service-role server '
  'actions; admins read via RLS. Never store token material in details.';
