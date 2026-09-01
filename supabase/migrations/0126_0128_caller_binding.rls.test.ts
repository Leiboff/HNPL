// @vitest-environment node
//
// ─── Caller binding: 0126, 0127, 0128 ─────────────────────────────────────
//
// Three fixes that all say the same thing in three places: a function or a
// table must not take the caller's word for who the caller is.
//
//   0126  the phone-OTP user RPCs bind to auth.uid()          (audit A-06)
//   0127  accept_practice_invitation checks practice ownership (audit A-07)
//   0128  applications stops being patient-writable            (audit A-17)
//
// All three run as a NON-SUPERUSER role, because pglite's default role
// bypasses RLS unconditionally and would make this file pass with every
// policy removed.
//
// ─── The two-axis thing that is easy to get wrong here ───────────────────
//
// "Privileged" in this schema is `hnpl_write_is_privileged()` (0121), which
// reads `auth.role()` — the JWT claim — NOT the database role. So a faithful
// test has to move both axes independently:
//
//   • `set role …`      → what Postgres checks grants and RLS against
//   • `_ctx.role`       → what auth.role() returns, i.e. the JWT claim
//   • `_ctx.uid`        → what auth.uid() returns
//
// Production combinations: a browser is (authenticated, 'authenticated',
// their uid); a server action on the service client is (service_role,
// 'service_role', NULL). The NULL matters — it is why 0126 cannot be a bare
// `auth.uid() = p_user_id`, and asserting the service-role path still works
// is half of what this file is for.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const migration = (name: string) =>
  readFileSync(resolve(process.cwd(), 'supabase/migrations', name), 'utf8')
    .replace(/\r\n/g, '\n');

const ATTACKER = '11111111-1111-1111-1111-111111111111';
const VICTIM   = '22222222-2222-2222-2222-222222222222';
const PRAC_A   = 'aaaaaaaa-0000-0000-0000-000000000001';
const PRAC_B   = 'bbbbbbbb-0000-0000-0000-000000000002';

/**
 * `hnpl_write_is_privileged()` exactly as 0121 defines it. Copied rather
 * than applied from that migration because 0121 also installs triggers on
 * plans and payments, which these three fixes have nothing to do with.
 */
const PRIVILEGE_PREDICATE = `
  create or replace function hnpl_write_is_privileged()
  returns boolean language sql stable set search_path = public as $$
    select auth.role() = 'service_role'
        or current_setting('app.privileged_write', true) = 'on';
  $$;
`;

// 0126 REPAIRS that predicate — it returned NULL rather than false, which
// fails open under `IF NOT f()`. The 0127 and 0128 fixtures deliberately keep
// the BROKEN 0121 version above: their guards are written `IS NOT TRUE` and
// `IS TRUE`, so holding under the NULL-returning predicate is the stronger
// property. If either fix is ever rewritten as a bare `NOT f()`, those
// suites go red here rather than in production.

const BASE = `
  create role anon          nologin;
  create role authenticated nologin;
  -- bypassrls, as in production. RLS is not what these three fixes turn on,
  -- and without it a read-back assertion returns zero rows against a table
  -- whose only protection is "RLS on, no policies" — phone_verifications —
  -- which looks exactly like the fix having failed.
  create role service_role  nologin bypassrls;

  create table _ctx (uid uuid, role text);
  insert into _ctx values (null, 'authenticated');
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;

  create table auth.users (
    id uuid primary key, email text, email_confirmed_at timestamptz
  );
  create table profiles (
    id uuid primary key, role text, phone text, phone_pending text,
    phone_verified_at timestamptz
  );
  create table practices (
    id uuid primary key, name text, owner_id uuid, status text default 'approved'
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid, user_id uuid, role text, active boolean default true
  );
  create table practice_invitations (
    id uuid primary key default gen_random_uuid(),
    token text unique, lead_id uuid, accepted_at timestamptz,
    accepted_by_practice_id uuid, expires_at timestamptz not null
  );
  create table applications (
    id uuid primary key default gen_random_uuid(),
    patient_id uuid, practice_id uuid, bill_amount numeric(10,2),
    status text default 'pending', plan_type int
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    application_id uuid, patient_id uuid, practice_id uuid,
    status text not null default 'pending_acceptance'
  );

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;
`;

/** Who is calling: the DB role, the JWT role claim, and auth.uid(). */
type Caller = { dbRole: string; jwtRole: string; uid: string | null };

const BROWSER = (uid: string | null): Caller =>
  ({ dbRole: 'authenticated', jwtRole: 'authenticated', uid });
/** A server action on the privileged client. Note uid is NULL. */
const SERVER: Caller = { dbRole: 'service_role', jwtRole: 'service_role', uid: null };

let db: PGlite;

async function as<T>(c: Caller, sql: string): Promise<T[]> {
  await db.exec(
    `update _ctx set uid = ${c.uid ? `'${c.uid}'` : 'null'}, role = '${c.jwtRole}';`,
  );
  await db.exec(`set role ${c.dbRole};`);
  try {
    const res = await db.query(sql);
    return res.rows as T[];
  } finally {
    await db.exec('reset role;');
  }
}

/**
 * A privileged write. Sets the JWT role claim as well as running as the
 * superuser, because `hnpl_write_is_privileged()` reads auth.role() — not
 * the database role. Without the claim the column-lock triggers fire and the
 * fixture fails to build, which is a confusing way to learn that.
 */
async function svcExec(sql: string): Promise<void> {
  await db.exec(`update _ctx set role = 'service_role';`);
  await db.exec(sql);
  await db.exec(`update _ctx set role = 'authenticated';`);
}

/** Read back the row a fix was supposed to protect, from outside RLS. */
async function svcQuery<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set role = 'service_role';`);
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec(`update _ctx set role = 'authenticated';`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// 0126 — the phone-OTP user RPCs bind to auth.uid()
// ─────────────────────────────────────────────────────────────────────────

describe('0126 — phone-OTP RPCs bind to their caller (A-06)', () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(BASE);
    // The real phone-verification chain, then the privilege predicate 0126
    // depends on, then the fix.
    await db.exec(migration('0052_phone_verification.sql'));
    await db.exec(migration('0053_phone_verification_user_keying.sql'));
    await db.exec(migration('0055_phone_otp_burn_caps.sql'));
    await db.exec(migration('0086_phone_verification_pos_token.sql'));
    await db.exec(migration('0099_phone_change_reverification.sql'));
    await db.exec(PRIVILEGE_PREDICATE);
    await db.exec(migration('0126_phone_otp_caller_binding.sql'));
    // phone_verifications is created by 0052, i.e. AFTER BASE's blanket
    // grant, so it needs its own. Supabase grants table privileges to the
    // three roles and relies on RLS to scope them; 0052 gives the table RLS
    // with no policies at all, which is what actually locks it.
    await db.exec(`
      grant select, insert, update, delete on phone_verifications
        to anon, authenticated, service_role;
    `);

    await svcExec(`
      insert into auth.users (id, email, email_confirmed_at) values
        ('${ATTACKER}', 'attacker@example.com', now()),
        ('${VICTIM}',   'victim@example.com',   now());
      insert into profiles (id, role, phone) values
        ('${ATTACKER}', 'patient', '+27820000001'),
        ('${VICTIM}',   'patient', '+27820000002');
    `);
  }, 60_000);
  afterEach(async () => { await db?.close(); });

  it('an attacker session can no longer prepare a row on the victim\'s account', async () => {
    const r = await as<{ prepare_phone_verification_for_user: string }>(
      BROWSER(ATTACKER),
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'chosen');`,
    );
    expect(r[0].prepare_phone_verification_for_user).toBe('invalid_user');
  });

  it('and can no longer burn the victim\'s verify attempts', async () => {
    // Stand up a real pending verification for the victim, the way the
    // server action would.
    await as(SERVER,
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'real-hash');`);

    for (let i = 0; i < 6; i++) {
      const r = await as<{ verify_phone_otp_for_user: string }>(
        BROWSER(ATTACKER),
        `select verify_phone_otp_for_user('${VICTIM}'::uuid, '+27820000002', 'guess');`);
      // 'not_found', not 'wrong_code' — the counter is never reached.
      expect(r[0].verify_phone_otp_for_user).toBe('not_found');
    }

    const attempts = await svcQuery<{ attempts: number }>(
      `select attempts from phone_verifications where user_id = '${VICTIM}';`);
    expect(attempts[0].attempts).toBe(0);

    // And the victim's own correct code still works.
    const ok = await as<{ verify_phone_otp_for_user: string }>(SERVER,
      `select verify_phone_otp_for_user('${VICTIM}'::uuid, '+27820000002', 'real-hash');`);
    expect(ok[0].verify_phone_otp_for_user).toBe('ok');
  });

  it('the phone_mismatch / ok oracle on another account is gone', async () => {
    const wrong = await as<{ prepare_phone_verification_for_user: string }>(
      BROWSER(ATTACKER),
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27821111111', 'h');`);
    const right = await as<{ prepare_phone_verification_for_user: string }>(
      BROWSER(ATTACKER),
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'h');`);

    // Both refuse, and refuse identically — so a candidate number tells the
    // caller nothing about whose it is.
    expect(wrong[0].prepare_phone_verification_for_user).toBe('invalid_user');
    expect(right[0].prepare_phone_verification_for_user).toBe('invalid_user');
  });

  it('a caller acting on ITSELF still works (the browser path, if a grant is ever re-added)', async () => {
    const r = await as<{ prepare_phone_verification_for_user: string }>(
      BROWSER(ATTACKER),
      `select prepare_phone_verification_for_user('${ATTACKER}'::uuid, '+27820000001', 'own-hash');`);
    expect(r[0].prepare_phone_verification_for_user).toBe('ok');
  });

  it('and the real call sites — service_role with a NULL auth.uid() — still work', async () => {
    // This is the assertion that stops the fix being a bare auth.uid()
    // comparison, which would have taken the phone gate down entirely.
    const prep = await as<{ prepare_phone_verification_for_user: string }>(SERVER,
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'server-hash');`);
    expect(prep[0].prepare_phone_verification_for_user).toBe('ok');

    const verify = await as<{ verify_phone_otp_for_user: string }>(SERVER,
      `select verify_phone_otp_for_user('${VICTIM}'::uuid, '+27820000002', 'server-hash');`);
    expect(verify[0].verify_phone_otp_for_user).toBe('ok');
  });

  it('every cap from 0055/0099 is still enforced', async () => {
    // The fix must not have quietly dropped a limit while rewriting the body.
    await as(SERVER, `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'h1');`);
    const tooSoon = await as<{ prepare_phone_verification_for_user: string }>(SERVER,
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27820000002', 'h2');`);
    expect(tooSoon[0].prepare_phone_verification_for_user).toBe('too_soon');

    const mismatch = await as<{ prepare_phone_verification_for_user: string }>(SERVER,
      `select prepare_phone_verification_for_user('${VICTIM}'::uuid, '+27829998888', 'h3');`);
    expect(mismatch[0].prepare_phone_verification_for_user).toBe('phone_mismatch');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 0127 — accept_practice_invitation checks ownership
// ─────────────────────────────────────────────────────────────────────────

describe('0127 — accept_practice_invitation checks practice ownership (A-07)', () => {
  const LEAD = '33333333-3333-3333-3333-333333333333';

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(BASE);
    await db.exec(PRIVILEGE_PREDICATE);
    await db.exec(migration('0127_accept_practice_invitation_ownership.sql'));
    await svcExec(`
      insert into practices (id, name, owner_id) values
        ('${PRAC_A}', 'Attacker Practice', '${ATTACKER}'),
        ('${PRAC_B}', 'Victim Practice',   '${VICTIM}');
      insert into practice_invitations (token, lead_id, expires_at)
        values ('live-invite', '${LEAD}', now() + interval '7 days');
    `);
  }, 60_000);
  afterEach(async () => { await db?.close(); });

  it('a token holder cannot point the invitation at a practice they do not own', async () => {
    const r = await as<{ accept_practice_invitation: string | null }>(
      BROWSER(ATTACKER),
      `select accept_practice_invitation('live-invite', '${PRAC_B}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBeNull();

    // And the token is NOT burned — the genuine practitioner's link still works.
    const row = await svcQuery<{ accepted_at: string | null }>(
      `select accepted_at from practice_invitations where token = 'live-invite';`);
    expect(row[0].accepted_at).toBeNull();
  });

  it('an anonymous caller is refused', async () => {
    const r = await as<{ accept_practice_invitation: string | null }>(
      { dbRole: 'anon', jwtRole: 'anon', uid: null },
      `select accept_practice_invitation('live-invite', '${PRAC_A}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBeNull();
  });

  it('the practice OWNER may accept', async () => {
    const r = await as<{ accept_practice_invitation: string | null }>(
      BROWSER(ATTACKER),
      `select accept_practice_invitation('live-invite', '${PRAC_A}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBe(LEAD);
  });

  it('an active MEMBER of the practice may accept', async () => {
    await svcExec(`
      insert into practice_members (practice_id, user_id, role, active)
        values ('${PRAC_B}', '${ATTACKER}', 'admin', true);
    `);
    const r = await as<{ accept_practice_invitation: string | null }>(
      BROWSER(ATTACKER),
      `select accept_practice_invitation('live-invite', '${PRAC_B}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBe(LEAD);
  });

  it('an INACTIVE membership does not count', async () => {
    await svcExec(`
      insert into practice_members (practice_id, user_id, role, active)
        values ('${PRAC_B}', '${ATTACKER}', 'admin', false);
    `);
    const r = await as<{ accept_practice_invitation: string | null }>(
      BROWSER(ATTACKER),
      `select accept_practice_invitation('live-invite', '${PRAC_B}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBeNull();
  });

  it('the real call site — service_role, NULL auth.uid() — still works', async () => {
    const r = await as<{ accept_practice_invitation: string | null }>(SERVER,
      `select accept_practice_invitation('live-invite', '${PRAC_A}'::uuid);`);
    expect(r[0].accept_practice_invitation).toBe(LEAD);
  });

  it('is still idempotent — a second call returns NULL, so signup can retry', async () => {
    await as(SERVER, `select accept_practice_invitation('live-invite', '${PRAC_A}'::uuid);`);
    const second = await as<{ accept_practice_invitation: string | null }>(SERVER,
      `select accept_practice_invitation('live-invite', '${PRAC_A}'::uuid);`);
    expect(second[0].accept_practice_invitation).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 0128 — applications stops being patient-writable
// ─────────────────────────────────────────────────────────────────────────

describe('0128 — applications is locked (A-17)', () => {
  beforeEach(async () => {
    db = new PGlite();
    await db.exec(BASE);
    await db.exec(PRIVILEGE_PREDICATE);
    await db.exec(`
      create or replace function is_practice_member(p_practice_id uuid)
      returns boolean language sql stable set search_path = public as $$
        select exists (
          select 1 from practice_members
           where practice_id = p_practice_id and user_id = auth.uid() and active
        );
      $$;
      create or replace function practice_can_trade(p_practice_id uuid)
      returns boolean language sql stable set search_path = public as $$ select true $$;

      alter table applications enable row level security;

      -- 0002 + 0006 + 0043, the state 0128 changes.
      create policy "patients_select_own_applications" on applications
        for select using (patient_id = auth.uid());
      create policy "patients_insert_own_applications" on applications
        for insert with check (patient_id = auth.uid());
      create policy "practice_members_select_applications" on applications
        for select using (is_practice_member(practice_id));
      create policy "practice_members_insert_applications" on applications
        for insert with check (
          is_practice_member(practice_id) and practice_can_trade(practice_id)
        );
      create policy "practice_members_delete_applications" on applications
        for delete using (is_practice_member(practice_id));
    `);
    await db.exec(migration('0128_applications_lockdown.sql'));

    await svcExec(`
      insert into practices (id, name, owner_id) values ('${PRAC_A}', 'A', '${VICTIM}');
      insert into practice_members (practice_id, user_id, role, active)
        values ('${PRAC_A}', '${VICTIM}', 'admin', true);
    `);
  }, 60_000);
  afterEach(async () => { await db?.close(); });

  it('a patient can no longer insert a phantom application', async () => {
    await expect(as(BROWSER(ATTACKER), `
      insert into applications (patient_id, practice_id, bill_amount, status)
        values ('${ATTACKER}', '${PRAC_A}', 99999, 'pending');
    `)).rejects.toThrow(/row-level security/i);
  });

  it('a practice member may still raise one at pending', async () => {
    const rows = await as<{ id: string }>(BROWSER(VICTIM), `
      insert into applications (patient_id, practice_id, bill_amount, status)
        values ('${ATTACKER}', '${PRAC_A}', 1200, 'pending')
      returning id;
    `);
    expect(rows).toHaveLength(1);
  });

  it('…but not one that is already approved', async () => {
    await expect(as(BROWSER(VICTIM), `
      insert into applications (patient_id, practice_id, bill_amount, status)
        values ('${ATTACKER}', '${PRAC_A}', 1200, 'approved');
    `)).rejects.toThrow(/must start at pending/i);
  });

  it('no user session may UPDATE an application — RLS has no policy for it', async () => {
    await svcExec(`
      insert into applications (id, patient_id, practice_id, bill_amount, status)
        values ('44444444-4444-4444-4444-444444444444', '${ATTACKER}', '${PRAC_A}', 1200, 'pending');
    `);
    // No UPDATE policy exists on the table, so RLS filters the statement to
    // zero rows rather than raising. Assert the ROW, not the error: a silent
    // no-op and a refusal are the same outcome here, and only the row proves it.
    await as(BROWSER(VICTIM),
      `update applications set bill_amount = 1 where id = '44444444-4444-4444-4444-444444444444';`);
    const row = await svcQuery<{ bill_amount: string }>(
      `select bill_amount from applications where id = '44444444-4444-4444-4444-444444444444';`);
    expect(Number(row[0].bill_amount)).toBe(1200);
  });

  it('…and the trigger is the backstop if an UPDATE policy is ever added', async () => {
    // This is the whole reason 0121 added triggers behind policies it had
    // just dropped: a policy re-added later must not silently reopen the
    // hole. Adding the policy here is the only way to test that the second
    // layer exists.
    await db.exec(`
      create policy "someone_adds_this_later" on applications
        for update using (is_practice_member(practice_id))
                   with check (is_practice_member(practice_id));
    `);
    await svcExec(`
      insert into applications (id, patient_id, practice_id, bill_amount, status)
        values ('88888888-8888-8888-8888-888888888888', '${ATTACKER}', '${PRAC_A}', 1200, 'pending');
    `);
    await expect(as(BROWSER(VICTIM),
      `update applications set bill_amount = 1 where id = '88888888-8888-8888-8888-888888888888';`,
    )).rejects.toThrow(/not writable from a user session/i);
  });

  it('a practice may roll back an application it just raised', async () => {
    await svcExec(`
      insert into applications (id, patient_id, practice_id, bill_amount, status)
        values ('55555555-5555-5555-5555-555555555555', '${ATTACKER}', '${PRAC_A}', 1200, 'pending');
    `);
    await as(BROWSER(VICTIM),
      `delete from applications where id = '55555555-5555-5555-5555-555555555555';`);
    const left = await svcQuery<{ n: number }>(`select count(*)::int as n from applications;`);
    expect(left[0].n).toBe(0);
  });

  it('…but not one whose plan is past acceptance', async () => {
    await svcExec(`
      insert into applications (id, patient_id, practice_id, bill_amount, status)
        values ('66666666-6666-6666-6666-666666666666', '${ATTACKER}', '${PRAC_A}', 1200, 'pending');
      insert into plans (application_id, patient_id, practice_id, status)
        values ('66666666-6666-6666-6666-666666666666', '${ATTACKER}', '${PRAC_A}', 'active');
    `);
    await expect(as(BROWSER(VICTIM),
      `delete from applications where id = '66666666-6666-6666-6666-666666666666';`,
    )).rejects.toThrow(/plan past acceptance/i);
  });

  it('the privileged client is unaffected — every server-side write still lands', async () => {
    await svcExec(`
      insert into applications (id, patient_id, practice_id, bill_amount, status)
        values ('77777777-7777-7777-7777-777777777777', '${ATTACKER}', '${PRAC_A}', 1200, 'approved');
      update applications set plan_type = 3 where id = '77777777-7777-7777-7777-777777777777';
      delete from applications where id = '77777777-7777-7777-7777-777777777777';
    `);
    const left = await svcQuery<{ n: number }>(`select count(*)::int as n from applications;`);
    expect(left[0].n).toBe(0);
  });
});
