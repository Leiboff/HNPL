-- ─── CRM — contact interest + decision-maker flag ─────────────────────
--
-- Two additive columns on crm_lead_contacts. Neither is mirrored onto
-- crm_leads by the 0075 primary-contact mirror triggers — that mirror
-- is scoped to identity fields (name/role/phone/email) only, and
-- interest in particular must never collapse to a single per-lead
-- value (a practice can have a cold receptionist and a hot doctor at
-- once). Lead-level interest is DERIVED at read time by
-- lib/crm/interest.ts, not stored.

ALTER TABLE crm_lead_contacts
  ADD COLUMN IF NOT EXISTS interest TEXT NOT NULL DEFAULT 'unknown'
    CHECK (interest IN ('unknown', 'cold', 'warm', 'hot')),
  ADD COLUMN IF NOT EXISTS is_decision_maker BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: today's leads are effectively single-contact (the primary
-- IS the decision maker in practice), so seed is_decision_maker from
-- is_primary for existing rows. This is a one-time backfill, not an
-- ongoing sync — going forward the two flags are independently
-- editable (a group practice can have several decision makers, none
-- of whom need be the primary contact).
UPDATE crm_lead_contacts SET is_decision_maker = TRUE WHERE is_primary IS TRUE;

COMMENT ON COLUMN crm_lead_contacts.interest IS
  'Per-contact temperature. NEVER mirrored onto crm_leads — a lead''s '
  'displayed interest is derived at read time (lib/crm/interest.ts): '
  'hottest among decision-maker contacts, falling back to hottest '
  'overall when there is no decision maker on file.';

COMMENT ON COLUMN crm_lead_contacts.is_decision_maker IS
  'No uniqueness constraint — group practices legitimately have '
  'several decision makers. Backfilled TRUE from is_primary on '
  'existing rows; independently editable thereafter.';
