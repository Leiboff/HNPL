-- ─── profiles.id → auth.users(id): add ON DELETE CASCADE ───────────────────
--
-- WHY THIS IS THE REAL FIX (and not just a signup-rollback nicety):
--
--   Until this migration, profiles.id REFERENCES auth.users(id) carried
--   the default Postgres ON DELETE behaviour (NO ACTION). Any code path
--   that tried to delete an auth user — Supabase's
--   auth.admin.deleteUser, GoTrue's REST endpoint, or a direct
--   DELETE FROM auth.users — would error with FK violation as long as
--   the profile row remained.
--
--   The blast radius isn't just signup rollback. It hits:
--     • Practice signup rollback (the symptom we noticed — orphan pile-up)
--     • POPIA right-to-erasure: a request to delete a user's account
--       cannot be satisfied without manual cross-table cleanup
--     • Admin removal of inactive users
--     • Any future account-closure flow
--
--   With ON DELETE CASCADE, deleting auth.users(id) atomically removes
--   the matching profiles row. The Supabase admin tooling and any
--   POPIA-compliant deletion job then "just work" without bespoke
--   delete-the-profile-first dances.
--
-- BELT AND BRACES:
--
--   The app-side rollback in app/signup/practice/actions.ts already
--   deletes the profile row BEFORE calling auth.admin.deleteUser. That
--   ordering becomes redundant once this migration applies, but we
--   keep it. Belt and braces:
--     (a) If a future migration ever drops the cascade (or someone
--         restores the table from a pre-CASCADE backup), the app code
--         still rolls back cleanly.
--     (b) The app-level explicit deletes also let us log per-step
--         errors during rollback, which a single cascading DELETE
--         wouldn't surface as separately.
--
-- IDEMPOTENCY:
--
--   The constraint name in the live DB is whatever Postgres auto-
--   generated when the inline REFERENCES clause was first declared
--   (in 0001 it would normally be 'profiles_id_fkey', but if anything
--   has been renamed since, we don't want to hard-code). The DO block
--   below looks the constraint up by relation + referenced table so
--   the migration works regardless of the actual constraint name.
--
-- COMPATIBILITY:
--
--   No existing rows are affected. This is purely a constraint swap.
--   The Postgres planner re-evaluates referential checks on subsequent
--   DML; existing data already satisfies the FK so no scan is needed
--   beyond the metadata change.

DO $$
DECLARE
  v_fk_name text;
BEGIN
  -- Find the FK on public.profiles that references auth.users.
  SELECT conname INTO v_fk_name
  FROM pg_constraint
  WHERE conrelid = 'public.profiles'::regclass
    AND contype  = 'f'
    AND confrelid = 'auth.users'::regclass
  LIMIT 1;

  IF v_fk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.profiles DROP CONSTRAINT %I', v_fk_name);
    RAISE NOTICE 'Dropped FK constraint %', v_fk_name;
  ELSE
    RAISE NOTICE 'No existing public.profiles → auth.users FK found; will create one.';
  END IF;
END $$;

ALTER TABLE public.profiles
  ADD CONSTRAINT profiles_id_auth_users_fkey
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
