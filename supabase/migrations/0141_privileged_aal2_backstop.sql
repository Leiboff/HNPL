-- ─────────────────────────────────────────────────────────────────────
-- 0141  Privileged MFA / AAL2 — database backstop, audit surface, factor
--        snapshot for the scheduled diff.
--
-- Companion to the application guard in lib/auth/aal.ts. The app guard is
-- the primary control (it has to be — 15 of the 16 privileged writes go
-- through the service-role client, which bypasses RLS entirely, so for
-- those there is nothing a policy could add). This migration adds the DB
-- layer for the ONE privileged operation that does travel on the
-- user-scoped client — payout settlement — plus the audit-log surface and
-- the read-only factor snapshot item F's cron diff needs.
--
-- SCOPE / SAFETY
--   • Touches NOTHING in the auth schema. The two functions here live in
--     public and only READ auth (auth.jwt() for the current request's
--     claims; auth.mfa_factors, read-only, via a SECURITY DEFINER
--     snapshot). No auth DDL, triggers or policies.
--   • ADDS policies only. The two restrictive policies are new; no
--     existing policy is altered or dropped.
--   • The one modification to existing schema is widening a CHECK
--     constraint on admin_audit_log to admit a new entity_type. That is a
--     strict widening — every previously-valid row stays valid.
--   • Restrictive policies are scoped FOR UPDATE and gated on
--     is_platform_admin(), so patient discovery, checkout, till issuance,
--     practice-manager and brand-admin traffic — none of which is a
--     platform admin updating a payout — pass unchanged. service_role
--     bypasses RLS, so the cron settlement/insert paths are unaffected.
--
-- Numbered 0141 to sit after production's 0139/0140 (unique_verified_phone,
-- verified_phone_unique_index), which are not yet mirrored in this repo —
-- see the reconciliation note below. Applied to production on 2026-09-03 via
-- the Supabase MCP; the schema_migrations version row was reconciled from the
-- MCP's timestamp to 0141 so a future `supabase db push` does not re-run it.
-- ─────────────────────────────────────────────────────────────────────


-- ── 1. Audit surface: admit 'auth_factor' as an entity_type ────────────
--
-- MFA factor changes and break-glass sign-ins are recorded in
-- admin_audit_log alongside payout settlement, role changes and banking
-- changes (item F). They are about an auth user, not a practice or a
-- payout, so they need an entity_type of their own. Widening only — the
-- six existing values remain valid.

ALTER TABLE public.admin_audit_log
  DROP CONSTRAINT IF EXISTS admin_audit_log_entity_type_check;

ALTER TABLE public.admin_audit_log
  ADD CONSTRAINT admin_audit_log_entity_type_check
  CHECK (entity_type = ANY (ARRAY[
    'practice'::text,
    'customer'::text,
    'practice_group'::text,
    'payout'::text,
    'payout_batch'::text,
    'payment'::text,
    'auth_factor'::text
  ]));


-- ── 2. The AAL2 freshness predicate, in SQL ────────────────────────────
--
-- Mirrors lib/auth/aal.ts semantics EXACTLY, and fails closed on every
-- irregular input for the same reason the TypeScript does: a forged-future
-- or malformed amr timestamp is a hostile input and must land on the
-- strict branch, never a lenient fallback.
--
--   • claims come from auth.jwt() — the VERIFIED token for this request,
--     not anything the client can hand-set at the DB boundary.
--   • aal must be exactly 'aal2'.
--   • amr must be a JSON ARRAY OF OBJECTS. The RFC-8176 string[] form
--     carries no timestamp and so can never be fresh — it returns false.
--   • among entries whose method is a real second factor (mfa/totp|totp)
--     and whose timestamp is a non-negative integer NOT in the future,
--     take the most recent; require now() - that < max_age.
--   • no matching entry, absent amr, non-numeric or future timestamp,
--     null claims → false.
--
-- STABLE, SECURITY INVOKER: it reads only the request's own claims and no
-- tables, so it needs no elevated rights.

CREATE OR REPLACE FUNCTION public.session_meets_aal2(max_age interval)
RETURNS boolean
LANGUAGE sql
STABLE
-- Pinned search_path: the body calls only pg_catalog builtins, so this is
-- safe and satisfies the function_search_path_mutable linter.
SET search_path = pg_catalog
AS $$
  WITH claims AS (
    SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb AS c
  ),
  fresh AS (
    SELECT max((e ->> 'timestamp')::numeric) AS latest_ts
    FROM claims,
         jsonb_array_elements(
           CASE WHEN jsonb_typeof(c -> 'amr') = 'array'
                THEN c -> 'amr' ELSE '[]'::jsonb END
         ) AS e
    WHERE jsonb_typeof(e) = 'object'
      AND (e ->> 'method') IN ('mfa/totp', 'totp')
      AND (e ->> 'timestamp') ~ '^[0-9]+$'
      AND (e ->> 'timestamp')::numeric <= extract(epoch FROM now())
  )
  SELECT
    coalesce((SELECT c ->> 'aal' FROM claims), '') = 'aal2'
    AND (SELECT latest_ts FROM fresh) IS NOT NULL
    AND (extract(epoch FROM now()) - (SELECT latest_ts FROM fresh))
        < extract(epoch FROM max_age);
$$;

COMMENT ON FUNCTION public.session_meets_aal2(interval) IS
  'True iff the current request''s verified JWT is aal2 with an mfa/totp amr '
  'timestamp within max_age. Fails closed on malformed/future/absent amr. '
  'Mirrors lib/auth/aal.ts. Used by the restrictive payout-settlement policies.';


-- ── 3. Restrictive backstop on payout settlement ───────────────────────
--
-- Payout settlement (app/admin/payouts/actions.ts markBatchPaid /
-- markPayoutPaid) is the one privileged operation that writes on the
-- user-scoped client, so it is the one where RLS is a real second layer
-- rather than theatre. Critical tier ⇒ a 5-minute freshness window, the
-- same the app guard enforces.
--
-- A RESTRICTIVE policy is AND-combined with everything else and applies to
-- every actor for the command it targets — that is the hazard the prompt
-- flags, so it is scoped tightly:
--   • FOR UPDATE only. SELECT is untouched, so the payouts pages still
--     render for admins, brand-admins, practice members and providers.
--   • `NOT is_platform_admin() OR session_meets_aal2(...)`: a non-admin
--     satisfies the left side and is therefore unrestricted by this
--     policy (their own permissive policies still decide, and none of
--     them grant UPDATE on payouts anyway). Only a platform admin is held
--     to the aal2-fresh requirement.
--   • service_role bypasses RLS, so the cron insert/settlement path is
--     unaffected.

CREATE POLICY payouts_update_requires_fresh_aal2
  ON public.payouts
  AS RESTRICTIVE
  FOR UPDATE
  USING      (NOT is_platform_admin() OR public.session_meets_aal2(interval '5 minutes'))
  WITH CHECK (NOT is_platform_admin() OR public.session_meets_aal2(interval '5 minutes'));

CREATE POLICY payout_batches_update_requires_fresh_aal2
  ON public.payout_batches
  AS RESTRICTIVE
  FOR UPDATE
  USING      (NOT is_platform_admin() OR public.session_meets_aal2(interval '5 minutes'))
  WITH CHECK (NOT is_platform_admin() OR public.session_meets_aal2(interval '5 minutes'));


-- ── 4. Read-only factor snapshot for the scheduled diff (item F) ───────
--
-- auth.audit_log_entries is empty on this project and we could not verify
-- it populates on enrolment, so the reliable mechanism for detecting
-- factor changes — including a factor deleted with the service-role admin
-- API, which never touches the app — is a scheduled diff of
-- auth.mfa_factors. supabase-js reaches only exposed (public) schemas, so
-- this SECURITY DEFINER function in public is how the cron reads the auth
-- table without the auth schema being exposed or modified. It is READ
-- ONLY; it creates nothing in auth.
--
-- Locked down: only a platform admin (or service_role, which the cron
-- uses) may call it, so it is not a factor-enumeration oracle for anyone
-- else.

CREATE OR REPLACE FUNCTION public.mfa_factor_snapshot()
RETURNS TABLE (
  factor_id   uuid,
  user_id     uuid,
  factor_type text,
  status      text,
  created_at  timestamptz,
  updated_at  timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = auth, public
AS $$
  SELECT f.id, f.user_id, f.factor_type::text, f.status::text, f.created_at, f.updated_at
  FROM auth.mfa_factors f
  WHERE public.is_platform_admin() OR auth.role() = 'service_role';
$$;

REVOKE ALL ON FUNCTION public.mfa_factor_snapshot() FROM public;
GRANT EXECUTE ON FUNCTION public.mfa_factor_snapshot() TO authenticated, service_role;

COMMENT ON FUNCTION public.mfa_factor_snapshot() IS
  'Read-only snapshot of auth.mfa_factors for the scheduled factor-diff '
  'cron. Platform-admin / service_role only. Does not modify the auth schema.';


-- ── 5. State table the diff compares against ───────────────────────────
--
-- One row per factor the last diff run saw. The cron compares the live
-- snapshot against this, writes an admin_audit_log row for every add,
-- removal or status change, then reconciles this table to the snapshot.
-- No secrets: factor ids and status only, never the TOTP secret (which is
-- not in auth.mfa_factors in a usable form anyway).

CREATE TABLE IF NOT EXISTS public.mfa_factor_state (
  factor_id    uuid        PRIMARY KEY,
  user_id      uuid        NOT NULL,
  factor_type  text        NOT NULL,
  status       text        NOT NULL,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS mfa_factor_state_user_idx
  ON public.mfa_factor_state (user_id);

ALTER TABLE public.mfa_factor_state ENABLE ROW LEVEL SECURITY;

-- Read for platform admins (so the state is inspectable in support). The
-- cron writes via service_role, which bypasses RLS, so no write policy is
-- needed and none is added — the table is not writable from any session.
CREATE POLICY admins_select_mfa_factor_state
  ON public.mfa_factor_state
  FOR SELECT
  USING (is_platform_admin());

COMMENT ON TABLE public.mfa_factor_state IS
  'Last-seen snapshot of auth.mfa_factors, maintained by the mfa-factor-audit '
  'cron so it can diff and alert on out-of-band factor changes (item F).';
