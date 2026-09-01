// TEST FIXTURE. Not imported by application code.
//
// ─── Why this exists ────────────────────────────────────────────────────
//
// Migration 0125 turns EXECUTE on `public` functions into an allow-list, and
// it is deliberately STRICT: every `GRANT EXECUTE ON FUNCTION …` in it names
// a real signature, so applying it to a schema that is missing one of them
// raises `function … does not exist` rather than skipping the grant with a
// notice.
//
// That strictness is the right call for production — nine of those functions
// are RLS policy predicates, and a silently-skipped grant there breaks every
// read in the application while looking like a clean migration. But it means
// any pglite test that wants to apply 0125 verbatim has to stand up every
// signature it names first.
//
// So the stub DDL lives here, once, and both suites import it:
//
//   • supabase/migrations/0125_lock_function_execute.privileges.test.ts
//     — asserts the resulting privilege matrix.
//   • supabase/migrations/security-audit-2026-09-02-otp-rpc.rpc.test.ts
//     — applies 0125 on top of the real phone-verification migrations to
//       show the A-01 exploit is closed.
//
// Sharing it is the point: two hand-maintained copies would drift, and the
// drift would show up as a test that passes because it granted nothing.
//
// ─── Keeping it honest ──────────────────────────────────────────────────
//
// Bodies are irrelevant — a privilege check reads pg_proc, not the body — so
// every stub returns a constant. SIGNATURES are not irrelevant: PostgreSQL
// resolves `GRANT … ON FUNCTION f(TEXT)` by argument types, so a stub with
// the wrong types leaves 0125 raising on a function that plainly exists.
//
// When a migration adds a function to 0125's allow-list, add its stub here.
// The privileges test will fail loudly if you forget, which is the whole
// arrangement working.

/**
 * The three Supabase roles, plus `auth.uid()` / `auth.role()` backed by a
 * mutable `_ctx` row so a test can say who is calling.
 *
 * `service_role` is created WITHOUT bypassrls here. Not for safety —
 * bypassrls has no bearing on function EXECUTE — but because nothing in the
 * privilege suite reads a row, so granting it would be noise. A suite that
 * DOES read rows should create it WITH bypassrls, as production has it; see
 * 0126_0128_caller_binding.rls.test.ts.
 */
export const SUPABASE_ROLES_DDL = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin;

  create table if not exists _ctx (uid uuid, role text);
  insert into _ctx values (null, 'authenticated');
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;
  grant usage on schema auth   to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
    to anon, authenticated, service_role;
  grant select on _ctx to anon, authenticated, service_role;
`;

/**
 * Every function signature 0125's allow-list names, as a stub.
 *
 * Grouped in the same four categories the migration uses, so a reader can
 * check the two against each other line by line.
 */
export const ALLOWLIST_STUBS_DDL = `
  -- (a) token-scoped, reachable with no session
  create function get_invitation_by_token(p_token text)          returns int language sql as $$ select 1 $$;
  create function stamp_invitation_viewed(p_token text)          returns int language sql as $$ select 1 $$;
  create function get_checkout_session_by_token(p_token text)    returns int language sql as $$ select 1 $$;
  create function stamp_checkout_session_scanned(p_token text)   returns int language sql as $$ select 1 $$;
  create function get_practice_invitation_by_token(p_token text) returns int language sql as $$ select 1 $$;

  -- (b) self-scoped via auth.uid()
  create function set_default_card_flag(p_card_id uuid)          returns int language sql as $$ select 1 $$;
  create function archive_card(p_card_id uuid)                   returns int language sql as $$ select 1 $$;
  create function crm_accounts_billing_summary()                 returns int language sql as $$ select 1 $$;

  -- (c) RLS policy predicates — revoking these breaks every read
  create function is_platform_admin()                            returns boolean language sql as $$ select true $$;
  create function is_practice_member(p_practice_id uuid)          returns boolean language sql as $$ select true $$;
  create function is_practice_admin(p_practice_id uuid)           returns boolean language sql as $$ select true $$;
  create function is_practice_manager(p_practice_id uuid)         returns boolean language sql as $$ select true $$;
  create function is_practice_biller(p_practice_id uuid)          returns boolean language sql as $$ select true $$;
  create function is_brand_admin(p_group_id uuid)                 returns boolean language sql as $$ select true $$;
  create function is_brand_admin_of_practice(p_practice_id uuid)  returns boolean language sql as $$ select true $$;
  create function is_own_active_membership(p_member_id uuid)      returns boolean language sql as $$ select true $$;
  create function practice_can_trade(p_practice_id uuid)          returns boolean language sql as $$ select true $$;

  -- (d) called from an invoker-rights trigger
  create function crm_normalise_address_text(input text)          returns text language sql as $$ select input $$;
`;

/**
 * The service_role-only functions, as stubs — the ones 0125 must leave
 * unreachable. Separate from the allow-list DDL because a suite that only
 * needs 0125 to APPLY does not need these, while the privileges test asserts
 * on all of them.
 *
 * Excludes the four phone-verification functions and anything else a caller
 * may have created from a real migration: pass `skip` to leave those out.
 */
export function serviceRoleOnlyStubsDdl(skip: readonly string[] = []): string {
  const stubs: Array<[name: string, ddl: string]> = [
    ['prepare_phone_verification',
      `create function prepare_phone_verification(p_token text, p_phone text, p_code_hash text)
         returns text language sql as $$ select 'ok'::text $$;`],
    ['verify_phone_otp',
      `create function verify_phone_otp(p_token text, p_phone text, p_code_hash text)
         returns text language sql as $$ select 'ok'::text $$;`],
    ['prepare_phone_verification_for_user',
      `create function prepare_phone_verification_for_user(p_user_id uuid, p_phone text, p_code_hash text)
         returns text language sql as $$ select 'ok'::text $$;`],
    ['verify_phone_otp_for_user',
      `create function verify_phone_otp_for_user(p_user_id uuid, p_phone text, p_code_hash text)
         returns text language sql as $$ select 'ok'::text $$;`],
    ['consume_rate_limit',
      `create function consume_rate_limit(p_bucket text, p_subject text, p_max int, p_window_secs int)
         returns boolean language sql as $$ select true $$;`],
    ['redeem_till_registration_code',
      `create function redeem_till_registration_code(p_code_hash text, p_secret_hash text)
         returns int language sql as $$ select 1 $$;`],
    ['accept_practice_invitation',
      `create function accept_practice_invitation(p_token text, p_practice_id uuid)
         returns uuid language sql as $$ select null::uuid $$;`],
    ['change_default_card',
      `create function change_default_card(p_card_id uuid) returns int language sql as $$ select 1 $$;`],
    ['next_invoice_number',
      `create function next_invoice_number() returns text language sql as $$ select 'x'::text $$;`],
    ['expire_stale_checkout_session',
      `create function expire_stale_checkout_session(p_token text, p_force boolean default false)
         returns int language sql as $$ select 1 $$;`],
    ['refresh_card_token',
      `create function refresh_card_token(p_card_id uuid, p_token text, p_brand text, p_last_four text,
                                          p_expiry_month int, p_expiry_year int)
         returns int language sql as $$ select 1 $$;`],
    ['claim_plan_for_settlement',
      `create function claim_plan_for_settlement(p_plan_id uuid, p_patient_id uuid, p_today date,
                                                 p_include_fees boolean default true)
         returns jsonb language sql as $$ select '{}'::jsonb $$;`],
    ['find_auth_user_by_email',
      `create function find_auth_user_by_email(p_email text) returns int language sql as $$ select 1 $$;`],
    ['delete_expired_rate_limit_hits',
      `create function delete_expired_rate_limit_hits(p_older_than_secs int default 86400)
         returns int language sql as $$ select 1 $$;`],
    ['hnpl_write_is_privileged',
      `create function hnpl_write_is_privileged() returns boolean language sql as $$ select false $$;`],
  ];
  return stubs.filter(([n]) => !skip.includes(n)).map(([, d]) => d).join('\n');
}

/**
 * The grants the real migrations left behind, so a revoke is tested against
 * the state it actually has to undo rather than against a blank slate.
 *
 * Skipping the same names as the stubs keeps the two in step.
 */
export function preExistingGrantsDdl(skip: readonly string[] = []): string {
  const grants: Array<[name: string, ddl: string]> = [
    ['prepare_phone_verification',
      `grant execute on function prepare_phone_verification(text,text,text) to anon, authenticated;`],
    ['verify_phone_otp',
      `grant execute on function verify_phone_otp(text,text,text) to anon, authenticated;`],
    ['prepare_phone_verification_for_user',
      `grant execute on function prepare_phone_verification_for_user(uuid,text,text) to authenticated;`],
    ['verify_phone_otp_for_user',
      `grant execute on function verify_phone_otp_for_user(uuid,text,text) to authenticated;`],
    ['consume_rate_limit',
      `grant execute on function consume_rate_limit(text,text,int,int) to anon, authenticated, service_role;`],
    ['redeem_till_registration_code',
      `grant execute on function redeem_till_registration_code(text,text) to anon, authenticated;`],
    ['accept_practice_invitation',
      `grant execute on function accept_practice_invitation(text,uuid) to authenticated;`],
    ['change_default_card',
      `grant execute on function change_default_card(uuid) to authenticated;`],
  ];
  return grants.filter(([n]) => !skip.includes(n)).map(([, d]) => d).join('\n');
}

/**
 * The Supabase platform's own default privileges.
 *
 * This is the SCHEMA-QUALIFIED default-ACL row that shadows a role-wide one,
 * and reproducing it is what makes 0125's "private by default" assertions
 * mean anything — without it the migration would pass a test while doing
 * nothing at all on a real project.
 */
export const PLATFORM_DEFAULT_PRIVILEGES_DDL = `
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;
`;
