// @vitest-environment node
//
// ─── ADVERSARIAL PROOFS — audit 2026-09-02 ─────────────────────────────────
//
// MIXED FILE, and the mix is the point. Each finding gets two blocks:
//
//   • the PROOF, which applies the migrations as they stood when the audit
//     ran and asserts the exploit SUCCEEDS. Left in place deliberately — it
//     is the evidence, and it is what makes the closure assertion mean
//     something rather than being a tautology about a schema nobody has.
//   • the CLOSURE, which applies the fix on top of that same schema and
//     asserts the exploit is gone.
//
// A-01 and A-02 are closed by 0125 (EXECUTE becomes an allow-list) and
// A-06 by 0126 (caller binding). If a proof block ever starts failing,
// someone changed the historical migrations; if a closure block starts
// failing, someone reopened the hole.
//
// Everything below runs the ACTUAL migration SQL against a real Postgres
// (pglite), as a NON-superuser role shaped like Supabase's `authenticated`
// and `anon`. That matters twice over:
//
//   • pglite's default role is a superuser and would pass identically with
//     every GRANT removed, so the roles are created explicitly.
//   • the whole point of A-02 is what Postgres grants BY DEFAULT, which no
//     hand-written approximation of a migration's end state would show.
//
// Findings proved here:
//
//   A-01  The phone-OTP RPCs take the code HASH as a caller-supplied
//         parameter. Anyone who can call them can therefore write a hash
//         they chose and then "verify" it — no SMS is sent, no knowledge of
//         PHONE_OTP_PEPPER is needed, and the phone gate is bypassed.
//
//   A-01b prepare_phone_verification_for_user / verify_phone_otp_for_user
//         take p_user_id and never compare it to auth.uid(). One
//         authenticated session can therefore act on another account's
//         verification row.
//
//   A-02  Postgres grants EXECUTE on a new function to PUBLIC. A migration
//         that says `GRANT EXECUTE ... TO service_role` (or that REVOKEs
//         only from `authenticated`) leaves the function callable by anon
//         and authenticated. Proved against 0014 + 0056 verbatim, which is
//         where an earlier audit's M2 fix was supposed to close exactly
//         this.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import {
  ALLOWLIST_STUBS_DDL,
  serviceRoleOnlyStubsDdl,
  PLATFORM_DEFAULT_PRIVILEGES_DDL,
} from '@/lib/testing/functionAllowlistStubs';

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')
    .replace(/\r\n/g, '\n');
}

// ── Supabase-shaped roles + the auth helpers the migrations call ──────────
//
// `authenticated` and `anon` get the same broad table-level
// privileges Supabase grants its own roles, so anything that blocks them
// below is RLS or a missing EXECUTE — never an incidental missing GRANT.
const ROLES_AND_AUTH = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin bypassrls;

  create table _ctx (uid uuid, role text);
  insert into _ctx values (null, 'authenticated');
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
    to anon, authenticated, service_role;
  grant select on _ctx to anon, authenticated, service_role;
`;

// Minimal stand-ins for the tables the phone-verification RPCs touch.
// auth.users and profiles are real tables in production; here they only
// need the columns the function bodies read.
const PHONE_FIXTURES = `
  create table auth.users (
    id uuid primary key,
    email text,
    email_confirmed_at timestamptz
  );
  create table profiles (
    id uuid primary key,
    phone text,
    phone_pending text
  );
  create table patient_invitations (
    token text primary key,
    accepted_at timestamptz,
    expires_at  timestamptz not null
  );
  create table checkout_sessions (
    token text primary key,
    stage text not null default 'created',
    expires_at timestamptz not null
  );
`;

const ATTACKER = '11111111-1111-1111-1111-111111111111';
const VICTIM   = '22222222-2222-2222-2222-222222222222';

/**
 * Install the phone-verification schema and RPCs from the real migrations.
 *
 * 0052 creates the table + the two token-keyed RPCs; 0053 adds the two
 * user-keyed ones; 0055/0086/0099 are CREATE OR REPLACE on top. Applying
 * them in order is what the deployed database has.
 */
async function phoneDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(ROLES_AND_AUTH);
  await db.exec(PHONE_FIXTURES);

  for (const file of [
    '0052_phone_verification.sql',
    '0053_phone_verification_user_keying.sql',
    '0055_phone_otp_burn_caps.sql',
    '0086_phone_verification_pos_token.sql',
    '0099_phone_change_reverification.sql',
  ]) {
    // 0052 adds phone_verified_at to `profiles`; the later ones only touch
    // phone_verifications + the functions. Strip nothing — run them whole.
    await db.exec(migration(file));
  }

  // Supabase's own grants, reproduced. Note what is NOT written here: any
  // GRANT EXECUTE for anon / authenticated on the RPCs. The
  // migrations' own GRANT statements are the only source, which is the
  // point of the tests below.
  await db.exec(`
    grant usage on schema public to anon, authenticated, service_role;
    grant select, insert, update, delete on all tables in schema public
      to anon, authenticated, service_role;
  `);

  await db.exec(`
    insert into auth.users (id, email, email_confirmed_at) values
      ('${ATTACKER}', 'attacker@example.com', now()),
      ('${VICTIM}',   'victim@example.com',   now());
    insert into profiles (id, phone, phone_pending) values
      ('${ATTACKER}', '+27820000001', null),
      ('${VICTIM}',   '+27820000002', null);
    insert into patient_invitations (token, accepted_at, expires_at)
      values ('live-invitation-token', null, now() + interval '7 days');
  `);

  return db;
}

/** Run SQL as a given role, the way PostgREST would. */
async function asRole<T>(db: PGlite, role: string, sql: string): Promise<T> {
  await db.exec(`set role ${role};`);
  try {
    const res = await db.query(sql);
    return res.rows as unknown as T;
  } finally {
    await db.exec('reset role;');
  }
}

describe('A-01 — the phone-OTP RPCs accept a caller-chosen code hash', () => {
  let db: PGlite;
  beforeEach(async () => { db = await phoneDb(); });
  afterEach(async () => { await db.close(); });

  it('anon can mint a verified phone_verifications row with no SMS and no pepper', async () => {
    // The hash is a PARAMETER. An attacker does not need to know the code
    // that hashes to it, or PHONE_OTP_PEPPER, or receive an SMS — they pick
    // a value, store it, and then present the same value back.
    const CHOSEN = 'a-hash-the-attacker-invented';

    const prep = await asRole<Array<{ prepare_phone_verification: string }>>(
      db, 'anon',
      `select prepare_phone_verification(
         'live-invitation-token', '+27829999999', '${CHOSEN}'
       );`,
    );
    expect(prep[0].prepare_phone_verification).toBe('ok');

    const verify = await asRole<Array<{ verify_phone_otp: string }>>(
      db, 'anon',
      `select verify_phone_otp(
         'live-invitation-token', '+27829999999', '${CHOSEN}'
       );`,
    );

    // EXPLOIT: the gate says the number is verified.
    expect(verify[0].verify_phone_otp).toBe('ok');

    const row = await asRole<Array<{ verified_at: string | null }>>(
      db, 'service_role',
      `select verified_at from phone_verifications
        where invitation_token = 'live-invitation-token';`,
    );
    expect(row[0].verified_at).not.toBeNull();

    // And this is what initiateCheckout reads (app/checkout/[token]/
    // actions.ts queries phone_verifications by (invitation_token,
    // phone_e164) with verified_at not null inside a freshness window).
  });

  it('the same bypass works for a POS counter-session token (0086)', async () => {
    await db.exec(`
      insert into checkout_sessions (token, stage, expires_at)
        values ('till-qr-token', 'created', now() + interval '1 hour');
    `);
    const CHOSEN = 'x';
    const prep = await asRole<Array<{ prepare_phone_verification: string }>>(
      db, 'anon',
      `select prepare_phone_verification('till-qr-token', '+27828888888', '${CHOSEN}');`,
    );
    expect(prep[0].prepare_phone_verification).toBe('ok');

    const verify = await asRole<Array<{ verify_phone_otp: string }>>(
      db, 'anon',
      `select verify_phone_otp('till-qr-token', '+27828888888', '${CHOSEN}');`,
    );
    expect(verify[0].verify_phone_otp).toBe('ok');
  });

  it('the 5-attempt cap is resettable by re-calling prepare (verified_at → NULL, attempts → 0)', async () => {
    // Not the main exploit — but worth pinning, because it means the
    // attempt cap bounds a brute force only within one 30-second window.
    await asRole(db, 'anon',
      `select prepare_phone_verification('live-invitation-token', '+27827777777', 'h1');`);
    for (let i = 0; i < 5; i++) {
      await asRole(db, 'anon',
        `select verify_phone_otp('live-invitation-token', '+27827777777', 'wrong');`);
    }
    const locked = await asRole<Array<{ verify_phone_otp: string }>>(
      db, 'anon',
      `select verify_phone_otp('live-invitation-token', '+27827777777', 'wrong');`);
    expect(locked[0].verify_phone_otp).toBe('too_many_attempts');

    // Move last_sent_at past the 30s cooldown, then re-prepare.
    await db.exec(`update phone_verifications
                      set last_sent_at = now() - interval '31 seconds'
                    where phone_e164 = '+27827777777';`);
    await asRole(db, 'anon',
      `select prepare_phone_verification('live-invitation-token', '+27827777777', 'h2');`);

    const fresh = await asRole<Array<{ attempts: number }>>(
      db, 'service_role',
      `select attempts from phone_verifications where phone_e164 = '+27827777777';`);
    expect(fresh[0].attempts).toBe(0);
  });
});

describe('A-01b — the *_for_user RPCs never compare p_user_id to auth.uid()', () => {
  let db: PGlite;
  beforeEach(async () => { db = await phoneDb(); });
  afterEach(async () => { await db.close(); });

  /** Simulate a PostgREST request carrying the attacker's JWT. */
  async function asAttacker<T>(sql: string): Promise<T> {
    await db.exec(`update _ctx set uid = '${ATTACKER}', role = 'authenticated';`);
    return asRole<T>(db, 'authenticated', sql);
  }

  it('an attacker session can plant a VERIFIED row on the victim\'s account', async () => {
    // The only constraint 0099 adds is that p_phone must equal the target
    // profile's phone or phone_pending. profiles.phone is not on the 0122
    // allow-list of locked columns, so a caller can stage a value there —
    // and here the victim's own number is used, which the practice that
    // issued their bill already knows.
    const CHOSEN = 'attacker-chosen-hash';

    const prep = await asAttacker<Array<{ prepare_phone_verification_for_user: string }>>(
      `select prepare_phone_verification_for_user(
         '${VICTIM}'::uuid, '+27820000002', '${CHOSEN}'
       );`,
    );
    expect(prep[0].prepare_phone_verification_for_user).toBe('ok');

    const verify = await asAttacker<Array<{ verify_phone_otp_for_user: string }>>(
      `select verify_phone_otp_for_user(
         '${VICTIM}'::uuid, '+27820000002', '${CHOSEN}'
       );`,
    );

    // EXPLOIT: attacker's session verified the VICTIM's phone row.
    expect(verify[0].verify_phone_otp_for_user).toBe('ok');
  });

  it('an attacker session can burn the victim\'s 5 verify attempts (onboarding lockout)', async () => {
    await asAttacker(
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'real-hash');`);

    for (let i = 0; i < 5; i++) {
      await asAttacker(
        `select verify_phone_otp_for_user('${VICTIM}'::uuid, '+27820000002', 'guess');`);
    }

    // The victim, entering the correct code, is now locked out.
    const victimAttempt = await asAttacker<Array<{ verify_phone_otp_for_user: string }>>(
      `select verify_phone_otp_for_user('${VICTIM}'::uuid, '+27820000002', 'real-hash');`);
    expect(victimAttempt[0].verify_phone_otp_for_user).toBe('too_many_attempts');
  });

  it('phone_mismatch vs ok is an oracle for another account\'s phone number', async () => {
    const wrong = await asAttacker<Array<{ prepare_phone_verification_for_user: string }>>(
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27821111111', 'h');`);
    expect(wrong[0].prepare_phone_verification_for_user).toBe('phone_mismatch');

    const right = await asAttacker<Array<{ prepare_phone_verification_for_user: string }>>(
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'h');`);
    expect(right[0].prepare_phone_verification_for_user).toBe('ok');

    // Two distinguishable answers ⇒ candidate numbers can be tested against
    // a known user id until one comes back 'ok'.
  });
});

describe('A-01 / A-06 CLOSED by 0125 — the RPCs are no longer reachable from a browser', () => {
  let db: PGlite;

  beforeEach(async () => {
    db = await phoneDb();

    // 0125's allow-list is STRICT — every GRANT names a real signature — so
    // the rest of the schema it expects has to exist before it will apply.
    // The four phone-verification functions are skipped: the real 0052/0053
    // migrations already created them inside phoneDb(), which is the whole
    // point of applying the fix on top of the exploited schema rather than
    // on top of a stub of it.
    const REAL = [
      'prepare_phone_verification', 'verify_phone_otp',
      'prepare_phone_verification_for_user', 'verify_phone_otp_for_user',
    ];
    await db.exec(ALLOWLIST_STUBS_DDL);
    await db.exec(serviceRoleOnlyStubsDdl(REAL));
    await db.exec(PLATFORM_DEFAULT_PRIVILEGES_DDL);

    // Applied VERBATIM. It revokes EXECUTE from PUBLIC, anon and
    // authenticated across the schema and grants back an allow-list that
    // deliberately excludes all four phone-OTP functions.
    await db.exec(migration('0125_lock_function_execute.sql'));
  });
  afterEach(async () => { await db.close(); });

  const REVOKED = [
    'prepare_phone_verification(text,text,text)',
    'verify_phone_otp(text,text,text)',
    'prepare_phone_verification_for_user(uuid,text,text)',
    'verify_phone_otp_for_user(uuid,text,text)',
  ];

  it.each(REVOKED)('anon and authenticated cannot execute %s', async (sig) => {
    for (const role of ['anon', 'authenticated']) {
      const r = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, $2, 'EXECUTE') as ok`, [role, sig],
      );
      expect(r.rows[0].ok).toBe(false);
    }
  });

  it.each(REVOKED)('service_role still can — the four real call sites keep working (%s)', async (sig) => {
    const r = await db.query<{ ok: boolean }>(
      `select has_function_privilege('service_role', $1, 'EXECUTE') as ok`, [sig],
    );
    expect(r.rows[0].ok).toBe(true);
  });

  it('the hash-injection sequence now fails at the door, not at the comparison', async () => {
    // Same two calls as the first proof above, verbatim.
    await expect(
      asRole(db, 'anon',
        `select prepare_phone_verification('live-invitation-token', '+27829999999', 'x');`),
    ).rejects.toThrow(/permission denied for function/i);
  });

  it('and a service-role caller can still complete a genuine verification', async () => {
    // The fix must not break the flow it protects. This is the real path:
    // the server action computes the peppered hash and passes it through the
    // privileged client.
    const prep = await asRole<Array<{ prepare_phone_verification: string }>>(
      db, 'service_role',
      `select prepare_phone_verification('live-invitation-token', '+27825550000', 'peppered-hash');`);
    expect(prep[0].prepare_phone_verification).toBe('ok');

    const verify = await asRole<Array<{ verify_phone_otp: string }>>(
      db, 'service_role',
      `select verify_phone_otp('live-invitation-token', '+27825550000', 'peppered-hash');`);
    expect(verify[0].verify_phone_otp).toBe('ok');
  });
});

describe('A-02 — Postgres grants EXECUTE to PUBLIC, so service_role-only GRANTs are not exclusive', () => {
  it('next_invoice_number stays callable by authenticated AFTER 0056 revokes it', async () => {
    const db = new PGlite();
    try {
      await db.exec(ROLES_AND_AUTH);
      await db.exec(`
        grant usage on schema public to anon, authenticated, service_role;
      `);

      // 0014 creates the sequence + function and grants EXECUTE to
      // `authenticated`; 0056 is the audit fix that revokes it. Both are
      // applied VERBATIM — the roles here carry Supabase's real names, so
      // the migrations' own GRANT/REVOKE statements are what run.
      await db.exec(`create table plans (id uuid primary key default gen_random_uuid());`);
      await db.exec(migration('0014_invoice_numbers.sql'));
      await db.exec(migration('0056_revoke_next_invoice_number_from_authenticated.sql'));

      // The explicit grant to authenticated is gone…
      const explicit = await db.query<{ has: boolean }>(
        `select has_function_privilege('authenticated', 'next_invoice_number()', 'EXECUTE') as has;`,
      );

      // …but PUBLIC's default grant was never revoked, so the role still
      // has EXECUTE, and can still burn invoice numbers.
      expect(explicit.rows[0].has).toBe(true);

      const before = await asRole<Array<{ next_invoice_number: string }>>(
        db, 'authenticated', 'select next_invoice_number();');
      const after = await asRole<Array<{ next_invoice_number: string }>>(
        db, 'authenticated', 'select next_invoice_number();');
      expect(before[0].next_invoice_number).not.toBe(after[0].next_invoice_number);
    } finally {
      await db.close();
    }
  });

  it('CLOSED by 0125 — next_invoice_number is finally unreachable', async () => {
    const db = new PGlite();
    try {
      await db.exec(ROLES_AND_AUTH);
      await db.exec('grant usage on schema public to anon, authenticated, service_role;');
      await db.exec('create table plans (id uuid primary key default gen_random_uuid());');
      await db.exec(migration('0014_invoice_numbers.sql'));
      await db.exec(migration('0056_revoke_next_invoice_number_from_authenticated.sql'));

      // Same schema as the proof above, plus the rest of what 0125's
      // strict allow-list names, then the fix. next_invoice_number is
      // skipped — 0014 created the real one.
      await db.exec(ALLOWLIST_STUBS_DDL);
      await db.exec(serviceRoleOnlyStubsDdl(['next_invoice_number']));
      await db.exec(PLATFORM_DEFAULT_PRIVILEGES_DDL);
      await db.exec(migration('0125_lock_function_execute.sql'));

      const authed = await db.query<{ has: boolean }>(
        `select has_function_privilege('authenticated', 'next_invoice_number()', 'EXECUTE') as has;`);
      const anon = await db.query<{ has: boolean }>(
        `select has_function_privilege('anon', 'next_invoice_number()', 'EXECUTE') as has;`);
      const svc = await db.query<{ has: boolean }>(
        `select has_function_privilege('service_role', 'next_invoice_number()', 'EXECUTE') as has;`);

      expect(authed.rows[0].has).toBe(false);
      expect(anon.rows[0].has).toBe(false);
      // createBill and issueCounterSession call it on the privileged client.
      expect(svc.rows[0].has).toBe(true);

      await expect(
        asRole(db, 'authenticated', 'select next_invoice_number();'),
      ).rejects.toThrow(/permission denied for function/i);
    } finally {
      await db.close();
    }
  });

  it('an explicit REVOKE ... FROM PUBLIC is what actually closes it (the 0119 pattern)', async () => {
    const db = new PGlite();
    try {
      await db.exec(ROLES_AND_AUTH);
      await db.exec('grant usage on schema public to authenticated;');
      await db.exec(`
        create function only_for_service() returns int
          language sql security definer set search_path = public as $$ select 1 $$;
        grant execute on function only_for_service() to service_role;
      `);

      const leaky = await db.query<{ has: boolean }>(
        `select has_function_privilege('authenticated', 'only_for_service()', 'EXECUTE') as has;`);
      expect(leaky.rows[0].has).toBe(true);   // the defect

      await db.exec('revoke all on function only_for_service() from public;');

      const sealed = await db.query<{ has: boolean }>(
        `select has_function_privilege('authenticated', 'only_for_service()', 'EXECUTE') as has;`);
      expect(sealed.rows[0].has).toBe(false); // the fix
    } finally {
      await db.close();
    }
  });
});
