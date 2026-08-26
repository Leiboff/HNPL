-- ─── CRM Phase 1.5 — scale and integrity ──────────────────────────────
--
-- 1. Trigram GIN indexes to serve the search box's ILIKE '%…%' on
--    practice name and contact name — the existing lower(email) /
--    lower(phone) btrees don't serve that query shape at all.
-- 2. A unique index guarding against duplicate practice+suburb among
--    non-archived leads. Verified zero duplicates on 26 Aug 2026 via
--    `select lower(trim(practice_name)), coalesce(lower(trim(suburb)),'')
--     from crm_leads group by 1,2 having count(*) > 1` — re-run here
--     immediately before creating the index; the migration aborts
--     (via the unique index creation itself failing) rather than
--     deleting anything if that has changed.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS crm_leads_practice_name_trgm_idx
  ON crm_leads USING GIN (practice_name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS crm_leads_contact_name_trgm_idx
  ON crm_leads USING GIN (
    (contact_first_name || ' ' || contact_last_name) gin_trgm_ops
  );

CREATE INDEX IF NOT EXISTS crm_lead_contacts_name_trgm_idx
  ON crm_lead_contacts USING GIN (
    (first_name || ' ' || last_name) gin_trgm_ops
  );

-- Duplicate-practice+suburb guard, scoped to non-archived leads so an
-- archived lead never blocks re-creating that practice as a new one
-- (see test 18). CREATE UNIQUE INDEX itself re-verifies zero
-- duplicates transactionally — if the pre-check below finds any, the
-- migration RAISEs and stops rather than deleting or merging rows.

DO $$
DECLARE
  v_dupes INT;
BEGIN
  SELECT count(*) INTO v_dupes FROM (
    SELECT lower(trim(practice_name)) AS pn, coalesce(lower(trim(suburb)), '') AS sb
      FROM crm_leads
     WHERE archived_at IS NULL
     GROUP BY 1, 2
    HAVING count(*) > 1
  ) d;

  IF v_dupes > 0 THEN
    RAISE EXCEPTION 'crm_leads has % duplicate (practice_name, suburb) pair(s) among non-archived leads — resolve before adding the unique index', v_dupes;
  END IF;

  RAISE NOTICE 'duplicate practice+suburb pairs found before adding unique index: 0';
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS crm_leads_practice_suburb_uidx
  ON crm_leads (lower(trim(practice_name)), coalesce(lower(trim(suburb)), ''))
  WHERE archived_at IS NULL;
