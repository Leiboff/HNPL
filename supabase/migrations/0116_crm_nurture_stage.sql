-- ─── CRM — nurture stage + wake date ───────────────────────────────────
--
-- 'nurture' is a WORKING stage (not terminal) for a lead that's gone
-- quiet but isn't dead — a timing/budget soft-no or an unresponsive
-- run. It always carries a wake date so it resurfaces instead of
-- silently rotting. The rep decides what happens on wake; nothing
-- here auto-advances the stage.

-- ── 1. Widen the stage vocabulary on both crm_leads and crm_activities ─
--
-- crm_leads.stage's CHECK was unnamed in 0069, so Postgres gave it the
-- default column-check name (<table>_<column>_check). crm_activities'
-- from_stage/to_stage CHECKs (0108) were named explicitly.

ALTER TABLE crm_leads DROP CONSTRAINT crm_leads_stage_check;
ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_stage_check
  CHECK (stage IN (
    'new', 'contacted', 'meeting_scheduled', 'demo_done',
    'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost'
  ));

ALTER TABLE crm_activities DROP CONSTRAINT crm_activities_from_stage_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_from_stage_check
  CHECK (from_stage IS NULL OR from_stage IN (
    'new', 'contacted', 'meeting_scheduled', 'demo_done',
    'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost'
  ));

ALTER TABLE crm_activities DROP CONSTRAINT crm_activities_to_stage_check;
ALTER TABLE crm_activities ADD CONSTRAINT crm_activities_to_stage_check
  CHECK (to_stage IS NULL OR to_stage IN (
    'new', 'contacted', 'meeting_scheduled', 'demo_done',
    'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost'
  ));

-- ── 2. nurture_wake_at ──────────────────────────────────────────────

ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS nurture_wake_at TIMESTAMPTZ;

-- ── 3. Enforce: stage='nurture' requires nurture_wake_at ─────────────
--
-- Same two-layer enforcement as lost_reason (0069/0108): the trigger
-- fires on stage-change UPDATEs and raises a friendly message; the
-- table-level CHECK is the real backstop covering every INSERT/UPDATE
-- regardless of which trigger runs (matches 0108's own reasoning for
-- narrowing the stage-change trigger's WHEN clause).

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

  -- Enforce nurture_wake_at on nurture
  IF NEW.stage = 'nurture' AND NEW.nurture_wake_at IS NULL THEN
    RAISE EXCEPTION 'crm_leads.nurture_wake_at is required when stage = ''nurture''';
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

ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_nurture_wake_at_required
  CHECK (
    stage <> 'nurture' OR nurture_wake_at IS NOT NULL
  );

COMMENT ON COLUMN crm_leads.nurture_wake_at IS
  'Required when stage=''nurture'' (trigger + crm_leads_nurture_wake_at_required '
  'CHECK). Not auto-cleared on stage change — the rep decides when to act on wake, '
  'this column is not consulted once the lead has moved to a different stage.';
