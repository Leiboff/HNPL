-- ─── CRM Phase 1 — leads + activities ────────────────────────────────────
--
-- Internal CRM for the sales team (head of sales + founder). Two tables:
--
--   crm_leads       one row per practice/practitioner being pursued
--   crm_activities  timeline entries (calls, meetings, notes, stage changes)
--
-- Access is scoped to profiles.role IN ('sales', 'admin'). Nothing else
-- reaches these tables. RLS policies are self-contained here — CRM
-- does not touch existing tables except:
--   (a) reading the specialty vocabulary (a TS constant, not a table)
--   (b) the converted_practice_id FK on crm_leads → practices(id)
--   (c) the sales role addition (0067)
--
-- Stage changes are auto-logged as crm_activities rows by a BEFORE
-- UPDATE trigger. The signed→onboarded flip is driven by a per-row
-- trigger on practices that fires when status transitions to
-- 'approved' — if the practice was created via a practice_invitation
-- whose lead is in stage='signed', the lead advances to 'onboarded'.

-- ── 1. crm_leads ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_leads (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Practice identity
  practice_name               TEXT        NOT NULL,
  contact_first_name          TEXT        NOT NULL,
  contact_last_name           TEXT        NOT NULL,
  role_at_practice            TEXT,       -- e.g. Owner, Practice Manager, Receptionist
  specialty                   TEXT,       -- free text, seeded from SPECIALTIES

  -- Contact channels
  phone                       TEXT,
  email                       TEXT,

  -- Location (from Places autocomplete)
  suburb                      TEXT,
  city                        TEXT,
  province                    TEXT,
  latitude                    NUMERIC,
  longitude                   NUMERIC,
  formatted_address           TEXT,

  -- Pipeline
  source                      TEXT        NOT NULL DEFAULT 'other'
    CHECK (source IN ('referral', 'cold_outreach', 'inbound', 'event', 'other')),

  stage                       TEXT        NOT NULL DEFAULT 'new'
    CHECK (stage IN (
      'new', 'contacted', 'meeting_scheduled', 'demo_done',
      'agreement_sent', 'signed', 'onboarded', 'lost'
    )),

  lost_reason                 TEXT,       -- required when stage='lost' (checked by trigger below)

  -- Deal size proxy
  estimated_monthly_billings  NUMERIC,

  -- Ownership + audit
  owner_user_id               UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_by                  UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Follow-up scheduling (single "what's next" pointer)
  next_follow_up_at           TIMESTAMPTZ,

  -- Conversion linkage (set by the accept_practice_invitation RPC)
  converted_practice_id       UUID        REFERENCES practices(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS crm_leads_owner_idx        ON crm_leads(owner_user_id);
CREATE INDEX IF NOT EXISTS crm_leads_stage_idx        ON crm_leads(stage);
CREATE INDEX IF NOT EXISTS crm_leads_followup_idx     ON crm_leads(next_follow_up_at)
  WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_practice_idx     ON crm_leads(converted_practice_id)
  WHERE converted_practice_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_leads_phone_idx        ON crm_leads(lower(phone));
CREATE INDEX IF NOT EXISTS crm_leads_email_idx        ON crm_leads(lower(email));

-- ── 2. crm_activities ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_activities (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id      UUID        NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  type         TEXT        NOT NULL
    CHECK (type IN ('call', 'meeting', 'whatsapp', 'email', 'note', 'stage_change')),
  title        TEXT        NOT NULL,
  body         TEXT,
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_activities_lead_idx      ON crm_activities(lead_id);
CREATE INDEX IF NOT EXISTS crm_activities_occurred_idx  ON crm_activities(occurred_at DESC);

-- ── 3. Wire up the lead_id FK on practice_invitations ────────────────
--
-- Delayed from 0068 so that migration didn't depend on this one's
-- crm_leads table already existing. Now that crm_leads is in place,
-- add the FK constraint.

ALTER TABLE practice_invitations
  ADD CONSTRAINT practice_invitations_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES crm_leads(id) ON DELETE SET NULL
  NOT VALID;  -- NOT VALID to survive re-application on legacy databases

ALTER TABLE practice_invitations VALIDATE CONSTRAINT practice_invitations_lead_id_fkey;

-- ── 4. updated_at auto-touch ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION crm_leads_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_touch_updated_at ON crm_leads;
CREATE TRIGGER trg_crm_leads_touch_updated_at
  BEFORE UPDATE ON crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION crm_leads_touch_updated_at();

-- ── 5. Stage transition guard + auto-activity log ────────────────────
--
-- Enforces "moving to 'lost' requires lost_reason". Also logs a
-- stage_change activity on every actual stage transition. Runs on
-- both server-actions (session client via RLS) and service-role writes.

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
    INSERT INTO crm_activities (lead_id, type, title, body, created_by)
    VALUES (
      NEW.id,
      'stage_change',
      'Stage: ' || OLD.stage || ' → ' || NEW.stage,
      CASE
        WHEN NEW.stage = 'lost' THEN 'Reason: ' || NEW.lost_reason
        ELSE NULL
      END,
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
  WHEN (OLD.stage IS DISTINCT FROM NEW.stage OR NEW.stage = 'lost')
  EXECUTE FUNCTION crm_leads_stage_change();

-- ── 6. Insert-time lost guard ────────────────────────────────────────
--
-- The BEFORE UPDATE trigger above doesn't fire on INSERT. Add a
-- CHECK constraint so a new row can't be born in 'lost' with an
-- empty lost_reason.

ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_lost_reason_required
  CHECK (
    stage <> 'lost' OR (lost_reason IS NOT NULL AND btrim(lost_reason) <> '')
  );

-- ── 7. RLS ───────────────────────────────────────────────────────────

ALTER TABLE crm_leads      ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;

-- crm_leads — sales and admin have full access; nobody else sees anything.
CREATE POLICY "crm_leads_admin_sales_select"
  ON crm_leads FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_leads_admin_sales_insert"
  ON crm_leads FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_leads_admin_sales_update"
  ON crm_leads FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_leads_admin_sales_delete"
  ON crm_leads FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

-- crm_activities — same scope; timeline is not readable by anyone else.
CREATE POLICY "crm_activities_admin_sales_select"
  ON crm_activities FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_activities_admin_sales_insert"
  ON crm_activities FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_activities_admin_sales_update"
  ON crm_activities FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_activities_admin_sales_delete"
  ON crm_activities FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

-- ── 8. accept_practice_invitation — redefine to also stamp the lead ─
--
-- The base RPC in 0068 couldn't reference crm_leads (that table only
-- comes into being in this migration). Now that crm_leads exists we
-- redefine the function to ALSO set converted_practice_id on the
-- linked lead at accept-time. Approval-time flip to stage='onboarded'
-- still happens via the trigger below.

CREATE OR REPLACE FUNCTION accept_practice_invitation(
  p_token       TEXT,
  p_practice_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lead_id UUID;
BEGIN
  UPDATE practice_invitations
     SET accepted_at             = now(),
         accepted_by_practice_id = p_practice_id
   WHERE token         = p_token
     AND accepted_at   IS NULL
     AND expires_at    > now()
  RETURNING lead_id INTO v_lead_id;

  IF v_lead_id IS NOT NULL THEN
    UPDATE crm_leads
       SET converted_practice_id = p_practice_id
     WHERE id = v_lead_id
       AND converted_practice_id IS NULL;
  END IF;

  RETURN v_lead_id;
END;
$$;

-- ── 9. Auto-onboarded on practice approval ───────────────────────────
--
-- When a practice with an accepted practice_invitation gets approved by
-- a platform admin, flip the linked CRM lead from 'signed' to
-- 'onboarded'. Non-lost, non-onboarded leads with a matching
-- accepted_by_practice_id are the only rows updated.

CREATE OR REPLACE FUNCTION crm_flip_lead_onboarded_on_practice_approve()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    UPDATE crm_leads AS l
       SET stage = 'onboarded'
      FROM practice_invitations AS pi
     WHERE pi.accepted_by_practice_id = NEW.id
       AND pi.lead_id = l.id
       AND l.stage IN ('signed', 'agreement_sent');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_flip_lead_onboarded_on_practice_approve ON practices;
CREATE TRIGGER trg_crm_flip_lead_onboarded_on_practice_approve
  AFTER UPDATE OF status ON practices
  FOR EACH ROW
  EXECUTE FUNCTION crm_flip_lead_onboarded_on_practice_approve();

COMMENT ON FUNCTION crm_flip_lead_onboarded_on_practice_approve() IS
  'When a practice is approved, flip its CRM lead (found via accepted '
  'practice_invitations.lead_id) from signed → onboarded. Idempotent — '
  're-approval is a no-op because the WHERE clause filters on stage.';
