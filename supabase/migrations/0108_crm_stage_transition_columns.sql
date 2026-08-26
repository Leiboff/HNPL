-- ─── CRM Phase 1.2 — structured stage transitions ─────────────────────
--
-- crm_leads_stage_change currently writes the transition as prose
-- baked into crm_activities.title ("Stage: new → agreement_sent").
-- Add from_stage/to_stage columns, populate them going forward, and
-- back-fill history by parsing existing titles. The human-readable
-- title is UNCHANGED — the timeline UI reads it verbatim.

-- ── 1. Columns + CHECKs ────────────────────────────────────────────────

ALTER TABLE crm_activities
  ADD COLUMN IF NOT EXISTS from_stage TEXT,
  ADD COLUMN IF NOT EXISTS to_stage   TEXT;

ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_from_stage_check
  CHECK (from_stage IS NULL OR from_stage IN (
    'new', 'contacted', 'meeting_scheduled', 'demo_done',
    'agreement_sent', 'signed', 'onboarded', 'lost'
  ));

ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_to_stage_check
  CHECK (to_stage IS NULL OR to_stage IN (
    'new', 'contacted', 'meeting_scheduled', 'demo_done',
    'agreement_sent', 'signed', 'onboarded', 'lost'
  ));

-- ── 2. Back-fill from existing titles ─────────────────────────────────
--
-- Only a title matching the EXACT two-part "Stage: X → Y" shape, with
-- both X and Y being real stage values, is parsed. Anything else
-- (a malformed three-part title, free text, a title from some other
-- source) is left with NULL from_stage/to_stage and counted as
-- unparsed rather than dropped or guessed at.

DO $$
DECLARE
  v_parsed   INT := 0;
  v_unparsed INT := 0;
  r RECORD;
  m TEXT[];
BEGIN
  FOR r IN SELECT id, title FROM crm_activities WHERE type = 'stage_change' LOOP
    m := regexp_match(r.title, '^Stage: ([a-z_]+) → ([a-z_]+)$');
    IF m IS NOT NULL
       AND m[1] IN ('new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost')
       AND m[2] IN ('new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost')
    THEN
      UPDATE crm_activities SET from_stage = m[1], to_stage = m[2] WHERE id = r.id;
      v_parsed := v_parsed + 1;
    ELSE
      v_unparsed := v_unparsed + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'stage_change backfill: parsed=%, unparsed=%', v_parsed, v_unparsed;
END $$;

-- ── 3. Trigger function — populate from_stage/to_stage ────────────────
--
-- Title format is byte-identical to before. WHEN clause (below) is
-- narrowed from
--   (OLD.stage IS DISTINCT FROM NEW.stage) OR (NEW.stage = 'lost')
-- to just
--   OLD.stage IS DISTINCT FROM NEW.stage
-- The OR arm existed so lost_reason could be re-validated on every
-- edit to an already-lost lead, but crm_leads_lost_reason_required —
-- a table-level CHECK, not a trigger — already enforces "stage='lost'
-- implies non-empty lost_reason" on EVERY insert/update regardless of
-- which trigger fires. Dropping the OR arm removes a spurious
-- stage_change row on unrelated edits to a lost lead without weakening
-- that guarantee at all.

CREATE OR REPLACE FUNCTION crm_leads_stage_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor UUID := auth.uid();
BEGIN
  -- Enforce lost_reason on lost
  IF NEW.stage = 'lost' AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'crm_leads.lost_reason is required when stage = ''lost''';
  END IF;

  -- Log stage change
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN
    INSERT INTO crm_activities (lead_id, type, title, body, from_stage, to_stage, created_by)
    VALUES (
      NEW.id,
      'stage_change',
      'Stage: ' || OLD.stage || ' → ' || NEW.stage,
      CASE
        WHEN NEW.stage = 'lost' THEN 'Reason: ' || NEW.lost_reason
        ELSE NULL
      END,
      OLD.stage,
      NEW.stage,
      v_actor
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_stage_change ON crm_leads;
CREATE TRIGGER trg_crm_leads_stage_change
  BEFORE UPDATE ON crm_leads
  FOR EACH ROW
  WHEN (OLD.stage IS DISTINCT FROM NEW.stage)
  EXECUTE FUNCTION crm_leads_stage_change();
