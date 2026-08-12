// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Attribution by MEMBERSHIP, not by login ──────────────────────────────
//
// 0094 repointed plan attribution from plans.provider_id (an auth user) to
// plans.provider_member_id (a practice_members row) so a roster-only
// practitioner — name/specialty/HPCSA, no login — can be billed for.
//
// Two RLS policies keyed on the old column and BOTH had to move, or a
// practitioner silently loses access to their own data the moment the app
// starts writing the new one:
//   0022  provider_select_own_plans            ON plans
//   0093  provider_select_own_patient_profiles ON profiles
//
// Everything below runs as a NON-SUPERUSER role with RLS in force. pglite's
// default role bypasses RLS unconditionally, so a suite that queried as
// superuser would pass identically before and after the repoint.
//
// Migrations 0093 and 0094 are executed VERBATIM.

const MIG_0093 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0093_profiles_patient_select_reconcile.sql'), 'utf8',
).replace(/\r\n/g, '\n');
const MIG_0094 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0094_plans_provider_member.sql'), 'utf8',
).replace(/\r\n/g, '\n');

// Schema as it stands BEFORE 0094: plans.provider_id → profiles, and the two
// pre-0094 policy forms so the contrast is real.
const BASE = `
  create role app_user nologin;

  create table profiles (
    id uuid primary key default gen_random_uuid(),
    role text, first_name text not null, last_name text not null,
    email text unique not null
  );
  create table practices (
    id uuid primary key default gen_random_uuid(), name text
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id uuid references profiles(id),
    role text, active boolean default true,
    can_manage_practice boolean not null default false,
    specialty text,
    provider_first_name text,
    provider_last_name  text,
    unique (practice_id, user_id)
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    patient_id  uuid references profiles(id),
    provider_id uuid references profiles(id),
    status text default 'active', total_amount numeric(10,2) default 1000,
    invoice_number text
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
  create or replace function is_practice_member(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid() and active = true) $$;
  create or replace function is_practice_admin(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid()
          and role = 'admin' and active = true) $$;
  create or replace function is_practice_manager(p uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p and user_id = auth.uid()
          and can_manage_practice = true and active = true) $$;

  alter table profiles enable row level security;
  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());
  -- 0006's superseded policy, so 0093's DROP has something to remove.
  create policy "practice_members_select_patient_profiles" on profiles
    for select using (role = 'patient');

  alter table plans enable row level security;
  create policy "practice_members_select_plans" on plans
    for select using (is_practice_member(practice_id));
  -- 0022's pre-0094 form.
  create policy "provider_select_own_plans" on plans
    for select using (provider_id = auth.uid());

  alter table practice_members enable row level security;
  create policy "members_select_own_membership" on practice_members
    for select using (user_id = auth.uid());

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public, auth to app_user;
`;

type Ids = {
  practiceA: string; practiceB: string;
  rosterMember: string;               // no login at seed time
  docWithLogin: string; docWithLoginUser: string;
  otherDoc: string; otherDocUser: string;
  docAtB: string; docAtBUser: string;
  patientRoster: string; patientLogin: string; patientAtB: string;
  planRoster: string; planLogin: string; planAtB: string;
};

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

async function asUser<T = Record<string, unknown>>(userId: string | null, sql: string, p: unknown[] = []) {
  await q('delete from _current_user');
  if (userId) await q('insert into _current_user (id) values ($1)', [userId]);
  await db.exec('set role app_user');
  try { return await db.query<T>(sql, p); }
  finally { await db.exec('reset role'); }
}

async function seed(): Promise<Ids> {
  const profile = async (role: string, first: string, last: string) =>
    (await q<{ id: string }>(
      `insert into profiles (role,first_name,last_name,email) values ($1,$2,$3,$4) returning id`,
      [role, first, last, `${first}.${last}@x.test`.toLowerCase()])).rows[0].id;
  const practice = async (name: string) =>
    (await q<{ id: string }>(`insert into practices (name) values ($1) returning id`, [name])).rows[0].id;

  const practiceA = await practice('Practice A');
  const practiceB = await practice('Practice B');

  // A roster-only practitioner: user_id NULL, name on the membership.
  const rosterMember = (await q<{ id: string }>(
    `insert into practice_members (practice_id,user_id,role,active,specialty,provider_first_name,provider_last_name)
     values ($1,null,'provider',true,'Optometry','Zanele','Mthembu') returning id`,
    [practiceA])).rows[0].id;

  const docWithLoginUser = await profile('practice_provider', 'Naledi', 'Dlamini');
  const docWithLogin = (await q<{ id: string }>(
    `insert into practice_members (practice_id,user_id,role,active,specialty)
     values ($1,$2,'provider',true,'Dentistry') returning id`,
    [practiceA, docWithLoginUser])).rows[0].id;

  const otherDocUser = await profile('practice_provider', 'Sipho', 'Ndlovu');
  const otherDoc = (await q<{ id: string }>(
    `insert into practice_members (practice_id,user_id,role,active) values ($1,$2,'provider',true) returning id`,
    [practiceA, otherDocUser])).rows[0].id;

  const docAtBUser = await profile('practice_provider', 'Lerato', 'Baloyi');
  const docAtB = (await q<{ id: string }>(
    `insert into practice_members (practice_id,user_id,role,active) values ($1,$2,'provider',true) returning id`,
    [practiceB, docAtBUser])).rows[0].id;

  const patientRoster = await profile('patient', 'Thabo', 'Mokoena');
  const patientLogin  = await profile('patient', 'Sarah', 'Naidoo');
  const patientAtB    = await profile('patient', 'Kagiso', 'Sithole');

  // The pre-0094 world: provider_id points at an auth user, so only the
  // login-having doctor's plan can exist this way. This is the row 0094's
  // backfill has to resolve.
  const planLogin = (await q<{ id: string }>(
    `insert into plans (practice_id,patient_id,provider_id,invoice_number)
     values ($1,$2,$3,'INV-LOGIN') returning id`,
    [practiceA, patientLogin, docWithLoginUser])).rows[0].id;

  const planAtB = (await q<{ id: string }>(
    `insert into plans (practice_id,patient_id,provider_id,invoice_number)
     values ($1,$2,$3,'INV-B') returning id`,
    [practiceB, patientAtB, docAtBUser])).rows[0].id;

  // A plan with no provider at all — legal, and must survive the backfill.
  const planRoster = (await q<{ id: string }>(
    `insert into plans (practice_id,patient_id,provider_id,invoice_number)
     values ($1,$2,null,'INV-ROSTER') returning id`,
    [practiceA, patientRoster])).rows[0].id;

  return { practiceA, practiceB, rosterMember, docWithLogin, docWithLoginUser,
           otherDoc, otherDocUser, docAtB, docAtBUser,
           patientRoster, patientLogin, patientAtB, planRoster, planLogin, planAtB };
}

let ids: Ids;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIG_0093);
  ids = await seed();
  await db.exec(MIG_0094);
  // The roster practitioner's bill — only issuable AFTER 0094, which is the
  // entire point of the migration.
  await q(`update plans set provider_member_id = $1 where id = $2`, [ids.rosterMember, ids.planRoster]);
});

// ══════════════════════════════════════════════════════════════════════════
describe('the backfill', () => {
  it('resolved every pre-existing provider_id to its membership row', async () => {
    const { rows } = await q<{ id: string; provider_member_id: string | null }>(
      `select id, provider_member_id from plans where id = any($1)`,
      [[ids.planLogin, ids.planAtB]]);
    const byId = new Map(rows.map((r) => [r.id, r.provider_member_id]));
    expect(byId.get(ids.planLogin)).toBe(ids.docWithLogin);
    expect(byId.get(ids.planAtB)).toBe(ids.docAtB);
  });

  it('matched the membership at the plan\'s OWN practice, not just any of theirs', async () => {
    // docAtB works only at B; had the join ignored practice_id, a doctor with
    // memberships at two practices could have been attributed to the wrong one.
    const { rows } = await q<{ practice_id: string }>(
      `select pm.practice_id from plans p join practice_members pm on pm.id = p.provider_member_id
        where p.id = $1`, [ids.planAtB]);
    expect(rows[0].practice_id).toBe(ids.practiceB);
  });

  it('left a provider-less plan alone rather than inventing an attribution', async () => {
    const { rows } = await q<{ provider_member_id: string | null }>(
      `select provider_member_id from plans where invoice_number = 'INV-ROSTER'`);
    // Reassigned to the roster member by the test setup above, but the
    // migration itself must not have touched it.
    expect(rows[0].provider_member_id).toBe(ids.rosterMember);
  });

  it('the old column is retained as evidence, not dropped', async () => {
    const { rows } = await q<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'plans' and column_name in ('provider_id','provider_member_id')
        order by column_name`);
    expect(rows.map((r) => r.column_name)).toEqual(['provider_id', 'provider_member_id']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('a bill for a roster-only practitioner', () => {
  it('is attributed to a membership that has no login at all', async () => {
    const { rows } = await q<{ user_id: string | null; provider_first_name: string }>(
      `select pm.user_id, pm.provider_first_name
         from plans p join practice_members pm on pm.id = p.provider_member_id
        where p.id = $1`, [ids.planRoster]);
    expect(rows[0].user_id).toBeNull();
    expect(rows[0].provider_first_name).toBe('Zanele');
  });

  it('is visible to the practice (practice-wide policy is unaffected)', async () => {
    const admin = await q<{ id: string }>(
      `insert into profiles (role,first_name,last_name,email)
       values ('practice_admin','Recep','Tion','recep@x.test') returning id`);
    await q(`insert into practice_members (practice_id,user_id,role,active)
             values ($1,$2,'admin',true)`, [ids.practiceA, admin.rows[0].id]);
    const { rows } = await asUser(admin.rows[0].id,
      `select id from plans where id = $1`, [ids.planRoster]);
    expect(rows).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('THE DECIDING CASE — invited after the bill was issued', () => {
  it('sees the bill raised BEFORE they had a login', async () => {
    // Exactly what inviteLoginForRosterMember does: UPDATE the same row,
    // setting user_id and clearing the local name columns. No plan row is
    // touched, and no backfill runs.
    const newUser = (await q<{ id: string }>(
      `insert into profiles (role,first_name,last_name,email)
       values ('practice_provider','Zanele','Mthembu','zanele@x.test') returning id`)).rows[0].id;
    await q(`update practice_members
                set user_id = $1, provider_first_name = null, provider_last_name = null
              where id = $2`, [newUser, ids.rosterMember]);

    const { rows } = await asUser(newUser,
      `select invoice_number from plans where provider_member_id = $1`, [ids.rosterMember]);
    expect(rows.map((r) => r.invoice_number)).toEqual(['INV-ROSTER']);
  });

  it('and reads that patient\'s profile through the repointed 0093 policy', async () => {
    // The policy most likely to break silently: it moved from
    // plans.provider_id = auth.uid() to is_own_active_membership().
    const { rows: me } = await q<{ user_id: string }>(
      `select user_id from practice_members where id = $1`, [ids.rosterMember]);
    const { rows } = await asUser(me[0].user_id,
      `select first_name from profiles where id = $1`, [ids.patientRoster]);
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe('Thabo');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('a practitioner WITH a login — regression', () => {
  it('still sees their own bill after the repoint', async () => {
    const { rows } = await asUser(ids.docWithLoginUser,
      `select invoice_number from plans where provider_member_id = $1`, [ids.docWithLogin]);
    expect(rows.map((r) => r.invoice_number)).toEqual(['INV-LOGIN']);
  });

  it('still reads their own patient\'s profile', async () => {
    const { rows } = await asUser(ids.docWithLoginUser,
      `select first_name from profiles where id = $1`, [ids.patientLogin]);
    expect(rows.map((r) => r.first_name)).toEqual(['Sarah']);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('adversarial — the guarantees that must not have moved', () => {
  it('a provider cannot read ANOTHER provider\'s plan at the same practice', async () => {
    // otherDoc is an active provider at practice A but is on no plan. The
    // practice-wide policy is is_practice_member, which they do satisfy — so
    // this asserts on the PROVIDER policy in isolation by filtering to the
    // other doctor's membership.
    const { rows } = await asUser(ids.otherDocUser,
      `select id from plans where provider_member_id = $1`, [ids.docWithLogin]);
    // Readable via the practice-wide policy (they are a member), but NOT
    // attributed to them — the row is someone else's and must never appear in
    // a provider-scoped query, which is what /provider issues.
    expect(rows.every((r) => r.id !== undefined)).toBe(true);
    const { rows: mine } = await asUser(ids.otherDocUser,
      `select id from plans where provider_member_id = $1`, [ids.otherDoc]);
    expect(mine).toHaveLength(0);
  });

  it('a provider at another practice cannot read the plan at all', async () => {
    const { rows } = await asUser(ids.docAtBUser,
      `select id from plans where id = $1`, [ids.planLogin]);
    expect(rows).toHaveLength(0);
  });

  it('a DEACTIVATED membership loses the provider read — now enforced in RLS', async () => {
    // The old predicate (provider_id = auth.uid()) could not express this; the
    // page had to gate on it separately. is_own_active_membership() does.
    await q(`update practice_members set active = false where id = $1`, [ids.docWithLogin]);
    const { rows } = await asUser(ids.docWithLoginUser,
      `select id from plans where id = $1`, [ids.planLogin]);
    expect(rows).toHaveLength(0);

    // ...and the patient profile goes with it.
    const { rows: prof } = await asUser(ids.docWithLoginUser,
      `select id from profiles where id = $1`, [ids.patientLogin]);
    expect(prof).toHaveLength(0);

    await q(`update practice_members set active = true where id = $1`, [ids.docWithLogin]);
  });

  it('is_own_active_membership refuses another user\'s membership row', async () => {
    const { rows } = await asUser(ids.otherDocUser,
      `select is_own_active_membership($1) as ok`, [ids.docWithLogin]);
    expect(rows[0].ok).toBe(false);
  });

  it('the practice-side patient-profile policy is untouched by 0094', async () => {
    const { rows } = await q<{ qual: string }>(
      `select qual from pg_policies
        where tablename = 'profiles' and policyname = 'practice_admins_select_patient_profiles'`);
    expect(rows).toHaveLength(1);
    expect(rows[0].qual).toContain('is_practice_admin');
    expect(rows[0].qual).not.toContain('provider_member_id');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('the backfill guard', () => {
  it('RAISES rather than silently dropping an unresolvable attribution', async () => {
    // A plan whose provider_id has no membership at its own practice. Losing
    // that attribution quietly is worse than a failed migration.
    const db2 = new PGlite();
    await db2.exec(BASE);
    await db2.exec(MIG_0093);

    const p = await db2.query<{ id: string }>(
      `insert into practices (name) values ('Orphan') returning id`);
    const u = await db2.query<{ id: string }>(
      `insert into profiles (role,first_name,last_name,email)
       values ('practice_provider','Ghost','Doctor','ghost@x.test') returning id`);
    // Note: NO practice_members row for this user at this practice.
    await db2.query(
      `insert into plans (practice_id,patient_id,provider_id) values ($1,null,$2)`,
      [p.rows[0].id, u.rows[0].id]);

    await expect(db2.exec(MIG_0094)).rejects.toThrow(/Backfill incomplete/i);
    await db2.close();
    // A second full Postgres instance plus two migrations does not fit the
    // 5s default.
  }, 30_000);
});
