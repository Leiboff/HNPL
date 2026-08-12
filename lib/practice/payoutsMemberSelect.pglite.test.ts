// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── payouts SELECT widened to member-level, with RLS ACTUALLY ON ───────
//
// The claim is a policy claim, so these tests run as a NON-SUPERUSER role with
// row level security in force. That distinction is the whole point: pglite's
// default role bypasses RLS unconditionally, so a test suite that seeds and
// queries as superuser would pass identically before and after this migration
// and prove nothing.
//
// Migration 0092 is executed VERBATIM.

const MIG_0092 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0092_payouts_member_select.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// payouts and practice_members as they stand, plus the pre-0092 policy set on
// payouts so the migration has something real to replace. auth.uid() is a
// settable stand-in so each test can act as a different caller.
const BASE_SCHEMA = `
  create role app_user nologin;

  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table profiles (
    id uuid primary key default gen_random_uuid(),
    first_name text not null, last_name text not null, email text unique not null
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    status text, total_amount numeric(10,2)
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id uuid references profiles(id),
    role text, active boolean default true,
    can_manage_practice boolean not null default false,
    unique (practice_id, user_id)
  );
  create table payouts (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    plan_id     uuid references plans(id) unique,
    provider_id uuid,
    gross_amount numeric(10,2) not null,
    fee_amount   numeric(10,2) not null,
    net_amount   numeric(10,2) not null,
    status text default 'pending',
    payout_destination text default 'practice',
    -- The five columns the migration's warning is about.
    snapshot_bank_name      text,
    snapshot_account_holder text,
    snapshot_account_number text,
    snapshot_branch_code    text,
    snapshot_account_type   text,
    batch_id uuid,
    paid_at timestamptz,
    created_at timestamptz default now()
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  -- Real bodies, 0002 / 0034.
  create or replace function is_practice_member(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth.uid() and active = true) $$;
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth.uid()
          and can_manage_practice = true and active = true) $$;
  create or replace function is_platform_admin() returns boolean
    language sql stable as $$ select false $$;
  create or replace function is_brand_admin_of_practice(p uuid) returns boolean
    language sql stable as $$ select false $$;

  -- The pre-0092 policy set on payouts (0002 + 0022 + 0035 + 0061).
  alter table payouts enable row level security;
  create policy "practice_admins_select_payouts" on payouts
    for select using (is_practice_manager(practice_id));
  create policy "admins_all_payouts" on payouts
    for all using (is_platform_admin());
  create policy "provider_select_own_payouts" on payouts
    for select using (provider_id = auth.uid());
  create policy "brand_admin_select_branch_payouts" on payouts
    for select using (is_brand_admin_of_practice(practice_id));

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public, auth to app_user;
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

/** Run a statement as the RLS-bound app_user, then restore the session role. */
async function asAppUser<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  await db.exec('set role app_user');
  try {
    return await db.query<T>(sql, params);
  } finally {
    await db.exec('reset role');
  }
}

const beCaller = async (userId: string | null) => {
  await q('delete from _current_user');
  if (userId) await q('insert into _current_user (id) values ($1)', [userId]);
};

let practiceA: string, practiceB: string;
let managerA: string, staffA: string, staffB: string, outsider: string;

async function seedMember(practiceId: string, email: string, canManage: boolean, active = true) {
  const p = await q<{ id: string }>(
    `insert into profiles (first_name,last_name,email) values ('T','U',$1) returning id`, [email]);
  await q(
    `insert into practice_members (practice_id,user_id,role,active,can_manage_practice)
     values ($1,$2,'staff',$3,$4)`, [practiceId, p.rows[0].id, active, canManage]);
  return p.rows[0].id;
}

async function seedPayout(practiceId: string, net: number, withSnapshot = false) {
  const plan = await q<{ id: string }>(
    `insert into plans (practice_id,status,total_amount) values ($1,'active',$2) returning id`,
    [practiceId, net * 2]);
  const { rows } = await q<{ id: string }>(
    `insert into payouts
       (practice_id, plan_id, gross_amount, fee_amount, net_amount,
        snapshot_account_holder, snapshot_account_number)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [practiceId, plan.rows[0].id, net * 2, net, net,
     withSnapshot ? 'Dr A Provider' : null,
     withSnapshot ? '1234567890'    : null]);
  return rows[0].id;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE_SCHEMA);
});

beforeEach(async () => {
  await db.exec('truncate payouts, plans, practice_members, practices, profiles, _current_user cascade');
  practiceA = (await q<{ id: string }>(`insert into practices (name) values ('A') returning id`)).rows[0].id;
  practiceB = (await q<{ id: string }>(`insert into practices (name) values ('B') returning id`)).rows[0].id;
  managerA = await seedMember(practiceA, 'mgr-a@x.test',   true);
  staffA   = await seedMember(practiceA, 'staff-a@x.test', false);
  staffB   = await seedMember(practiceB, 'staff-b@x.test', false);
  outsider = (await q<{ id: string }>(
    `insert into profiles (first_name,last_name,email) values ('No','Member','out@x.test') returning id`
  )).rows[0].id;
});

afterAll(async () => { await db?.close(); });

// ─── BEFORE: the asymmetry this migration removes ───────────────────────

describe('BEFORE 0092 — a non-manager member cannot read payouts', () => {
  it('the manager sees the row and the ordinary member does not', async () => {
    await seedPayout(practiceA, 100);

    await beCaller(managerA);
    const mgr = await asAppUser(`select id from payouts`);
    expect(mgr.rows).toHaveLength(1);

    await beCaller(staffA);
    const staff = await asAppUser(`select id from payouts`);
    expect(staff.rows).toHaveLength(0);   // the reported problem
  });
});

// ─── Apply the migration, then everything below is the AFTER state ──────

describe('AFTER 0092 — member-level SELECT', () => {
  beforeEach(async () => { await db.exec(MIG_0092); });

  it('THE POINT: a non-manager member can SELECT payouts directly', async () => {
    await seedPayout(practiceA, 100);
    await seedPayout(practiceA, 250);

    await beCaller(staffA);
    const { rows } = await asAppUser<{ net_amount: string }>(
      `select net_amount from payouts order by net_amount`);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => Number(r.net_amount))).toEqual([100, 250]);
  });

  it('the manager still sees them — nothing was traded away', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(managerA);
    expect((await asAppUser(`select id from payouts`)).rows).toHaveLength(1);
  });

  it('the OLD policy is gone and the new one is named for what it does', async () => {
    const { rows } = await q<{ policyname: string; cmd: string; qual: string }>(
      `select policyname, cmd, qual from pg_policies
        where tablename = 'payouts' order by policyname`);
    const names = rows.map((r) => r.policyname);
    expect(names).not.toContain('practice_admins_select_payouts');
    expect(names).toContain('practice_members_select_payouts');

    const widened = rows.find((r) => r.policyname === 'practice_members_select_payouts')!;
    expect(widened.cmd).toBe('SELECT');
    expect(widened.qual).toMatch(/is_practice_member/);
    expect(widened.qual).not.toMatch(/is_practice_manager/);
  });

  it('matches payout_batches\' predicate shape exactly', async () => {
    // Same function, same argument — that is what "aligned" has to mean.
    const { rows } = await q<{ qual: string }>(
      `select qual from pg_policies
        where tablename = 'payouts' and policyname = 'practice_members_select_payouts'`);
    expect(rows[0].qual.replace(/\s+/g, '')).toMatch(/is_practice_member\(practice_id\)/);
  });

  it('the other SELECT policies survive — they are OR\'d, not replaced', async () => {
    const { rows } = await q<{ policyname: string }>(
      `select policyname from pg_policies where tablename = 'payouts'`);
    const names = rows.map((r) => r.policyname);
    expect(names).toContain('provider_select_own_payouts');
    expect(names).toContain('brand_admin_select_branch_payouts');
    expect(names).toContain('admins_all_payouts');
  });
});

// ─── ADVERSARIAL ────────────────────────────────────────────────────────

describe('ADVERSARIAL — after 0092', () => {
  beforeEach(async () => { await db.exec(MIG_0092); });

  it('a member of ANOTHER practice still sees nothing', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(staffB);
    expect((await asAppUser(`select id from payouts`)).rows).toHaveLength(0);
  });

  it('with both practices holding payouts, each member sees only their own', async () => {
    await seedPayout(practiceA, 111);
    await seedPayout(practiceB, 999);

    await beCaller(staffA);
    const a = await asAppUser<{ net_amount: string }>(`select net_amount from payouts`);
    expect(a.rows.map((r) => Number(r.net_amount))).toEqual([111]);

    await beCaller(staffB);
    const b = await asAppUser<{ net_amount: string }>(`select net_amount from payouts`);
    expect(b.rows.map((r) => Number(r.net_amount))).toEqual([999]);
  });

  it('a member cannot reach another practice\'s row by naming its id', async () => {
    const target = await seedPayout(practiceB, 999);
    await beCaller(staffA);
    const { rows } = await asAppUser(`select id from payouts where id = $1`, [target]);
    expect(rows).toHaveLength(0);
  });

  it('a DEACTIVATED member loses the read they just gained', async () => {
    await seedPayout(practiceA, 100);
    await q(`update practice_members set active = false where user_id = $1`, [staffA]);
    await beCaller(staffA);
    expect((await asAppUser(`select id from payouts`)).rows).toHaveLength(0);
  });

  it('a signed-out caller sees nothing', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(null);
    expect((await asAppUser(`select id from payouts`)).rows).toHaveLength(0);
  });

  it('an authenticated NON-member sees nothing', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(outsider);
    expect((await asAppUser(`select id from payouts`)).rows).toHaveLength(0);
  });

  // ── Write access is untouched ──────────────────────────────────────────

  it('STILL CANNOT WRITE: a member cannot UPDATE a payout', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(staffA);
    // No practice-side UPDATE policy exists, so the row is invisible to the
    // UPDATE and zero rows change — RLS filters rather than raising.
    const { rows } = await asAppUser(
      `update payouts set status = 'paid' returning id`);
    expect(rows).toHaveLength(0);

    const check = await q<{ status: string }>(`select status from payouts`);
    expect(check.rows[0].status).toBe('pending');
  });

  it('STILL CANNOT WRITE: a member cannot mark themselves paid via batch_id either', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(staffA);
    const { rows } = await asAppUser(
      `update payouts set batch_id = gen_random_uuid() returning id`);
    expect(rows).toHaveLength(0);
  });

  it('STILL CANNOT WRITE: a member cannot DELETE a payout', async () => {
    await seedPayout(practiceA, 100);
    await beCaller(staffA);
    const { rows } = await asAppUser(`delete from payouts returning id`);
    expect(rows).toHaveLength(0);
    expect((await q(`select id from payouts`)).rows).toHaveLength(1);
  });

  it('STILL CANNOT WRITE: not even a MANAGER can write a payout', async () => {
    // There was never a practice-side write policy and 0092 adds none.
    await seedPayout(practiceA, 100);
    await beCaller(managerA);
    expect((await asAppUser(`update payouts set status = 'paid' returning id`)).rows).toHaveLength(0);
    expect((await asAppUser(`delete from payouts returning id`)).rows).toHaveLength(0);
  });

  it('STILL CANNOT WRITE: a member cannot INSERT a payout for their practice', async () => {
    await beCaller(staffA);
    const plan = await q<{ id: string }>(
      `insert into plans (practice_id,status,total_amount) values ($1,'active',200) returning id`,
      [practiceA]);
    // 0009's INSERT policy is the patient-accepting-a-plan path; nothing here
    // grants a practice member an insert, so the WITH CHECK fails outright.
    await expect(asAppUser(
      `insert into payouts (practice_id, plan_id, gross_amount, fee_amount, net_amount)
       values ($1,$2,200,20,180)`, [practiceA, plan.rows[0].id],
    )).rejects.toThrow(/row-level security/i);
  });
});

// ─── ⚠️ The column-level consequence, stated as a test ───────────────────

describe('⚠️ RLS is ROW-level: the snapshot_* columns ride along', () => {
  beforeEach(async () => { await db.exec(MIG_0092); });

  it('an ordinary member can now read a historical row\'s PERSONAL BANK DETAILS', async () => {
    // Not a bug in the migration — a consequence of it, pinned here so it
    // cannot be discovered later by surprise. The five snapshot_* columns
    // captured a provider's own banking back when payout_destination could be
    // 'provider'. The feature is gone; the columns deliberately remain (0090).
    //
    // If any real row holds this data, the fix is a column-restricted VIEW for
    // the practice-facing read — the approach 0064 took for the patient-facing
    // practitioners directory — NOT a narrower row predicate, which would just
    // reinstate the asymmetry 0092 exists to remove.
    await seedPayout(practiceA, 100, /* withSnapshot */ true);

    await beCaller(staffA);
    const { rows } = await asAppUser<{
      snapshot_account_holder: string | null; snapshot_account_number: string | null;
    }>(`select snapshot_account_holder, snapshot_account_number from payouts`);

    expect(rows).toHaveLength(1);
    expect(rows[0].snapshot_account_holder).toBe('Dr A Provider');
    expect(rows[0].snapshot_account_number).toBe('1234567890');
  });

  it('the migration records this consequence in its own text', () => {
    // So the next person reading the policy finds the warning at the point of
    // change rather than in a commit message.
    expect(MIG_0092).toMatch(/ROW-level, not COLUMN-level/);
    expect(MIG_0092).toMatch(/snapshot_account_number/);
    expect(MIG_0092).toMatch(/column-restricted VIEW/);
  });
});
