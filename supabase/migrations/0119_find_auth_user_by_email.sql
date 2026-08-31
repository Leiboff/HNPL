-- ─── find_auth_user_by_email — the lookup the app could never perform ───
--
-- WHY THIS EXISTS. lib/auth/findExistingAuthUser.ts has always had two
-- paths: a cheap `profiles` lookup by email, and a fallback that read
-- auth.users directly for the AUTH_ONLY orphan case (an auth user whose
-- profile row is gone). Its own header predicted, correctly, what happens
-- when that fallback fails:
--
--   "the next signUp() returns Supabase's anti-enumeration silent
--    response (data.user = null, error = null), the caller misreads it as
--    'shouldn't happen', and the user can never sign up again with that
--    email."
--
-- That is exactly what has been happening in production. The fallback
-- built a PostgREST client with `db: { schema: 'auth' }`, and PostgREST
-- only serves schemas listed in its `db-schemas` setting — a Supabase
-- project ships with `public, graphql_public`, NOT `auth`. So the query
-- came back PGRST106 ("The schema must be one of the following…"), the
-- error was discarded, and the absence of a row was indistinguishable
-- from the absence of a user. The fallback has been inert since the day
-- it was written.
--
-- A SECURITY DEFINER function in `public` is how you read auth.users from
-- the application side. It needs no schema exposure, it is one indexed
-- lookup, and — unlike exposing the whole auth schema to PostgREST — it
-- grants exactly one question and nothing else.
--
-- ─── ENUMERATION ────────────────────────────────────────────────────────
--
-- "Does an account exist for this email" is precisely the question an
-- enumeration attack asks, so the grant matters more than the function.
-- EXECUTE is REVOKED from PUBLIC (Postgres grants it by default, which is
-- the trap) and from anon and authenticated by name, then granted to
-- service_role alone. It is callable only from server code holding the
-- service key — never from a browser, never from a signed-in session.
--
-- The signup form's own behaviour is unchanged by this: it already tells
-- a visitor "an account with this email already exists", a product
-- decision that predates this migration. This function does not widen
-- what is disclosed; it lets the server find out what it already acts on.

CREATE OR REPLACE FUNCTION public.find_auth_user_by_email(p_email TEXT)
RETURNS TABLE (id UUID, email_confirmed_at TIMESTAMPTZ)
LANGUAGE sql
STABLE
SECURITY DEFINER
-- Pinned so the body cannot be redirected by a caller's search_path.
-- auth.users is fully qualified below regardless.
SET search_path = public
AS $$
  -- Case-insensitive and trimmed, because auth.users.email preserves the
  -- casing it was given and a pasted address often carries whitespace.
  -- The eq-on-lower-cased-value mismatch is its own bug in the profiles
  -- path; this side never had a chance to disagree.
  SELECT u.id, u.email_confirmed_at
  FROM auth.users u
  WHERE lower(u.email) = lower(btrim(p_email))
  LIMIT 1;
$$;

REVOKE ALL     ON FUNCTION public.find_auth_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL     ON FUNCTION public.find_auth_user_by_email(TEXT) FROM anon;
REVOKE ALL     ON FUNCTION public.find_auth_user_by_email(TEXT) FROM authenticated;
GRANT  EXECUTE ON FUNCTION public.find_auth_user_by_email(TEXT) TO   service_role;

COMMENT ON FUNCTION public.find_auth_user_by_email(TEXT) IS
  'Service-role-only lookup of auth.users by email, for signup''s '
  'existing-account and AUTH_ONLY-orphan recovery. Replaces a PostgREST '
  'query against the auth schema that could never work, because Supabase '
  'does not expose that schema. EXECUTE is revoked from PUBLIC/anon/'
  'authenticated — this answers an enumeration question and must stay '
  'server-side. See migration 0119 header.';
