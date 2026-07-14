-- ─── CRM send-as aliases — shared team addresses (admin-managed) ────
--
-- Lets an admin attach one or more alias addresses to an existing
-- Gmail connection so users of a given role can send AS the alias
-- FROM someone else's authenticated Gmail account. The canonical use
-- case is a shared support@betternow.co.za: Jess owns the underlying
-- Gmail (jess@…), admin registers support@ as a send-as-alias in
-- Jess's Google account, then attaches an alias row here so any
-- admin-role user can pick "support@ via jess@" in the CRM compose.
--
-- Two enforcement layers:
--   • Google-side: the alias MUST be registered under Gmail Settings
--     → Accounts → Send mail as. Otherwise Gmail rewrites From to
--     the authenticated address (jess@) and the recipient sees
--     jess@, not support@. The compose action detects this
--     post-send and surfaces a clear error.
--   • CRM-side: RLS restricts who can SEE an alias (SELECT policy
--     checks caller's role against allowed_roles). Writes are
--     admin-only. On send, the server also enforces the role check
--     redundantly (belt-and-braces against a leaked API surface).

CREATE TABLE IF NOT EXISTS crm_sendas_aliases (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id  UUID        NOT NULL REFERENCES crm_email_accounts(id) ON DELETE CASCADE,
  alias_email    TEXT        NOT NULL,
  label          TEXT,
  -- Role names allowed to use this alias. Currently expected to hold
  -- 'admin', 'sales', or both, matching profiles.role. Free-form so
  -- future roles compose without migration.
  allowed_roles  TEXT[]      NOT NULL DEFAULT '{}',
  created_by     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One alias per (connection, address) — case-insensitive.
CREATE UNIQUE INDEX IF NOT EXISTS crm_sendas_aliases_conn_email_key
  ON crm_sendas_aliases(connection_id, lower(alias_email));

CREATE INDEX IF NOT EXISTS crm_sendas_aliases_conn_idx
  ON crm_sendas_aliases(connection_id);

-- Case-insensitive lookup by alias_email — the send path receives an
-- alias id, but the reply-mode lock resolves an alias by its email.
CREATE INDEX IF NOT EXISTS crm_sendas_aliases_email_idx
  ON crm_sendas_aliases(lower(alias_email));

ALTER TABLE crm_sendas_aliases ENABLE ROW LEVEL SECURITY;

-- ── Writes: admin only ──────────────────────────────────────────
CREATE POLICY "sendas_aliases_admin_insert"
  ON crm_sendas_aliases FOR INSERT
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "sendas_aliases_admin_update"
  ON crm_sendas_aliases FOR UPDATE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin')
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

CREATE POLICY "sendas_aliases_admin_delete"
  ON crm_sendas_aliases FOR DELETE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) = 'admin');

-- ── Read: role-in-allowed_roles ─────────────────────────────────
--
-- The caller's role must appear in the alias's allowed_roles array
-- (Postgres = ANY on a text[] column). Admin implicitly sees all
-- because they are the ones who create them.
CREATE POLICY "sendas_aliases_role_select"
  ON crm_sendas_aliases FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) = 'admin'
    OR (SELECT role FROM profiles WHERE id = auth.uid()) = ANY(allowed_roles)
  );

COMMENT ON TABLE crm_sendas_aliases IS
  'Shared send-as aliases attached to a Gmail connection. Managed by '
  'admin; readable by users whose profiles.role appears in allowed_roles. '
  'The alias MUST also be registered under Gmail Settings → Accounts → '
  '"Send mail as" for the underlying account, or Gmail rewrites the '
  'From header on send.';
