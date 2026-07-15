-- ─── CRM lead-page upgrades — contacts + street address + invite prefill
--
-- Bundles four schema needs for a single UX pass on the lead detail
-- page. Additive only; existing rows/columns keep working through the
-- mirror rule (see §5).
--
--   1. crm_leads.street_address  — Places autocomplete now writes the
--      street line separately from the parsed suburb/city/province.
--
--   2. practice_invitations gains street_address + suburb + city +
--      province so the practice-signup form can prefill the picked
--      address on redemption. The RPC (0068) is redefined to return
--      the new columns.
--
--   3. crm_lead_contacts — one row per human at a practice. The lead's
--      existing contact_first_name / contact_last_name / role_at_practice
--      / phone / email columns are KEPT and mirror the PRIMARY contact
--      via triggers. This is a deliberate design choice so every
--      existing consumer (dedupe, CSV import, public /practices form,
--      compose prefill, list search, board card, inbound tray) keeps
--      reading from crm_leads and needs no per-consumer rewrite.
--
--   4. Backfill: one primary contact per existing lead, materialised
--      inside this migration so the mirror rule holds from the moment
--      the columns are added.
--
-- Consumers of the lead columns that keep working unchanged (checked
-- by Step 0): app/crm/page.tsx inbound tray, app/crm/leads/page.tsx
-- list, app/crm/board/page.tsx board, app/crm/leads/[id]/page.tsx
-- detail (SELECT *), lib/crm/dedupe.ts, app/crm/import/actions.ts CSV,
-- app/practices/publicLeadAction.ts public form, and the compose
-- prefill in app/crm/leads/[id]/composeEmail.ts.

-- ─── 1. crm_leads.street_address ────────────────────────────────────

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS street_address TEXT;

-- ─── 2. practice_invitations — prefill address on signup ────────────

ALTER TABLE practice_invitations
  ADD COLUMN IF NOT EXISTS street_address TEXT,
  ADD COLUMN IF NOT EXISTS suburb         TEXT,
  ADD COLUMN IF NOT EXISTS city           TEXT,
  ADD COLUMN IF NOT EXISTS province       TEXT;

-- Redefine the anonymous-safe token lookup to surface the new fields.
-- Signature changed (return columns added), so the RPC is CREATE OR
-- REPLACE — PostgreSQL treats a RETURNS TABLE difference as a signature
-- change; DROP first so a re-run against a DB that already has the old
-- signature doesn't error.
DROP FUNCTION IF EXISTS get_practice_invitation_by_token(TEXT);

CREATE OR REPLACE FUNCTION get_practice_invitation_by_token(p_token TEXT)
RETURNS TABLE (
  email               TEXT,
  practice_name       TEXT,
  contact_first_name  TEXT,
  contact_last_name   TEXT,
  phone               TEXT,
  specialty           TEXT,
  street_address      TEXT,
  suburb              TEXT,
  city                TEXT,
  province            TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    pi.email,
    pi.practice_name,
    pi.contact_first_name,
    pi.contact_last_name,
    pi.phone,
    pi.specialty,
    pi.street_address,
    pi.suburb,
    pi.city,
    pi.province
  FROM practice_invitations pi
  WHERE pi.token = p_token
    AND pi.accepted_at IS NULL
    AND pi.expires_at  > now()
  LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION get_practice_invitation_by_token(TEXT) TO anon, authenticated;

-- ─── 3. crm_lead_contacts ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS crm_lead_contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id           UUID        NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  first_name        TEXT        NOT NULL,
  last_name         TEXT        NOT NULL,
  role_at_practice  TEXT,
  phone             TEXT,
  email             TEXT,
  is_primary        BOOLEAN     NOT NULL DEFAULT FALSE,
  notes             TEXT,
  created_by        UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS crm_lead_contacts_lead_idx
  ON crm_lead_contacts(lead_id);
CREATE INDEX IF NOT EXISTS crm_lead_contacts_phone_idx
  ON crm_lead_contacts(lower(phone))
  WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_lead_contacts_email_idx
  ON crm_lead_contacts(lower(email))
  WHERE email IS NOT NULL;

-- Exactly one primary per lead. Partial UNIQUE lets non-primary rows
-- coexist without any constraint pressure. Guard: enforced by both
-- this index and the trigger below.
CREATE UNIQUE INDEX IF NOT EXISTS crm_lead_contacts_one_primary_per_lead
  ON crm_lead_contacts(lead_id)
  WHERE is_primary;

-- ─── 4. RLS — mirror crm_leads (sales + admin) ──────────────────────

ALTER TABLE crm_lead_contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_lead_contacts_admin_sales_select"
  ON crm_lead_contacts FOR SELECT
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_lead_contacts_admin_sales_insert"
  ON crm_lead_contacts FOR INSERT
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_lead_contacts_admin_sales_update"
  ON crm_lead_contacts FOR UPDATE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  )
  WITH CHECK (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

CREATE POLICY "crm_lead_contacts_admin_sales_delete"
  ON crm_lead_contacts FOR DELETE
  USING (
    (SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales')
  );

-- ─── 5. Mirror rule — primary contact <-> lead columns ──────────────
--
-- Two triggers, symmetric:
--   (a) After a lead is INSERTed, seed a primary contact from its
--       contact_* / phone / email / role_at_practice fields.
--   (b) After a lead UPDATE that changed any of those fields, propagate
--       the new values to the row's primary contact.
--   (c) After a contact INSERT/UPDATE with is_primary=true, propagate
--       to the parent lead's contact_* columns.
--
-- Loop prevention: every UPDATE uses `IS DISTINCT FROM` in its WHERE
-- clause, so if the target already has the incoming values (which it
-- always does the second time around) the UPDATE affects zero rows and
-- the cascading trigger never fires. This is the same technique the
-- existing patient-profile mirror uses.

CREATE OR REPLACE FUNCTION crm_leads_seed_primary_contact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Belt-and-braces: don't create if one somehow already exists (e.g.
  -- because the caller inserted both rows in the same txn — unlikely
  -- with the current server actions but harmless to guard).
  IF NOT EXISTS (
    SELECT 1 FROM crm_lead_contacts
     WHERE lead_id = NEW.id AND is_primary
  ) THEN
    INSERT INTO crm_lead_contacts (
      lead_id, first_name, last_name, role_at_practice,
      phone, email, is_primary, created_by
    ) VALUES (
      NEW.id,
      NEW.contact_first_name,
      NEW.contact_last_name,
      NEW.role_at_practice,
      NEW.phone,
      NEW.email,
      TRUE,
      NEW.created_by
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_seed_primary_contact ON crm_leads;
CREATE TRIGGER trg_crm_leads_seed_primary_contact
  AFTER INSERT ON crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION crm_leads_seed_primary_contact();

-- Lead → primary contact (mirror down)
CREATE OR REPLACE FUNCTION crm_leads_mirror_to_primary_contact()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF (NEW.contact_first_name, NEW.contact_last_name, NEW.role_at_practice, NEW.phone, NEW.email)
     IS DISTINCT FROM
     (OLD.contact_first_name, OLD.contact_last_name, OLD.role_at_practice, OLD.phone, OLD.email)
  THEN
    UPDATE crm_lead_contacts
       SET first_name       = NEW.contact_first_name,
           last_name        = NEW.contact_last_name,
           role_at_practice = NEW.role_at_practice,
           phone            = NEW.phone,
           email            = NEW.email
     WHERE lead_id = NEW.id
       AND is_primary
       AND (first_name, last_name, role_at_practice, phone, email)
           IS DISTINCT FROM
           (NEW.contact_first_name, NEW.contact_last_name, NEW.role_at_practice, NEW.phone, NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_mirror_to_primary_contact ON crm_leads;
CREATE TRIGGER trg_crm_leads_mirror_to_primary_contact
  AFTER UPDATE ON crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION crm_leads_mirror_to_primary_contact();

-- Primary contact → lead (mirror up)
CREATE OR REPLACE FUNCTION crm_lead_contacts_mirror_to_lead()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.is_primary THEN
    UPDATE crm_leads
       SET contact_first_name = NEW.first_name,
           contact_last_name  = NEW.last_name,
           role_at_practice   = NEW.role_at_practice,
           phone              = NEW.phone,
           email              = NEW.email
     WHERE id = NEW.lead_id
       AND (contact_first_name, contact_last_name, role_at_practice, phone, email)
           IS DISTINCT FROM
           (NEW.first_name, NEW.last_name, NEW.role_at_practice, NEW.phone, NEW.email);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_contacts_mirror_to_lead ON crm_lead_contacts;
CREATE TRIGGER trg_crm_lead_contacts_mirror_to_lead
  AFTER INSERT OR UPDATE ON crm_lead_contacts
  FOR EACH ROW
  EXECUTE FUNCTION crm_lead_contacts_mirror_to_lead();

-- Guard: cannot delete the last contact of a lead. Removing a primary
-- must be preceded by promoting another (app-level flow — this trigger
-- is the DB-level backstop).
CREATE OR REPLACE FUNCTION crm_lead_contacts_guard_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_remaining INTEGER;
  v_primary_remaining BOOLEAN;
BEGIN
  -- If the parent lead is being cascade-deleted, allow. Detect by
  -- checking whether the lead row still exists.
  IF NOT EXISTS (SELECT 1 FROM crm_leads WHERE id = OLD.lead_id) THEN
    RETURN OLD;
  END IF;

  SELECT COUNT(*) INTO v_remaining
    FROM crm_lead_contacts
   WHERE lead_id = OLD.lead_id
     AND id <> OLD.id;
  IF v_remaining = 0 THEN
    RAISE EXCEPTION 'cannot delete the last contact of a lead'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.is_primary THEN
    SELECT EXISTS (
      SELECT 1 FROM crm_lead_contacts
       WHERE lead_id = OLD.lead_id
         AND id <> OLD.id
         AND is_primary
    ) INTO v_primary_remaining;
    IF NOT v_primary_remaining THEN
      RAISE EXCEPTION 'cannot delete the primary contact — promote another first'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_contacts_guard_delete ON crm_lead_contacts;
CREATE TRIGGER trg_crm_lead_contacts_guard_delete
  BEFORE DELETE ON crm_lead_contacts
  FOR EACH ROW
  EXECUTE FUNCTION crm_lead_contacts_guard_delete();

-- updated_at auto-touch on crm_lead_contacts
CREATE OR REPLACE FUNCTION crm_lead_contacts_touch_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_contacts_touch_updated_at ON crm_lead_contacts;
CREATE TRIGGER trg_crm_lead_contacts_touch_updated_at
  BEFORE UPDATE ON crm_lead_contacts
  FOR EACH ROW
  EXECUTE FUNCTION crm_lead_contacts_touch_updated_at();

-- ─── 6. Backfill: one primary contact per existing lead ─────────────
--
-- We INSERT directly, bypassing the seed trigger — the trigger would
-- also fire on any older leads whose contact_* fields are empty, but
-- since crm_leads.contact_first_name/last_name are NOT NULL from
-- 0069 we know every legacy row has values to copy.
--
-- ON CONFLICT DO NOTHING (via the WHERE NOT EXISTS subselect) so re-
-- running this migration in dev is safe.

INSERT INTO crm_lead_contacts (
  lead_id, first_name, last_name, role_at_practice,
  phone, email, is_primary, created_by
)
SELECT
  l.id,
  l.contact_first_name,
  l.contact_last_name,
  l.role_at_practice,
  l.phone,
  l.email,
  TRUE,
  l.created_by
FROM crm_leads l
WHERE NOT EXISTS (
  SELECT 1 FROM crm_lead_contacts c
   WHERE c.lead_id = l.id AND c.is_primary
);

COMMENT ON TABLE crm_lead_contacts IS
  'One row per human at a practice — receptionist, practice manager, '
  'doctor, owner, etc. Exactly one row per lead is is_primary=true. '
  'The lead''s contact_first_name/contact_last_name/role_at_practice/'
  'phone/email columns mirror the primary contact via triggers so '
  'every existing consumer keeps reading from crm_leads.';
