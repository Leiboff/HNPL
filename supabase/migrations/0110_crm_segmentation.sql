-- ─── CRM Phase 1.4 — segmentation primitives ───────────────────────────
--
-- Tags, saved views (Phase 3 consumes crm_saved_views — created now so
-- that phase is pure UI), and a constrained lost_reason vocabulary.

-- ── 1. crm_lead_tags ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_lead_tags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id     UUID        NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  tag         TEXT        NOT NULL CHECK (btrim(tag) <> ''),
  created_by  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_tags_lead_tag_uidx
  ON crm_lead_tags(lead_id, lower(tag));

CREATE INDEX IF NOT EXISTS crm_lead_tags_tag_idx
  ON crm_lead_tags(lower(tag));

ALTER TABLE crm_lead_tags ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_lead_tags_admin_sales_select"
  ON crm_lead_tags FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_lead_tags_admin_sales_insert"
  ON crm_lead_tags FOR INSERT
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_lead_tags_admin_sales_delete"
  ON crm_lead_tags FOR DELETE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

-- ── 2. crm_saved_views ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_saved_views (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  UUID        NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  filters        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  sort           TEXT,
  is_shared      BOOLEAN     NOT NULL DEFAULT false,
  position       INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_saved_views_owner_idx ON crm_saved_views(owner_user_id);

CREATE OR REPLACE FUNCTION crm_saved_views_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_saved_views_touch_updated_at ON crm_saved_views;
CREATE TRIGGER trg_crm_saved_views_touch_updated_at
  BEFORE UPDATE ON crm_saved_views
  FOR EACH ROW
  EXECUTE FUNCTION crm_saved_views_touch_updated_at();

ALTER TABLE crm_saved_views ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_saved_views_admin_sales_select"
  ON crm_saved_views FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_saved_views_admin_sales_insert"
  ON crm_saved_views FOR INSERT
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_saved_views_admin_sales_update"
  ON crm_saved_views FOR UPDATE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'))
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_saved_views_admin_sales_delete"
  ON crm_saved_views FOR DELETE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

-- ── 3. lost_reason → constrained vocabulary ───────────────────────────
--
-- Existing free-text values are migrated, not discarded: anything that
-- already matches a new enum member passes straight through; anything
-- else is preserved verbatim in the new lost_note column and the enum
-- column defaults to 'other'. (No keyword-guessing heuristic is
-- applied — there is no way to verify a guessed mapping, and the
-- instructions are explicit that unmapped values go to 'other' with
-- the original text kept, not discarded.)

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS lost_note TEXT;

DO $$
DECLARE
  v_already_valid INT := 0;
  v_mapped_other  INT := 0;
BEGIN
  SELECT count(*) INTO v_already_valid
    FROM crm_leads
   WHERE stage = 'lost'
     AND lost_reason IN ('price','uses_competitor','no_need','no_decision_maker','unresponsive','not_eligible','other');

  UPDATE crm_leads
     SET lost_note   = lost_reason,
         lost_reason = 'other'
   WHERE stage = 'lost'
     AND lost_reason NOT IN ('price','uses_competitor','no_need','no_decision_maker','unresponsive','not_eligible','other');
  GET DIAGNOSTICS v_mapped_other = ROW_COUNT;

  RAISE NOTICE 'lost_reason migration: already-valid-enum=%, free-text->other (preserved in lost_note)=%',
    v_already_valid, v_mapped_other;
END $$;

ALTER TABLE crm_leads DROP CONSTRAINT IF EXISTS crm_leads_lost_reason_required;

ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_lost_reason_check
  CHECK (lost_reason IS NULL OR lost_reason IN (
    'price', 'uses_competitor', 'no_need', 'no_decision_maker',
    'unresponsive', 'not_eligible', 'other'
  ));

-- Re-added byte-for-byte: stage='lost' still requires a non-empty
-- lost_reason. This CHECK — not any trigger — is what continues to
-- protect that invariant on every insert/update, including the ones
-- the narrowed stage_change trigger WHEN clause (0108) no longer sees.
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_lost_reason_required
  CHECK (
    stage <> 'lost' OR (lost_reason IS NOT NULL AND btrim(lost_reason) <> '')
  );
