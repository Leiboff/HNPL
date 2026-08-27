-- ─── CRM — building/unit address fields + duplicate-practice suggestions ─
--
-- Additive fields for a suggestion engine (lib/crm/addressMatch.ts),
-- shipped dark behind ENABLE_CRM_ADDRESS_SUGGESTIONS
-- (lib/featureFlags.ts, default OFF) — the engine is useless below a
-- few hundred leads and would look broken on sparse data.
--
-- CRITICAL: same-building-different-unit must stay LOW confidence in
-- the matching logic — SA medical buildings (Life Fourways, Netcare
-- Sunninghill, Morningside Mediclinic) hold dozens of unrelated
-- practices. This migration only stores the fields + a lookup key;
-- the confidence ranking lives in lib/crm/addressMatch.ts.
--
-- building_name/unit are backfilled NULL for existing rows — no
-- attempt is made to parse existing formatted_address values here.
-- See scripts/backfill-crm-address-fields.ts for an admin-run backfill.

-- ── 1. New columns on crm_leads ────────────────────────────────────

ALTER TABLE crm_leads
  ADD COLUMN IF NOT EXISTS building_name     TEXT,
  ADD COLUMN IF NOT EXISTS unit              TEXT,
  ADD COLUMN IF NOT EXISTS landline          TEXT,
  ADD COLUMN IF NOT EXISTS address_match_key TEXT;

-- ── 2. Normalisation mirror of lib/crm/addressMatch.ts normaliseAddress ─
--
-- Lowercase, strip punctuation, expand common street abbreviations,
-- drop noise words. Kept as a standalone IMMUTABLE-ish helper (STABLE,
-- not IMMUTABLE — array literals inside make Postgres reject IMMUTABLE)
-- so the BEFORE trigger below can call it. This is the SQL-side mirror
-- used ONLY to produce an indexable candidate-lookup key —
-- address_match_key is not itself the source of the confidence
-- signals, which compare building_name/unit/landline/lat/lng directly
-- in application code.

CREATE OR REPLACE FUNCTION crm_normalise_address_text(input TEXT)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  noise  TEXT[] := ARRAY['hospital','medical','centre','center','complex','park','the'];
  abbrev TEXT[][] := ARRAY[
    ARRAY['st','street'], ARRAY['rd','road'], ARRAY['dr','drive'],
    ARRAY['ave','avenue'], ARRAY['blvd','boulevard'], ARRAY['cnr','corner'], ARRAY['ext','extension']
  ];
  tokens     TEXT[];
  out_tokens TEXT[] := '{}';
  w          TEXT;
  pair       TEXT[];
BEGIN
  IF input IS NULL OR btrim(input) = '' THEN RETURN ''; END IF;

  tokens := regexp_split_to_array(
    trim(regexp_replace(lower(regexp_replace(input, '[^[:alnum:]\s]', ' ', 'g')), '\s+', ' ', 'g')),
    ' '
  );

  FOREACH w IN ARRAY tokens LOOP
    IF w = '' OR w = ANY(noise) THEN CONTINUE; END IF;
    FOREACH pair SLICE 1 IN ARRAY abbrev LOOP
      IF w = pair[1] THEN w := pair[2]; END IF;
    END LOOP;
    out_tokens := array_append(out_tokens, w);
  END LOOP;

  RETURN array_to_string(out_tokens, ' ');
END;
$$;

-- ── 3. BEFORE INSERT/UPDATE trigger — populate address_match_key ─────

CREATE OR REPLACE FUNCTION crm_leads_set_address_match_key()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.address_match_key := NULLIF(
    concat_ws('|',
      NULLIF(crm_normalise_address_text(COALESCE(NEW.street_address, NEW.formatted_address, '')), ''),
      NULLIF(crm_normalise_address_text(COALESCE(NEW.suburb, '')), '')
    ),
    ''
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_crm_leads_set_address_match_key ON crm_leads;
CREATE TRIGGER trg_crm_leads_set_address_match_key
  BEFORE INSERT OR UPDATE ON crm_leads
  FOR EACH ROW
  EXECUTE FUNCTION crm_leads_set_address_match_key();

-- Backfill address_match_key for existing rows by re-triggering the
-- BEFORE UPDATE function (a no-op assignment is enough — the trigger
-- recomputes NEW.address_match_key from street_address/formatted_address/
-- suburb itself). NOTE: this necessarily also fires every other
-- unconditional BEFORE/AFTER UPDATE trigger on crm_leads for every
-- row — touch_updated_at bumps updated_at, and 0109's audit trigger
-- writes one crm_audit_log row per lead. Accepted as a one-time cost
-- of this migration rather than special-cased away.
UPDATE crm_leads SET address_match_key = address_match_key;

CREATE INDEX IF NOT EXISTS crm_leads_address_match_key_idx
  ON crm_leads(address_match_key)
  WHERE address_match_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_leads_building_name_idx
  ON crm_leads(lower(building_name))
  WHERE building_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_leads_landline_idx
  ON crm_leads(lower(landline))
  WHERE landline IS NOT NULL;

-- ── 4. crm_suggestion_dismissals ─────────────────────────────────────
--
-- lead_a_id < lead_b_id always (the lower UUID first — matches
-- lib/crm/addressMatch.ts orderedLeadPair) so a dismissal is
-- symmetric regardless of which of the two leads it's dismissed from.

CREATE TABLE IF NOT EXISTS crm_suggestion_dismissals (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_a_id    UUID        NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  lead_b_id    UUID        NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
  kind         TEXT        NOT NULL CHECK (kind IN ('duplicate_practice', 'prospecting_hint')),
  dismissed_by UUID        REFERENCES profiles(id) ON DELETE SET NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT crm_suggestion_dismissals_ordered_pair CHECK (lead_a_id < lead_b_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS crm_suggestion_dismissals_pair_kind_uidx
  ON crm_suggestion_dismissals(lead_a_id, lead_b_id, kind);

ALTER TABLE crm_suggestion_dismissals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crm_suggestion_dismissals_admin_sales_select"
  ON crm_suggestion_dismissals FOR SELECT
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_suggestion_dismissals_admin_sales_insert"
  ON crm_suggestion_dismissals FOR INSERT
  WITH CHECK ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

CREATE POLICY "crm_suggestion_dismissals_admin_sales_delete"
  ON crm_suggestion_dismissals FOR DELETE
  USING ((SELECT role FROM profiles WHERE id = auth.uid()) IN ('admin', 'sales'));

COMMENT ON TABLE crm_suggestion_dismissals IS
  'A dismissed (lead_a_id, lead_b_id, kind) triple is never re-suggested. '
  'lead_a_id < lead_b_id always so the dismissal is symmetric. No UPDATE '
  'policy — a dismissal is either present or deleted, never edited.';
