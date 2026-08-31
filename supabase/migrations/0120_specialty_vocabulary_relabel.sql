-- ─── Specialty vocabulary — relabel the pre-2026-08 values ─────────────
--
-- The UI vocabulary moved from nine discipline names ("Dentistry",
-- "Physiotherapy", …) to the 60-entry register of practitioner titles
-- in lib/specialties.ts ("General Dental Practitioner",
-- "Physiotherapist", …), so one value can label both a CRM lead and a
-- signed-up practitioner.
--
-- specialty is free text everywhere it is stored (no CHECK, no enum —
-- see 0069), so nothing broke when the list changed: existing rows just
-- kept saying "Dentistry". That is not harmless. The patient portal's
-- "Browse by specialty" landing is inventory-driven
-- (lib/practitioner/categories.ts) — it renders one tile per DISTINCT
-- stored value with ≥1 practitioner — so leaving the old labels in
-- place would show a patient "Dentistry" and "General Dental
-- Practitioner" as two unrelated specialties, splitting one specialty's
-- practitioners across two tiles.
--
-- This relabels ONLY the values whose meaning is unambiguous, and it
-- mirrors the synonym table in lib/specialties.ts exactly (pinned by
-- 0120_specialty_vocabulary_relabel.test.ts). Deliberately NOT touched:
--
--   • 'Nursing', 'Pharmacy' — no register equivalent (a pharmacist is
--     not a "Pharmacotherapist", which is a distinct registration).
--   • 'Specialist Medicine' — could be any of a dozen register entries.
--   • 'Other', and any free-text label a bulk import left behind.
--
-- Those keep their stored value: a wrong specialty on a real
-- practitioner is worse than an off-register one, and the dropdowns
-- keep an off-register value selected and visible
-- (components/SpecialtyOptions.tsx) so a human can relabel it.
--
-- Idempotent: matches whole stored values only, and every target is
-- already a register entry, so a re-run is a no-op.

-- ── The mapping, once ──────────────────────────────────────────────

CREATE TEMP TABLE specialty_relabel (old_value TEXT PRIMARY KEY, new_value TEXT NOT NULL);

INSERT INTO specialty_relabel (old_value, new_value) VALUES
  ('General Practice',       'General Medical Practitioner (GP)'),
  ('General Practitioner',   'General Medical Practitioner (GP)'),
  ('GP',                     'General Medical Practitioner (GP)'),
  ('Dentistry',              'General Dental Practitioner'),
  ('Dentist',                'General Dental Practitioner'),
  ('Physiotherapy',          'Physiotherapist'),
  ('Optometry',              'Optometrist'),
  ('Psychology',             'Psychologist'),
  ('Gynaecologist',          'Obstetrician and Gynaecologist'),
  ('Specialist Physician',   'Physician');

-- ── Every column that stores a specialty ───────────────────────────
--
-- practices.specialty        — practice-level (signup, /practice/setup)
-- practices.admin_specialty  — the admin's own, when they self-elect
-- practice_members.specialty — the per-practitioner label the patient
--                              portal reads through the directory view
-- practice_invitations.specialty — pre-fill for an unaccepted invite
-- crm_leads.specialty        — the sales-side label

UPDATE practices p
   SET specialty = r.new_value
  FROM specialty_relabel r
 WHERE p.specialty = r.old_value;

UPDATE practices p
   SET admin_specialty = r.new_value
  FROM specialty_relabel r
 WHERE p.admin_specialty = r.old_value;

UPDATE practice_members m
   SET specialty = r.new_value
  FROM specialty_relabel r
 WHERE m.specialty = r.old_value;

UPDATE practice_invitations i
   SET specialty = r.new_value
  FROM specialty_relabel r
 WHERE i.specialty = r.old_value;

UPDATE crm_leads l
   SET specialty = r.new_value
  FROM specialty_relabel r
 WHERE l.specialty = r.old_value;

DROP TABLE specialty_relabel;
