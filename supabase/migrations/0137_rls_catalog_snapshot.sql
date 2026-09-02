-- ─── A read-only window onto the RLS catalog, for drift detection ───────
--
-- WHY THIS EXISTS (audit R3-08)
--
-- Three RLS policies once existed only in the live database — made by hand,
-- never written back — and production was TIGHTER than the repo, so a
-- rebuild from migrations would have silently loosened it. 0136 reconciled
-- them. Nothing stops it happening again.
--
-- `lib/security/schemaInvariants.ts` replays the migrations and can say what
-- the repo BELIEVES the policy set is. Comparing that against what the
-- database actually has is the only way to catch a hand-edit, and it needs a
-- read of pg_policies / pg_trigger.
--
-- PostgREST exposes `public` only. pg_catalog is not reachable through it at
-- any privilege level, so a client cannot ask this question without either a
-- direct Postgres connection (a new dependency, and a second credential to
-- manage) or a function that asks on its behalf. This is that function.
--
-- ─── WHY IT IS SAFE TO ADD ──────────────────────────────────────────────
--
-- It is STABLE and reads two catalog views. It cannot write, and it returns
-- no application data of any kind — only object NAMES and the shape of the
-- rules over them: which policies exist, on which table, for which command;
-- which triggers exist, when they fire, on what.
--
-- It is nonetheless service_role ONLY, for two reasons. The policy set is a
-- map of where the defences are, which is exactly the reconnaissance an
-- attacker would like and which no legitimate browser session has any use
-- for. And 0125 made function EXECUTE default-deny precisely so that adding
-- a function is not the same as publishing it — the REVOKE below is belt to
-- that braces, written out rather than assumed.
--
-- Deliberately NOT returning the policy EXPRESSIONS. A qual/with_check dump
-- would make the drift check stricter, and it would also put the full text
-- of every authorization rule behind one function call. Names, tables and
-- commands are enough to catch a policy that was added, removed or renamed
-- by hand, which is the failure mode R3-08 actually was. If expression-level
-- drift matters later, that is a second function with a narrower grant and
-- its own argument, not a widening of this one.

CREATE OR REPLACE FUNCTION rls_catalog_snapshot()
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'policies', COALESCE((
      SELECT jsonb_agg(p ORDER BY p->>'table', p->>'name')
        FROM (
          SELECT jsonb_build_object(
                   'table', tablename,
                   'name',  policyname,
                   'cmd',   cmd
                 ) AS p
            FROM pg_policies
           WHERE schemaname = 'public'
        ) s
    ), '[]'::jsonb),
    'triggers', COALESCE((
      SELECT jsonb_agg(t ORDER BY t->>'table', t->>'name')
        FROM (
          SELECT jsonb_build_object(
                   'table',  c.relname,
                   'name',   tg.tgname,
                   'timing', CASE WHEN tg.tgtype & 2 = 2 THEN 'BEFORE' ELSE 'AFTER' END,
                   'events', (
                     SELECT jsonb_agg(e ORDER BY e)
                       FROM unnest(ARRAY[
                         CASE WHEN tg.tgtype &  4 =  4 THEN 'INSERT'   END,
                         CASE WHEN tg.tgtype &  8 =  8 THEN 'DELETE'   END,
                         CASE WHEN tg.tgtype & 16 = 16 THEN 'UPDATE'   END,
                         CASE WHEN tg.tgtype & 32 = 32 THEN 'TRUNCATE' END
                       ]) AS e
                      WHERE e IS NOT NULL
                   )
                 ) AS t
            FROM pg_trigger tg
            JOIN pg_class     c ON c.oid = tg.tgrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE NOT tg.tgisinternal
             AND n.nspname = 'public'
        ) s
    ), '[]'::jsonb)
  );
$$;

REVOKE ALL ON FUNCTION rls_catalog_snapshot() FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION rls_catalog_snapshot() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION rls_catalog_snapshot() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION rls_catalog_snapshot() TO service_role';
  END IF;
END $$;

COMMENT ON FUNCTION rls_catalog_snapshot() IS
  'Read-only names-and-shapes dump of the public schema''s RLS policies and '
  'triggers, for scripts/check-rls-drift.ts to compare against the migration '
  'replay. Returns no application data and cannot write. service_role only — '
  'the policy set is a map of where the defences are. See audit R3-08.';
