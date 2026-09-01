// @vitest-environment node
//
// ─── The privilege matrix 0125 installs ────────────────────────────────────
//
// This is the safety net for the riskiest migration in the repo. 0125
// revokes EXECUTE on every function in `public` and grants back an
// allow-list; get the allow-list wrong and the failure is not subtle — nine
// of those functions appear inside RLS policy expressions, and policy
// expressions run with the privileges of the role running the query, so a
// missing grant turns every read in the application into
// `permission denied for function`.
//
// ─── Why this runs against stubs rather than the real migration chain ─────
//
// Applying 120 migrations in pglite is not possible — they reach for the
// `auth` schema, Supabase's role set, and extensions pglite does not carry.
// What CAN be tested faithfully is the thing that can actually be wrong:
// the revoke-then-allow-list logic, and whether the allow-list names every
// function some caller needs.
//
// So the stubs below declare the real signatures, and 0125 is applied
// VERBATIM on top. If someone adds a function to the migration's allow-list
// without adding it here the DO block still resolves (the stub is missing →
// the GRANT raises), and if someone removes one from the migration this
// file's expectation fails. The two lists are kept honest against each
// other, which is the property that matters.
//
// ─── The rule this file encodes ──────────────────────────────────────────
//
// Adding a function to the allow-list is a decision, and a decision needs a
// reader. If you widen a grant, widen it here too, and the diff will show
// somebody that the surface grew.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  SUPABASE_ROLES_DDL,
  ALLOWLIST_STUBS_DDL,
  serviceRoleOnlyStubsDdl,
  preExistingGrantsDdl,
  PLATFORM_DEFAULT_PRIVILEGES_DDL,
} from '@/lib/testing/functionAllowlistStubs';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0125_lock_function_execute.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * The allow-list, restated as data.
 *
 * Column 1 is the signature exactly as `has_function_privilege` wants it.
 * Column 2 is who SHOULD hold EXECUTE after 0125. `service_role` is implied
 * on every row and asserted separately.
 */
const EXPECTED: Array<[signature: string, grantees: Array<'anon' | 'authenticated'>]> = [
  // (a) token-scoped — reachable with no session
  ['get_invitation_by_token(text)',            ['anon', 'authenticated']],
  ['stamp_invitation_viewed(text)',            ['anon', 'authenticated']],
  ['get_checkout_session_by_token(text)',      ['anon', 'authenticated']],
  ['stamp_checkout_session_scanned(text)',     ['anon', 'authenticated']],
  ['get_practice_invitation_by_token(text)',   ['anon', 'authenticated']],

  // (b) self-scoped — derive the patient from auth.uid() internally
  ['set_default_card_flag(uuid)',              ['authenticated']],
  ['archive_card(uuid)',                       ['authenticated']],
  ['crm_accounts_billing_summary()',           ['authenticated']],

  // (c) RLS policy predicates — revoking these breaks every read
  ['is_platform_admin()',                      ['anon', 'authenticated']],
  ['is_practice_member(uuid)',                 ['anon', 'authenticated']],
  ['is_practice_admin(uuid)',                  ['anon', 'authenticated']],
  ['is_practice_manager(uuid)',                ['anon', 'authenticated']],
  ['is_practice_biller(uuid)',                 ['anon', 'authenticated']],
  ['is_brand_admin(uuid)',                     ['anon', 'authenticated']],
  ['is_brand_admin_of_practice(uuid)',         ['anon', 'authenticated']],
  ['is_own_active_membership(uuid)',           ['anon', 'authenticated']],
  ['practice_can_trade(uuid)',                 ['anon', 'authenticated']],

  // (d) called from an invoker-rights trigger
  ['crm_normalise_address_text(text)',         ['authenticated']],
];

/**
 * Functions that must be reachable by NOBODY but service_role. The first
 * four are audit finding A-01; consume_rate_limit is A-11;
 * redeem_till_registration_code and accept_practice_invitation are grants
 * that were never needed; change_default_card is dead code.
 */
const SERVICE_ROLE_ONLY: string[] = [
  'prepare_phone_verification(text,text,text)',
  'verify_phone_otp(text,text,text)',
  'prepare_phone_verification_for_user(uuid,text,text)',
  'verify_phone_otp_for_user(uuid,text,text)',
  'consume_rate_limit(text,text,integer,integer)',
  'redeem_till_registration_code(text,text)',
  'accept_practice_invitation(text,uuid)',
  'change_default_card(uuid)',
  'next_invoice_number()',
  'expire_stale_checkout_session(text,boolean)',
  'refresh_card_token(uuid,text,text,text,integer,integer)',
  'claim_plan_for_settlement(uuid,uuid,date,boolean)',
  'find_auth_user_by_email(text)',
  'delete_expired_rate_limit_hits(integer)',
  'hnpl_write_is_privileged()',
];

/**
 * The schema 0125 is applied to: the Supabase roles, every function its
 * allow-list names, the service_role-only set, the explicit grants the real
 * migrations left behind, and the platform's own default privileges.
 *
 * All of it comes from lib/testing/functionAllowlistStubs.ts so this suite
 * and the A-01 closure suite cannot drift apart — see that file's header.
 */
const STUBS = [
  SUPABASE_ROLES_DDL,
  ALLOWLIST_STUBS_DDL,
  serviceRoleOnlyStubsDdl(),
  preExistingGrantsDdl(),
  PLATFORM_DEFAULT_PRIVILEGES_DDL,
].join('\n');

let db: PGlite;

async function can(role: string, sig: string): Promise<boolean> {
  const res = await db.query<{ ok: boolean }>(
    `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
    [role, sig],
  );
  return res.rows[0].ok;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUBS);
  // Verbatim. If the migration does not apply cleanly to a schema that has
  // every function it names, that is itself the failure this file reports.
  await db.exec(MIG);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('0125 — before/after sanity', () => {
  it('the pre-existing explicit grants really were there to strip', async () => {
    // Guards against a false pass: if the fixture never granted anything, a
    // broken revoke would look identical to a working one.
    const grants = preExistingGrantsDdl();
    expect(grants).toContain('prepare_phone_verification(text,text,text) to anon, authenticated');
    expect(grants).toContain('consume_rate_limit(text,text,int,int) to anon, authenticated');
  });

  it('and the platform default-privileges row was reproduced', async () => {
    // Without this the "private by default" assertions would be vacuous.
    expect(PLATFORM_DEFAULT_PRIVILEGES_DDL).toContain('alter default privileges in schema public');
  });
});

describe('0125 — service_role keeps everything', () => {
  // FIRST, because if this is wrong the application is down, not tightened.
  const everything = [...EXPECTED.map(([s]) => s), ...SERVICE_ROLE_ONLY];
  it.each(everything)('service_role may execute %s', async (sig) => {
    expect(await can('service_role', sig)).toBe(true);
  });
});

describe('0125 — the allow-list is exactly what it says', () => {
  it.each(EXPECTED)('%s is reachable by exactly [%s]', async (sig, grantees) => {
    for (const role of ['anon', 'authenticated'] as const) {
      expect(await can(role, sig)).toBe(grantees.includes(role));
    }
  });
});

describe('0125 — everything else is server-side only', () => {
  it.each(SERVICE_ROLE_ONLY)('%s is unreachable by anon and authenticated', async (sig) => {
    expect(await can('anon', sig)).toBe(false);
    expect(await can('authenticated', sig)).toBe(false);
  });

  it('closes A-01: neither phone-OTP pair is callable from a browser', async () => {
    for (const sig of [
      'prepare_phone_verification(text,text,text)',
      'verify_phone_otp(text,text,text)',
      'prepare_phone_verification_for_user(uuid,text,text)',
      'verify_phone_otp_for_user(uuid,text,text)',
    ]) {
      expect(await can('anon', sig)).toBe(false);
      expect(await can('authenticated', sig)).toBe(false);
    }
  });

  it('completes 0056: next_invoice_number is finally unreachable', async () => {
    expect(await can('authenticated', 'next_invoice_number()')).toBe(false);
    expect(await can('anon', 'next_invoice_number()')).toBe(false);
  });

  it('closes A-11: consume_rate_limit cannot be spent by its own victims', async () => {
    expect(await can('anon', 'consume_rate_limit(text,text,integer,integer)')).toBe(false);
    expect(await can('authenticated', 'consume_rate_limit(text,text,integer,integer)')).toBe(false);
  });
});

describe('0125 — a function added later is private by default', () => {
  // This is the half of the fix that means nobody has to remember, and the
  // half with a real PostgreSQL trap in it: the schema-qualified form of the
  // PUBLIC revoke records nothing at all. See the migration header.

  it('no SCHEMA-QUALIFIED default-ACL row survives to shadow the role-wide one', async () => {
    const rows = await db.query<{ ns: string; acl: string }>(`
      select defaclnamespace::regnamespace::text as ns, defaclacl::text as acl
        from pg_default_acl
       where defaclobjtype = 'f' and defaclnamespace <> 0
    `);
    expect(rows.rows).toEqual([]);
  });

  it('the role-wide default grants service_role and nobody else', async () => {
    const rows = await db.query<{ acl: string }>(`
      select defaclacl::text as acl from pg_default_acl
       where defaclobjtype = 'f' and defaclnamespace = 0
    `);
    expect(rows.rows.length).toBeGreaterThan(0);
    for (const r of rows.rows) {
      expect(r.acl).toContain('service_role=X');
      // `=X/` with an empty grantee IS the PUBLIC entry. Its presence here
      // is the exact defect this migration exists to close.
      expect(r.acl).not.toMatch(/(^|[{,])=X\//);
      expect(r.acl).not.toContain('anon=X');
      expect(r.acl).not.toContain('authenticated=X');
    }
  });

  it('a new function is not executable by anon or authenticated', async () => {
    await db.exec(`
      create function added_after_the_lockdown() returns int
        language sql as $$ select 1 $$;
    `);
    expect(await can('anon',          'added_after_the_lockdown()')).toBe(false);
    expect(await can('authenticated', 'added_after_the_lockdown()')).toBe(false);
  });

  it('…but IS executable by service_role, so a new server-side RPC needs no migration edit', async () => {
    expect(await can('service_role', 'added_after_the_lockdown()')).toBe(true);
  });

  it('and its stored ACL names service_role without a PUBLIC entry', async () => {
    const acl = await db.query<{ a: string | null }>(
      `select proacl::text as a from pg_proc where proname = 'added_after_the_lockdown'`,
    );
    // NULL would mean "hardwired default", which includes PUBLIC — the
    // silent failure mode the schema-qualified revoke produces.
    expect(acl.rows[0].a).not.toBeNull();
    expect(acl.rows[0].a).toContain('service_role=X');
    expect(acl.rows[0].a).not.toMatch(/(^|[{,])=X\//);
  });
});
