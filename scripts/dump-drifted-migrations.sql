-- ─── Dump the three migrations production has and this repo does not ───────
--
-- Paste this whole file into the Supabase web SQL Editor and click Run, or
-- run it with `psql "<connection string>" -f scripts/dump-drifted-migrations.sql`.
--
-- NOTHING HERE WRITES. Every statement is a SELECT against the catalogs.
--
-- WHY: `supabase db push` matches migrations on the VERSION alone. Production
-- recorded 0138 as `identity_signals`, 0139 as `unique_verified_phone` and
-- 0140 as `verified_phone_unique_index` — all applied out-of-band, none of
-- them ever written back into supabase/migrations. So a database rebuilt
-- from this repo comes back MISSING them. See docs/MIGRATION-HISTORY.md.
--
-- The DDL cannot be reconstructed from the application code: nothing in the
-- repository references an `identity_signals` object or a verified-phone
-- uniqueness constraint. It has to come out of the live database, which is
-- what this file is for.
--
-- Returns eight result sections — flip between the result tabs and paste
-- them back. Sections 1 and 2 are usually enough on their own; 3 to 8 are
-- the fallback for when `statements` came back null, which is what happens
-- for anything applied through the MCP, the dashboard or psql rather than
-- by the CLI.
--
--   1. the three recorded rows, INCLUDING the SQL if it was stored
--   2. the recorded history either side of them, for ordering
--   3. every object whose name looks like `identity_signals`
--   4. that table's columns
--   5. its constraints, indexes, RLS policies and triggers
--   6. every UNIQUE index anywhere that mentions a phone column
--   7. every constraint anywhere that mentions a phone column
--   8. profiles' indexes in full, since 0139/0140 most likely landed there
--
-- Sections 3-8 are deliberately loose (ILIKE '%...%'), because the point is
-- to find objects nobody here has seen. Over-matching costs a few rows to
-- read past; under-matching means transcribing a migration that is missing a
-- piece, and a half-copied security constraint is worse than a known gap.


-- 1. The three rows themselves.
--    to_jsonb(m) rather than a column list: the shape of this table has
--    changed across CLI versions, and this returns whatever it actually has.
--    If `statements` is present and non-null, THAT IS THE ANSWER — it is the
--    exact SQL that was applied, and sections 3-8 are unnecessary.
SELECT version, to_jsonb(m) AS full_row
  FROM supabase_migrations.schema_migrations m
 WHERE version IN ('0138', '0139', '0140')
 ORDER BY version;

-- 2. The recorded history around them, minus the SQL bodies so it stays
--    readable. Confirms the ordering and shows whether anything else has
--    drifted that nobody has noticed yet — compare this against the
--    filenames in supabase/migrations.
SELECT version, to_jsonb(m) - 'statements' AS row_without_sql
  FROM supabase_migrations.schema_migrations m
 WHERE version >= '0130'
 ORDER BY version;

-- 3. Anything named like identity_signals: tables, views, indexes,
--    sequences (relkind r/v/m/i/S/p), plus functions and types.
SELECT 'relation' AS kind, n.nspname AS schema, c.relname AS name,
       c.relkind::text AS detail
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND c.relname ILIKE '%identity%'
UNION ALL
SELECT 'function', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND p.proname ILIKE '%identity%'
UNION ALL
SELECT 'type', n.nspname, t.typname, t.typtype::text
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
   AND t.typname ILIKE '%identity%'
 ORDER BY 1, 3;

-- 4. Columns of whatever section 3 turned up, in declaration order — enough
--    to write the CREATE TABLE.
SELECT table_name, ordinal_position, column_name, data_type,
       character_maximum_length, numeric_precision, numeric_scale,
       is_nullable, column_default
  FROM information_schema.columns
 WHERE table_schema = 'public'
   AND table_name ILIKE '%identity%'
 ORDER BY table_name, ordinal_position;

-- 5. Its constraints, indexes, policies and triggers. pg_get_constraintdef
--    and indexdef both emit re-runnable SQL, so these paste almost verbatim
--    into a migration.
SELECT 'constraint' AS kind, rel.relname AS on_table, con.conname AS name,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
 WHERE n.nspname = 'public' AND rel.relname ILIKE '%identity%'
UNION ALL
SELECT 'index', tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename ILIKE '%identity%'
UNION ALL
SELECT 'policy ' || cmd, tablename, policyname,
       'USING (' || COALESCE(qual, '-') || ') WITH CHECK (' ||
       COALESCE(with_check, '-') || ') TO ' || array_to_string(roles, ', ')
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename ILIKE '%identity%'
UNION ALL
SELECT 'trigger', c.relname, t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t
  JOIN pg_class c ON c.oid = t.tgrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relname ILIKE '%identity%' AND NOT t.tgisinternal
 ORDER BY 1, 2, 3;

-- 6. Unique indexes mentioning a phone column, anywhere in public. This is
--    where 0139/0140 almost certainly live. Note that a PARTIAL index — one
--    with a WHERE clause, the shape 0097 uses on sa_id_lookup_hash — is the
--    likely form, so copy the whole indexdef including the predicate.
SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public'
   AND indexdef ILIKE '%phone%'
   AND indexdef ILIKE '%unique%'
 ORDER BY tablename, indexname;

-- 7. Constraints mentioning a phone column, anywhere in public — the same
--    uniqueness expressed as a table constraint rather than a bare index.
SELECT rel.relname AS on_table, con.conname AS name, con.contype::text AS type,
       pg_get_constraintdef(con.oid) AS definition
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = rel.relnamespace
 WHERE n.nspname = 'public'
   AND pg_get_constraintdef(con.oid) ILIKE '%phone%'
 ORDER BY rel.relname, con.conname;

-- 8. Every index on profiles, unfiltered. Belt and braces: if 0139/0140
--    named their columns something sections 6 and 7 do not match on, the
--    index is still in here. Diff this against the CREATE INDEX statements
--    in supabase/migrations — whatever is in this list and not in the repo
--    is drift, whether or not it is about phones.
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = 'public' AND tablename = 'profiles'
 ORDER BY indexname;
