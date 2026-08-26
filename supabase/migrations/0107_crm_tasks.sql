-- ─── CRM Phase 1.1 — crm_tasks ────────────────────────────────────────
--
-- Today the entire scheduling model is a single nullable
-- crm_leads.next_follow_up_at: one open commitment per lead, no record
-- of what was promised versus what actually happened. crm_tasks is a
-- real task entity; next_follow_up_at is KEPT (not dropped) so every
-- existing read path (My Day, the leads list, the board, the map, the
-- layout badge count) keeps working unchanged — it is now maintained
-- by a trigger on crm_tasks rather than written directly.

-- ── 1. Table ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_tasks (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately nullable: a task not attached to a lead must be legal
  -- (e.g. "call the printer about signage" — admin work with no lead).
  lead_id        UUID        REFERENCES crm_leads(id) ON DELETE CASCADE,

  owner_user_id  UUID        NOT NULL REFERENCES profiles(id),

  type           TEXT        NOT NULL
    CHECK (type IN ('call', 'meeting', 'email', 'whatsapp', 'admin')),

  title          TEXT        NOT NULL,
  note           TEXT,

  due_at         TIMESTAMPTZ NOT NULL,
  completed_at   TIMESTAMPTZ,

  -- outcome is only meaningful once the task is completed; a value can
  -- only be set alongside a completed_at, and must be one of the fixed
  -- vocabulary when present.
  outcome        TEXT
    CHECK (
      outcome IS NULL
      OR (
        completed_at IS NOT NULL
        AND outcome IN ('reached', 'no_answer', 'gatekeeper', 'rescheduled', 'not_interested', 'done')
      )
    ),

  created_by     UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_tasks_owner_open_idx
  ON crm_tasks(owner_user_id, due_at)
  WHERE completed_at IS NULL;

CREATE INDEX IF NOT EXISTS crm_tasks_lead_idx ON crm_tasks(lead_id);

-- ── 2. updated_at auto-touch (matches crm_leads_touch_updated_at) ────

CREATE OR REPLACE FUNCTION crm_tasks_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_tasks_touch_updated_at ON crm_tasks;
CREATE TRIGGER trg_crm_tasks_touch_updated_at
  BEFORE UPDATE ON crm_tasks
  FOR EACH ROW
  EXECUTE FUNCTION crm_tasks_touch_updated_at();

-- ── 3. RLS — same predicate shape as every other crm_* table ─────────

ALTER TABLE crm_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_tasks_admin_sales_select"
  ON crm_tasks FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_tasks_admin_sales_insert"
  ON crm_tasks FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_tasks_admin_sales_update"
  ON crm_tasks FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_tasks_admin_sales_delete"
  ON crm_tasks FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

-- ── 4. Keep crm_leads.next_follow_up_at in sync ───────────────────────
--
-- next_follow_up_at := earliest incomplete due_at for the lead (NULL
-- when none). Recomputed on every insert/update/delete of a crm_tasks
-- row that touches a lead — including a lead_id reassignment, which
-- must resync BOTH the old and the new lead.

CREATE OR REPLACE FUNCTION crm_tasks_sync_next_follow_up()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_lead_id := OLD.lead_id;
  ELSE
    v_lead_id := NEW.lead_id;
  END IF;

  IF v_lead_id IS NOT NULL THEN
    UPDATE crm_leads
       SET next_follow_up_at = (
         SELECT MIN(due_at) FROM crm_tasks
          WHERE lead_id = v_lead_id AND completed_at IS NULL
       )
     WHERE id = v_lead_id
       AND next_follow_up_at IS DISTINCT FROM (
         SELECT MIN(due_at) FROM crm_tasks
          WHERE lead_id = v_lead_id AND completed_at IS NULL
       );
  END IF;

  -- A lead_id reassignment on UPDATE leaves the OLD lead's figure stale
  -- unless it is also recomputed.
  IF TG_OP = 'UPDATE' AND OLD.lead_id IS DISTINCT FROM NEW.lead_id AND OLD.lead_id IS NOT NULL THEN
    UPDATE crm_leads
       SET next_follow_up_at = (
         SELECT MIN(due_at) FROM crm_tasks
          WHERE lead_id = OLD.lead_id AND completed_at IS NULL
       )
     WHERE id = OLD.lead_id
       AND next_follow_up_at IS DISTINCT FROM (
         SELECT MIN(due_at) FROM crm_tasks
          WHERE lead_id = OLD.lead_id AND completed_at IS NULL
       );
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_tasks_sync_next_follow_up ON crm_tasks;
CREATE TRIGGER trg_crm_tasks_sync_next_follow_up
  AFTER INSERT OR UPDATE OR DELETE ON crm_tasks
  FOR EACH ROW
  EXECUTE FUNCTION crm_tasks_sync_next_follow_up();

-- ── 5. Back-fill ───────────────────────────────────────────────────────
--
-- One open crm_tasks row per lead that currently has a non-null
-- next_follow_up_at; zero for leads that don't. Owned by the lead's
-- owner_user_id — a lead with next_follow_up_at set but NO owner would
-- violate crm_tasks.owner_user_id NOT NULL, so that case is counted
-- and skipped rather than guessed at (none exist as of this writing,
-- but the migration must not assume that stays true).

DO $$
DECLARE
  v_created INT := 0;
  v_skipped_no_owner INT := 0;
BEGIN
  INSERT INTO crm_tasks (lead_id, owner_user_id, type, title, due_at, created_by)
  SELECT id, owner_user_id, 'call', 'Follow-up', next_follow_up_at, owner_user_id
    FROM crm_leads
   WHERE next_follow_up_at IS NOT NULL
     AND owner_user_id IS NOT NULL;
  GET DIAGNOSTICS v_created = ROW_COUNT;

  SELECT count(*) INTO v_skipped_no_owner
    FROM crm_leads
   WHERE next_follow_up_at IS NOT NULL
     AND owner_user_id IS NULL;

  RAISE NOTICE 'crm_tasks backfill: created=%, skipped (no owner)=%', v_created, v_skipped_no_owner;
END $$;

COMMENT ON TABLE crm_tasks IS
  'Real task entity replacing the single-pointer next_follow_up_at model. '
  'lead_id is nullable by design — a task need not belong to a lead. '
  'crm_leads.next_follow_up_at is now derived (see trg_crm_tasks_sync_next_follow_up), '
  'not written directly.';
