-- ─── Function EXECUTE becomes an allow-list ─────────────────────────────
--
-- THE DEFECT (audit 2026-09-02, A-02)
--
-- PostgreSQL grants EXECUTE on a new function to PUBLIC, and every role
-- inherits PUBLIC. So `GRANT EXECUTE ... TO service_role` grants nothing
-- that was not already granted — it documents intent without enforcing it —
-- and `REVOKE EXECUTE ... FROM authenticated` removes only the explicit
-- grant while the role keeps EXECUTE through PUBLIC.
--
-- Migration 0056 exists specifically to stop logged-in users burning invoice
-- numbers. It does not:
--
--     0056: REVOKE EXECUTE ON FUNCTION next_invoice_number() FROM authenticated;
--     →     has_function_privilege('authenticated', 'next_invoice_number()', 'EXECUTE') = true
--
-- Three functions in this schema got it right (`claim_plan_for_settlement`
-- in 0058/0080, `find_auth_user_by_email` in 0119,
-- `delete_expired_rate_limit_hits` in 0124) because they say
-- `REVOKE ... FROM PUBLIC` in as many words. The other ~30 did not.
--
-- Today that leaves invoice-number burning, arbitrary checkout-session
-- expiry, a card-token rewrite primitive, and — the expensive one — the
-- phone-OTP pair, whose whole bypass (A-01) is reachable because the
-- browser can call the RPC at all. Structurally it leaves a standing,
-- invisible escalation channel on every function added from here on.
--
-- ─── THE FIX: revoke everything, then name what the browser may call ────
--
-- An allow-list, not a deny-list, for the same reason 0122 inverted
-- `profiles`: a deny-list is only correct until the next thing is added.
--
--   1. ALTER DEFAULT PRIVILEGES so a FUTURE function is private on
--      creation. This is the half that means nobody has to remember.
--   2. REVOKE EXECUTE ON ALL FUNCTIONS from PUBLIC, anon and authenticated.
--      All three, not just PUBLIC: several migrations wrote explicit grants
--      to anon/authenticated, and revoking PUBLIC alone leaves those.
--   3. GRANT service_role everything first, because it is what every
--      Server Action, webhook and cron actually runs as.
--   4. GRANT back, by name and with a reason, the functions a browser
--      genuinely reaches.
--
-- ─── HOW THE ALLOW-LIST WAS DERIVED, AND WHY IT IS NOT A GUESS ──────────
--
-- Every `.rpc(` call site in app/ and lib/ was read and classified by which
-- client it holds. A call through `createServiceClient(...)` needs no grant
-- here; a call through `@/lib/supabase/server` or the browser client does.
-- Four categories came out of that, and the fourth is the one that would
-- have broken production if it had been missed:
--
--   (a) TOKEN-SCOPED, reachable with no session. The checkout page resolves
--       a path token before anyone is signed in, so these must stay on
--       `anon` as well as `authenticated`.
--
--   (b) SELF-SCOPED, authenticated. Each derives the patient from
--       auth.uid() internally and scopes every statement on it, so the
--       card id in the parameter cannot address another account's row.
--
--   (c) RLS POLICY PREDICATES. Nine functions appear inside CREATE POLICY
--       expressions. Policy expressions run with the privileges of the role
--       running the query, so revoking these would turn every read in the
--       app into `permission denied for function`. They are granted back
--       verbatim — this migration changes no policy and no predicate, and
--       these grants reproduce exactly today's behaviour.
--
--       `hnpl_write_is_privileged()` is deliberately NOT in that set. It is
--       called only from the 0121/0122/0054 column-lock triggers, which are
--       SECURITY DEFINER, so the privilege check falls on the definer.
--
--   (d) A HELPER CALLED FROM AN INVOKER-RIGHTS TRIGGER.
--       `crm_leads_set_address_match_key` is a plain (non-definer) trigger
--       function and calls `crm_normalise_address_text`, so the privilege
--       check lands on whoever is writing the row — a `sales` user. It is a
--       pure string normaliser with no data access, and granting it costs
--       nothing. Missing it would have broken every CRM lead write.
--
-- Trigger functions themselves need no grant: PostgreSQL checks EXECUTE on
-- a trigger function at CREATE TRIGGER time, not at fire time. Calling one
-- directly raises "trigger functions can only be called as triggers"
-- regardless.
--
-- The two directory VIEWS (0063, 0064) are unaffected — they run
-- `security_invoker = false`, so their body executes as the owner, and
-- their own grants already name `authenticated` only.
--
-- ─── WHAT THIS TIGHTENS BEYOND THE AUDIT FINDING ───────────────────────
--
--   • prepare_phone_verification / verify_phone_otp and both _for_user
--     variants lose anon and authenticated entirely. Every one of their
--     four call sites already holds the service-role client, so this is
--     behaviour-neutral — and it is what closes A-01.
--   • consume_rate_limit loses anon and authenticated (A-11). Its only
--     caller is lib/security/rateLimit.ts, on a service client.
--   • redeem_till_registration_code loses anon, which it never needed:
--     app/practice/pos/actions.ts calls it through svc().
--   • accept_practice_invitation loses authenticated (A-07 in part —
--     the ownership check still lands in 0127, because a revoke here does
--     not make an unauthenticated-by-design function correct).
--   • change_default_card is granted to nobody. It is dead code — the
--     surviving caller is callSetDefaultCardFlagRpc → set_default_card_flag
--     — and a dead SECURITY DEFINER function with no auth check is exactly
--     the kind of thing that gets rediscovered by an attacker.
--   • expire_stale_checkout_session, refresh_card_token,
--     next_invoice_number and __set_profile_fk_action become
--     service_role-only in fact rather than in intent.
--
-- ─── IF THIS BREAKS SOMETHING ──────────────────────────────────────────
--
-- The symptom is `permission denied for function <name>`, and the fix is a
-- one-line GRANT — not a re-run of the revoke with a wider grantee. Add the
-- name to the allow-list below AND to the assertion list in
-- `0125_lock_function_execute.privileges.test.ts`, so the next person can
-- see that it was a decision.

-- ── 1. Future functions are private on creation ────────────────────────
--
-- THREE grantees have to come out of the defaults, not one. PUBLIC is the
-- PostgreSQL language default; anon and authenticated are there because the
-- Supabase platform sets its own `ALTER DEFAULT PRIVILEGES IN SCHEMA public
-- GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role`.
-- Close the language default alone and the platform's survives, so the next
-- function added still ships browser-callable.
--
-- service_role is granted in the defaults on purpose: the server side is
-- always allowed, and the browser side always needs a migration to say so.
-- That asymmetry is the whole policy in one line, and it means a new
-- server-side RPC needs no edit to this file.
--
-- ─── THE TRAP, measured rather than assumed ────────────────────────────
--
-- `ALTER DEFAULT PRIVILEGES *IN SCHEMA public* REVOKE EXECUTE ON FUNCTIONS
-- FROM PUBLIC` is SILENTLY A NO-OP. It is also the form every recipe on the
-- internet gives you. Verified against real PostgreSQL:
--
--     ALTER DEFAULT PRIVILEGES IN SCHEMA public
--       REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--     CREATE FUNCTION probe() ...;
--     -- pg_default_acl: no row at all
--     -- probe's proacl: NULL  → the hardwired default, PUBLIC included
--     -- has_function_privilege('anon', 'probe()', 'EXECUTE') → TRUE
--
-- The reason is that PUBLIC's EXECUTE on functions is not a stored default
-- ACL entry; it is `acldefault()`, which is not schema-scoped. A
-- schema-qualified revoke has nothing to subtract and records nothing. The
-- UNQUALIFIED (role-wide) form does work, and yields
-- `proacl = {postgres=X/postgres}` — PUBLIC gone.
--
-- Which forces the ordering below, and it is not interchangeable:
--
--   (i)  Clear any SCHEMA-QUALIFIED row first. A schema-specific default
--        ACL SHADOWS the role-wide one, and because it is rebuilt from
--        `acldefault()` it carries PUBLIC back in. Revoking everything it
--        grants makes it equal the hardwired default, which deletes the row
--        and lets the role-wide entry apply.
--   (ii) Then set the role-wide entry.
--
-- Doing (ii) before (i), or adding a schema-qualified GRANT afterwards,
-- silently reintroduces PUBLIC. The last two assertions in
-- 0125_lock_function_execute.privileges.test.ts are what catch that.
--
-- Role-wide means every schema this role creates functions in, not just
-- `public`. Deliberate: private-by-default is the posture we want
-- everywhere, and every function this project defines lives in `public`.

DO $$
DECLARE
  restricted TEXT := 'PUBLIC';
  present    TEXT := '';
BEGIN
  -- Only name roles that exist, so the migration also applies to a bare
  -- Postgres (pglite in tests, a self-hosted rebuild mid-provision).
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    restricted := restricted || ', anon';
    present    := present    || ', anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    restricted := restricted || ', authenticated';
    present    := present    || ', authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    present := present || ', service_role';
  END IF;

  -- (i) Drop the schema-qualified row, if the platform installed one.
  IF present <> '' THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA public '
         || 'REVOKE EXECUTE ON FUNCTIONS FROM ' || ltrim(present, ', ');
  END IF;

  -- (ii) Role-wide. This is the statement that actually removes PUBLIC.
  EXECUTE 'ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM ' || restricted;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO service_role';
  END IF;

  -- Same pair FOR ROLE postgres, for the case where migrations run as a
  -- different superuser but functions end up owned by postgres. Default
  -- privileges are keyed on the CREATING role, so both need saying.
  BEGIN
    IF present <> '' THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public '
           || 'REVOKE EXECUTE ON FUNCTIONS FROM ' || ltrim(present, ', ');
    END IF;
    EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres '
         || 'REVOKE EXECUTE ON FUNCTIONS FROM ' || restricted;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
      EXECUTE 'ALTER DEFAULT PRIVILEGES FOR ROLE postgres '
           || 'GRANT EXECUTE ON FUNCTIONS TO service_role';
    END IF;
  EXCEPTION WHEN insufficient_privilege OR undefined_object THEN
    -- Not a member of postgres, or no such role here. The unqualified
    -- statements above already cover the role actually creating objects.
    RAISE NOTICE 'skipped ALTER DEFAULT PRIVILEGES FOR ROLE postgres (%)', SQLERRM;
  END;
END $$;

-- ── 2. Revoke what already exists ──────────────────────────────────────
--
-- From all three grantees, not just PUBLIC: 0052, 0053, 0068, 0088 and 0124
-- wrote explicit grants to anon/authenticated, and revoking PUBLIC alone
-- leaves every one of those in place. That is the mistake 0056 made.

REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  r TEXT;
BEGIN
  FOR r IN SELECT unnest(ARRAY['anon', 'authenticated']) LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- ── 3. service_role runs the application ───────────────────────────────
--
-- FIRST, and unconditionally. Every Server Action, both webhooks and all
-- three crons hold this role; without this grant the revoke above takes the
-- whole application down rather than tightening it.

-- Existing functions only. The DEFAULT for future ones was set role-wide in
-- step 1 and is deliberately NOT repeated with an `IN SCHEMA public`
-- qualifier here: that would create a schema-specific default-ACL row, and a
-- schema-specific row shadows the role-wide one. Keeping exactly one row,
-- role-wide, is what makes the invariant assertable — see the
-- "no SCHEMA-QUALIFIED default-ACL row survives" assertion in the test.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role';
  END IF;
END $$;

-- ── 4. The allow-list ──────────────────────────────────────────────────
--
-- Wrapped so this migration still applies in an environment that has no
-- anon/authenticated roles (pglite without the Supabase role set). The
-- grants are written out one per line rather than in a loop, because the
-- point of an allow-list is that a reader can see every entry.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE NOTICE 'no authenticated role in this environment — allow-list skipped';
    RETURN;
  END IF;

  -- (a) Token-scoped. Reached before there is a session, from
  --     app/checkout/[token]/page.tsx and app/signup/practice/actions.ts.
  GRANT EXECUTE ON FUNCTION get_invitation_by_token(TEXT)             TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION stamp_invitation_viewed(TEXT)             TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION get_checkout_session_by_token(TEXT)       TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION stamp_checkout_session_scanned(TEXT)      TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION get_practice_invitation_by_token(TEXT)    TO anon, authenticated;

  -- (b) Self-scoped. Each reads auth.uid() itself and scopes every
  --     statement on it (0083), so the card id cannot address another
  --     account. Called from app/patient/payment-methods/actions.ts and
  --     app/crm/accounts/page.tsx on the caller's own session client.
  GRANT EXECUTE ON FUNCTION set_default_card_flag(uuid)               TO authenticated;
  GRANT EXECUTE ON FUNCTION archive_card(uuid)                        TO authenticated;
  GRANT EXECUTE ON FUNCTION crm_accounts_billing_summary()            TO authenticated;

  -- (c) RLS policy predicates. Policy expressions run as the querying
  --     role, so these must stay executable or every read fails. Nothing
  --     about them changes here.
  GRANT EXECUTE ON FUNCTION is_platform_admin()                       TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_practice_member(UUID)                  TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_practice_admin(UUID)                   TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_practice_manager(UUID)                 TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_practice_biller(UUID)                  TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_brand_admin(UUID)                      TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_brand_admin_of_practice(UUID)          TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION is_own_active_membership(UUID)            TO anon, authenticated;
  GRANT EXECUTE ON FUNCTION practice_can_trade(UUID)                  TO anon, authenticated;

  -- (d) Called from an INVOKER-RIGHTS trigger
  --     (crm_leads_set_address_match_key), so the check lands on the
  --     writing role. Pure string normalisation, no data access.
  GRANT EXECUTE ON FUNCTION crm_normalise_address_text(TEXT)          TO authenticated;
END $$;

-- ── 5. Re-assert the three that were already correct ───────────────────
--
-- Step 2 revoked from PUBLIC across the board, which includes these, so
-- nothing here is load-bearing. It is written down so a reader looking for
-- "what happened to the functions 0058/0119/0124 locked" finds an answer
-- instead of an absence.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION claim_plan_for_settlement(UUID, UUID, DATE, BOOLEAN) TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.find_auth_user_by_email(TEXT)                 TO service_role';
    EXECUTE 'GRANT EXECUTE ON FUNCTION delete_expired_rate_limit_hits(INT)                  TO service_role';
  END IF;
END $$;

COMMENT ON SCHEMA public IS
  'EXECUTE on functions in this schema is an ALLOW-LIST as of migration '
  '0125. Default privileges revoke EXECUTE from PUBLIC, so a new function '
  'is private on creation; a function a browser must call needs an explicit '
  'GRANT in a migration, added to the allow-list in 0125 and to the '
  'assertion list in 0125_lock_function_execute.privileges.test.ts. See '
  'audit finding A-02 (docs/SECURITY-AUDIT-2026-09-02.md).';
