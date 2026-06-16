-- ─── admin_audit_log: who-did-what-when on admin mutations ─────────────────
--
-- A single timeline table for every durable admin action: notes added
-- on a practice or customer, fee-percent changes, future overrides.
-- One row per action; the payload JSONB carries action-specific fields.
--
-- The point isn't compliance theatre — it's "I changed this practice's
-- fee three weeks ago, did anyone touch it after me?". Lightweight,
-- write-only from the admin's perspective, queried back into the
-- detail pages as a per-entity activity feed.
--
-- Notes ARE audit-log rows with action='note'. Keeping them in the
-- same table means the "activity feed" is just one ordered query —
-- no need to merge two streams in the UI.
--
-- entity_type values used today:
--   'practice'  — entity_id is practices.id
--   'customer'  — entity_id is profiles.id (a patient profile)
--
-- action values used today:
--   'note'         — payload: { "text": "..." }
--   'fee_changed'  — payload: { "from": 6.00, "to": 5.50 }

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id     UUID         NOT NULL REFERENCES profiles(id) ON DELETE RESTRICT,
  entity_type  TEXT         NOT NULL CHECK (entity_type IN ('practice', 'customer')),
  entity_id    UUID         NOT NULL,
  action       TEXT         NOT NULL,
  payload      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Per-entity timeline read pattern: filter by (entity_type, entity_id),
-- order by created_at DESC. Composite index handles both.
CREATE INDEX IF NOT EXISTS admin_audit_log_entity_idx
  ON admin_audit_log (entity_type, entity_id, created_at DESC);

-- Per-actor lookups (rare; "what did I do today") covered by a small
-- secondary index.
CREATE INDEX IF NOT EXISTS admin_audit_log_actor_idx
  ON admin_audit_log (actor_id, created_at DESC);

-- RLS: only platform admins read or write. Server actions go through
-- the auth-context client so the policies fire naturally — no
-- service-role escape hatch needed for this table.
ALTER TABLE admin_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admins_select_admin_audit_log" ON admin_audit_log
  FOR SELECT
  USING (is_platform_admin());

CREATE POLICY "admins_insert_admin_audit_log" ON admin_audit_log
  FOR INSERT
  WITH CHECK (
    is_platform_admin()
    -- The inserted actor_id MUST be the calling auth.uid() — server
    -- actions don't get to forge attribution.
    AND actor_id = auth.uid()
  );

-- No UPDATE / DELETE policies — audit log is append-only by design.
-- If a note ever needs amending the right pattern is a new
-- "note_amended" action linking to the original via payload.

COMMENT ON TABLE  admin_audit_log IS
  'Append-only timeline of admin mutations + notes. One row per action.';
COMMENT ON COLUMN admin_audit_log.entity_type IS
  'practice | customer — see admin/_lib/audit.ts for the canonical list.';
COMMENT ON COLUMN admin_audit_log.action IS
  'Action verb (note, fee_changed, ...). payload schema is per-action.';
COMMENT ON COLUMN admin_audit_log.payload IS
  'Action-specific JSON. For action=''note'': { text }.'
   ' For action=''fee_changed'': { from, to }.';
