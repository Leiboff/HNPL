-- ─── Backfill: normalise profiles.phone and practices.phone to E.164 ───────
--
-- Rewrites every parseable phone value to "+27XXXXXXXXX" so storage matches
-- what lib/validation/phone.ts produces for new writes from now on.
-- Unparseable values are LOGGED via RAISE NOTICE and then SET TO NULL so
-- the post-migration invariant is clean:
--
--     after this migration, every non-null `phone` in profiles and
--     practices satisfies ^\+27[1-8][0-9]{8}$. NULL means "we don't
--     have a usable number; ask the user to re-enter it".
--
-- The dashboard treats `phone IS NULL` on the current user / practice as
-- a "please re-enter your phone" signal — no extra column needed (see
-- CLAUDE.md ▸ Database migrations ▸ phone-needs-reentry signal).
--
-- The acceptance criteria are deliberately the looser of the two surfaces:
-- first digit 1-8 (i.e. allow landlines on profiles too, even though new
-- patient signup enforces mobile-only). Backfilling is about format
-- consistency, not relitigating prior data.
--
-- The CASE / regex match here MUST stay in sync with
-- scripts/audit-phone-normalization.sql and lib/validation/phone.ts.
--
-- Pre-flight: run scripts/audit-phone-normalization.sql in the SQL editor
-- BEFORE pushing this migration to preview the unparseable-row count.

CREATE OR REPLACE FUNCTION __normalize_phone_za_0042(input text) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  cleaned text;
BEGIN
  IF input IS NULL OR length(trim(input)) = 0 THEN RETURN NULL; END IF;
  cleaned := regexp_replace(input, '[\s\-()]', '', 'g');
  IF cleaned ~ '^\+27[1-8][0-9]{8}$' THEN RETURN cleaned;
  ELSIF cleaned ~ '^27[1-8][0-9]{8}$'   THEN RETURN '+' || cleaned;
  ELSIF cleaned ~ '^0[1-8][0-9]{8}$'    THEN RETURN '+27' || substring(cleaned FROM 2);
  ELSE RETURN NULL;
  END IF;
END;
$$;

DO $$
DECLARE
  v_row     record;
  v_norm    text;
  v_p_unp   int := 0;   -- profiles unparseable → NULLed
  v_p_upd   int := 0;   -- profiles parseable   → normalised
  v_x_unp   int := 0;   -- practices unparseable → NULLed
  v_x_upd   int := 0;   -- practices parseable   → normalised
BEGIN
  -- ── profiles.phone ─────────────────────────────────────────────────────
  FOR v_row IN
    SELECT id, phone FROM profiles WHERE phone IS NOT NULL AND phone <> ''
  LOOP
    v_norm := __normalize_phone_za_0042(v_row.phone);
    IF v_norm IS NULL THEN
      RAISE NOTICE 'profiles.phone NULLed (unparseable) id=% masked=%',
        v_row.id, regexp_replace(v_row.phone, '\d', '•', 'g');
      UPDATE profiles SET phone = NULL WHERE id = v_row.id;
      v_p_unp := v_p_unp + 1;
    ELSIF v_norm <> v_row.phone THEN
      UPDATE profiles SET phone = v_norm WHERE id = v_row.id;
      v_p_upd := v_p_upd + 1;
    END IF;
  END LOOP;

  -- ── practices.phone ────────────────────────────────────────────────────
  FOR v_row IN
    SELECT id, phone FROM practices WHERE phone IS NOT NULL AND phone <> ''
  LOOP
    v_norm := __normalize_phone_za_0042(v_row.phone);
    IF v_norm IS NULL THEN
      RAISE NOTICE 'practices.phone NULLed (unparseable) id=% masked=%',
        v_row.id, regexp_replace(v_row.phone, '\d', '•', 'g');
      UPDATE practices SET phone = NULL WHERE id = v_row.id;
      v_x_unp := v_x_unp + 1;
    ELSIF v_norm <> v_row.phone THEN
      UPDATE practices SET phone = v_norm WHERE id = v_row.id;
      v_x_upd := v_x_upd + 1;
    END IF;
  END LOOP;

  RAISE NOTICE 'Phone backfill summary: profiles normalised=% nulled=%; practices normalised=% nulled=%',
    v_p_upd, v_p_unp, v_x_upd, v_x_unp;
END;
$$;

DROP FUNCTION __normalize_phone_za_0042(text);
