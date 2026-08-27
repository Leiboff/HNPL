-- ─── CRM — practitioner identity across practices (HPCSA grouping) ─────
--
-- Follows the exact precedent set by migration 0064 (the patient-facing
-- practitioner discovery view): group a person across practices by
-- md5 of their normalised HPCSA
-- number. No separate people table — same as 0064's reasoning, this is
-- a grouping key, not an identity table.
--
-- Raw HPCSA numbers stay internal to the CRM — admin/sales RLS on
-- crm_lead_contacts (0075) already covers this table; they are never
-- exposed through any patient-facing view (this migration touches
-- nothing patient-facing).

ALTER TABLE crm_lead_contacts
  ADD COLUMN IF NOT EXISTS hpcsa_number    TEXT,
  ADD COLUMN IF NOT EXISTS hpcsa_group_key TEXT;

-- ── Trigger — populate hpcsa_group_key, matching 0064's normalisation
--    (trim + lower, empty-after-trim treated the same as NULL) exactly.
--
-- NULL hpcsa_group_key must never hide a contact — same rule as 0064.
-- This trigger only ever WRITES the key; nothing here filters rows.

CREATE OR REPLACE FUNCTION crm_lead_contacts_set_hpcsa_group_key()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.hpcsa_number IS NULL OR LENGTH(TRIM(NEW.hpcsa_number)) = 0 THEN
    NEW.hpcsa_group_key := NULL;
  ELSE
    NEW.hpcsa_group_key := md5(LOWER(TRIM(NEW.hpcsa_number)));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_lead_contacts_set_hpcsa_group_key ON crm_lead_contacts;
CREATE TRIGGER trg_crm_lead_contacts_set_hpcsa_group_key
  BEFORE INSERT OR UPDATE ON crm_lead_contacts
  FOR EACH ROW
  EXECUTE FUNCTION crm_lead_contacts_set_hpcsa_group_key();

CREATE INDEX IF NOT EXISTS crm_lead_contacts_hpcsa_group_key_idx
  ON crm_lead_contacts(hpcsa_group_key)
  WHERE hpcsa_group_key IS NOT NULL;

COMMENT ON COLUMN crm_lead_contacts.hpcsa_number IS
  'Raw HPCSA registration number. Internal to the CRM (admin/sales RLS via 0075) — never exposed through any patient-facing view.';

COMMENT ON COLUMN crm_lead_contacts.hpcsa_group_key IS
  'md5(lower(trim(hpcsa_number))), set by trigger. Matches the 0064 directory view normalisation exactly. NULL when no HPCSA on file — NULL must never hide a contact, same rule as 0064.';
