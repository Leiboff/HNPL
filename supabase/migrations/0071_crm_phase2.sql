-- ─── CRM Phase 2 — Gmail integration + email templates + inbound ────
--
-- Three additive changes to the CRM tables introduced in 0068/0069:
--
--   1. crm_email_accounts — per-user Gmail OAuth tokens (encrypted at
--      rest via the same AES-256-GCM helper used for SA IDs). RLS is
--      deny-all to session clients; server-side reads/writes happen
--      through the service role. Tokens NEVER reach the browser.
--
--   2. crm_email_templates — reusable copy blocks for compose (name,
--      subject, body, created_by). RLS scoped to admin/sales.
--
--   3. crm_activities — two nullable columns (gmail_thread_id,
--      gmail_message_id) so email activities can be threaded and the
--      reply-tracker cron can find them. Extends the type CHECK to
--      allow 'email_reply' rows the cron inserts on inbound.
--
-- No changes to any existing table beyond crm_activities' additive
-- columns and its check-constraint.

-- ── 1. crm_email_accounts ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_email_accounts (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  gmail_address         TEXT        NOT NULL,
  refresh_token_enc     TEXT        NOT NULL,     -- AES-256-GCM ciphertext (v1:iv:tag:ct)
  access_token_cache    TEXT,                     -- plaintext short-lived, refreshed as needed
  access_token_expiry   TIMESTAMPTZ,
  connected_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_polled_at        TIMESTAMPTZ,              -- reply-tracker cron cursor
  status                TEXT        NOT NULL DEFAULT 'connected'
    CHECK (status IN ('connected', 'reauth_required', 'revoked'))
);

CREATE INDEX IF NOT EXISTS crm_email_accounts_status_idx
  ON crm_email_accounts(status)
  WHERE status = 'connected';

ALTER TABLE crm_email_accounts ENABLE ROW LEVEL SECURITY;

-- Deny-all to session clients. NO policies means no rows are visible via
-- PostgREST — the service-role client bypasses RLS and is the only
-- reader/writer. This keeps refresh tokens (even encrypted) off the
-- browser bundle's reach entirely.

COMMENT ON TABLE crm_email_accounts IS
  'Per-user Gmail OAuth tokens. Refresh tokens encrypted with '
  'AES-256-GCM (same helper as profiles.sa_id_number). RLS deny-all '
  'to session clients; server actions use the service role.';

-- ── 2. crm_email_templates ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_email_templates (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT        NOT NULL,
  subject      TEXT        NOT NULL,
  body         TEXT        NOT NULL,
  is_seed      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by   UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE crm_email_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_email_templates_admin_sales_select"
  ON crm_email_templates FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_email_templates_admin_sales_insert"
  ON crm_email_templates FOR INSERT
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_email_templates_admin_sales_update"
  ON crm_email_templates FOR UPDATE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_email_templates_admin_sales_delete"
  ON crm_email_templates FOR DELETE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

-- ── 3. crm_activities — Gmail threading columns + 'email_reply' type

ALTER TABLE crm_activities
  ADD COLUMN IF NOT EXISTS gmail_thread_id  TEXT,
  ADD COLUMN IF NOT EXISTS gmail_message_id TEXT;

CREATE INDEX IF NOT EXISTS crm_activities_gmail_thread_idx
  ON crm_activities(gmail_thread_id)
  WHERE gmail_thread_id IS NOT NULL;

-- Extend the type CHECK to allow 'email_reply' (cron-inserted inbound).
-- Postgres doesn't support ALTER COLUMN … ADD to a CHECK constraint; the
-- pattern is DROP + re-ADD, so we mirror the 0067 role-check approach.
ALTER TABLE crm_activities DROP CONSTRAINT IF EXISTS crm_activities_type_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_type_check
  CHECK (type IN (
    'call', 'meeting', 'whatsapp', 'email', 'email_reply', 'note', 'stage_change'
  ));

-- ── 4. Seed templates ───────────────────────────────────────────────
--
-- Two starter templates: an intro (first touch) and a follow-up. Copy
-- is deliberately generic — no rate claims, no plan lengths beyond
-- Pay in 2 / Pay in 3, no card-hold or preauth language, no "no credit
-- check" claims. Kept inside the /practices forbidden-strings pin.
-- Merge fields substituted at compose time by the compose sheet.

INSERT INTO crm_email_templates (id, name, subject, body, is_seed)
VALUES (
  '00000000-0000-0000-0000-000000000101',
  $tpl$Intro - betternow for {{practice_name}}$tpl$,
  $tpl$A quick intro from betternow$tpl$,
  $tpl$Hi {{contact_first_name}},

I'm {{my_name}} from betternow. We help practices like {{practice_name}} offer patients interest-free instalments so more of your recommended treatments go ahead - you get paid upfront, we handle collection.

Would you have 15 minutes this week for a quick chat? Happy to work around your schedule.

Best,
{{my_name}}$tpl$,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO crm_email_templates (id, name, subject, body, is_seed)
VALUES (
  '00000000-0000-0000-0000-000000000102',
  $tpl$Follow-up - checking in$tpl$,
  $tpl$Following up on betternow for {{practice_name}}$tpl$,
  $tpl$Hi {{contact_first_name}},

Just circling back on my earlier note about betternow. Whenever you have a moment, I'd love to show you how {{practice_name}} could offer patients instalments - a quick call is usually enough to see if it fits.

Any time in the next few days that works for you?

Best,
{{my_name}}$tpl$,
  TRUE
)
ON CONFLICT (id) DO NOTHING;

-- ── 5. touch updated_at on crm_email_templates ──────────────────────

CREATE OR REPLACE FUNCTION crm_email_templates_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_email_templates_touch_updated_at ON crm_email_templates;
CREATE TRIGGER trg_crm_email_templates_touch_updated_at
  BEFORE UPDATE ON crm_email_templates
  FOR EACH ROW
  EXECUTE FUNCTION crm_email_templates_touch_updated_at();
