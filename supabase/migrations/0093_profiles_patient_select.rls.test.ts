// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── profiles patient-SELECT RLS — the test 0006 never had ────────────────
//
// This is the regression guard for a cross-tenant read of patient personal
// data. 0006's practice_members_select_patient_profiles had an UNCORRELATED
// EXISTS — "is the caller an active member of ANY practice" rather than "is
// the caller related to THIS patient" — so on paper any active member of any
// practice could read every patient profile in the system. Production had
// already been fixed out of band; 0093 back-ports that fix into the repo.
//
// Two things make this test worth the setup cost:
//
//   1. RLS IS ACTUALLY ENFORCED. Every read runs as `app_user`, a
//      non-superuser role. pglite's default role bypasses RLS
//      unconditionally, so a suite that queried as superuser would pass
//      identically before and after 0093 and prove nothing.
//
//   2. THE HELPERS ARE REAL, NOT STUBBED. is_practice_admin's real body
//      (0002) is installed and resolves through practice_members +
//      auth.uid(). A GUC-stubbed helper returning one boolean for every
//      practice would make the cross-tenant case untestable — it is
//      precisely the PER-PRACTICE correlation that is under test.
//
// Migration 0093 is executed VERBATIM from the file.

const MIG_0093 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0093_profiles_patient_select_reconcile.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const OLD_POLICY = 'practice_members_select_patient_profiles';
const NEW_ADMIN_POLICY = 'practice_admins_select_patient_profiles';
const NEW_PROVIDER_POLICY = 'provider_select_own_patient_profiles';

// Tables, real helper bodies (0002), and the profiles policies that 0093
// leaves alone. auth.uid() is a settable stand-in so each test can act as a
// different caller.
const BASE_SCHEMA = `
  create role app_user nologin;

  create table profiles (
    id uuid primary key default gen_random_uuid(),
    role text,
    first_name text not null, last_name text not null,
    email text unique not null,
    phone text
  );
  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid references practices(id),
    user_id uuid references profiles(id),
    role text, active boolean default true,
    can_manage_practice boolean not null default false
  );
  create table plans (
    id uuid primary key default gen_random_uuid(),
    patient_id  uuid references profiles(id),
    practice_id uuid references practices(id),
    provider_id uuid references profiles(id),
    status text default 'active',
    total_amount numeric(10,2) default 100
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  -- Real bodies, 0002. SECURITY DEFINER exactly as in production, so they
  -- see practice_members without re-entering RLS.
  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin') $$;
  create or replace function is_practice_member(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth.uid() and active = true) $$;
  create or replace function is_practice_admin(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth.uid()
          and role = 'admin' and active = true) $$;
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public, auth as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth.uid()
          and can_manage_practice = true and active = true) $$;

  alter table profiles enable row level security;

  -- The profiles policies 0093 does NOT touch (0002 / 0022 / 0035).
  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());
  create policy "admins_select_all_profiles" on profiles
    for select using (is_platform_admin());
  create policy "practice_admin_select_member_profiles" on profiles
    for select using (
      exists (select 1 from practice_members target_member
              where target_member.user_id = profiles.id
                and is_practice_manager(target_member.practice_id)));

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public, auth to app_user;
`;

// 0006's policy, verbatim — the pre-0093 repo state.
const POLICY_0006 = `
  create policy "${OLD_POLICY}" on profiles
    for select using (
      role = 'patient'
      and exists (
        select 1 from practice_members pm
        where pm.user_id = auth.uid() and pm.active = true));
`;

// Production's actual state: the two correlated policies, and no 0006.
const PRODUCTION_POLICIES = `
  create policy "${NEW_ADMIN_POLICY}" on profiles
    for select using (
      role = 'patient'
      and exists (select 1 from plans
                  where plans.patient_id = profiles.id
                    and is_practice_admin(plans.practice_id)));
  create policy "${NEW_PROVIDER_POLICY}" on profiles
    for select using (
      role = 'patient'
      and exists (select 1 from plans
                  where plans.patient_id = profiles.id
                    and plans.provider_id = auth.uid()));
`;

type Ids = {
  practiceA: string; practiceB: string;
  adminA: string; staffA: string; providerA: string; inactiveAdminA: string;
  adminB: string; providerB: string;
  patient1: string; patient2: string; patientNoPlan: string;
};

async function seed(db: PGlite): Promise<Ids> {
  const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);
  const profile = async (role: string, email: string) =>
    (await q<{ id: string }>(
      `insert into profiles (role, first_name, last_name, email, phone)
       values ($1,'T','U',$2,'+27820000000') returning id`, [role, email])).rows[0].id;
  const practice = async (name: string) =>
    (await q<{ id: string }>(`insert into practices (name) values ($1) returning id`, [name])).rows[0].id;
  const member = async (practiceId: string, userId: string, role: string, active = true) =>
    q(`insert into practice_members (practice_id, user_id, role, active, can_manage_practice)
       values ($1,$2,$3,$4,$5)`, [practiceId, userId, role, active, role === 'admin']);

  const practiceA = await practice('Practice A');
  const practiceB = await practice('Practice B');

  const adminA         = await profile('practice_admin', 'admin-a@x.test');
  const staffA         = await profile('practice_staff', 'staff-a@x.test');
  const providerA      = await profile('practice_staff', 'provider-a@x.test');
  const inactiveAdminA = await profile('practice_admin', 'ex-admin-a@x.test');
  const adminB         = await profile('practice_admin', 'admin-b@x.test');
  const providerB      = await profile('practice_staff', 'provider-b@x.test');

  await member(practiceA, adminA, 'admin');
  await member(practiceA, staffA, 'staff');
  await member(practiceA, providerA, 'provider');
  await member(practiceA, inactiveAdminA, 'admin', false);
  await member(practiceB, adminB, 'admin');
  await member(practiceB, providerB, 'provider');

  const patient1      = await profile('patient', 'patient1@x.test');
  const patient2      = await profile('patient', 'patient2@x.test');
  const patientNoPlan = await profile('patient', 'patient-noplan@x.test');

  // patient1 has a plan at practice A, assigned to providerA.
  await q(`insert into plans (patient_id, practice_id, provider_id) values ($1,$2,$3)`,
    [patient1, practiceA, providerA]);
  // patient2 has a plan at practice B, assigned to providerB.
  await q(`insert into plans (patient_id, practice_id, provider_id) values ($1,$2,$3)`,
    [patient2, practiceB, providerB]);
  // patientNoPlan has no plan anywhere.

  return { practiceA, practiceB, adminA, staffA, providerA, inactiveAdminA,
           adminB, providerB, patient1, patient2, patientNoPlan };
}

/** Act as `userId`, run the read as the RLS-bound app_user, restore role. */
async function readProfileAs(db: PGlite, userId: string, targetId: string) {
  await db.query('delete from _current_user');
  await db.query('insert into _current_user (id) values ($1)', [userId]);
  await db.exec('set role app_user');
  try {
    const { rows } = await db.query<{ id: string; email: string }>(
      `select id, email from profiles where id = $1`, [targetId]);
    return rows;
  } finally {
    await db.exec('reset role');
  }
}

async function profilePolicies(db: PGlite) {
  const { rows } = await db.query<{ policyname: string; cmd: string; qual: string }>(
    `select policyname, cmd, qual from pg_policies
     where tablename = 'profiles' order by policyname`);
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════
describe('BEFORE 0093 — 0006\'s uncorrelated policy leaks every patient profile', () => {
  let db: PGlite; let ids: Ids;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(POLICY_0006);
    ids = await seed(db);
  });

  it('an admin of an UNRELATED practice can read a patient with no plan there', async () => {
    const rows = await readProfileAs(db, ids.adminB, ids.patient1);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('patient1@x.test');
  });

  it('even non-admin STAFF at an unrelated practice can read that patient', async () => {
    const rows = await readProfileAs(db, ids.staffA, ids.patient2);
    expect(rows).toHaveLength(1);
  });

  it('a patient with NO plan at all is still readable by any member', async () => {
    const rows = await readProfileAs(db, ids.adminB, ids.patientNoPlan);
    expect(rows).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('AFTER 0093 — patient profile reads are correlated to the plan', () => {
  let db: PGlite; let ids: Ids;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(POLICY_0006);   // start from the repo's (broken) state
    ids = await seed(db);
    await db.exec(MIG_0093);      // then run the migration verbatim
  });

  it('drops 0006\'s policy and installs exactly the two replacements', async () => {
    const names = (await profilePolicies(db)).map((p) => p.policyname);
    expect(names).not.toContain(OLD_POLICY);
    expect(names).toContain(NEW_ADMIN_POLICY);
    expect(names).toContain(NEW_PROVIDER_POLICY);
  });

  // ── the case this whole investigation was about ──
  it('CROSS-TENANT DENIED: an admin of another practice cannot read the patient', async () => {
    const rows = await readProfileAs(db, ids.adminB, ids.patient1);
    expect(rows).toHaveLength(0);
  });

  it('CROSS-TENANT DENIED: a provider at another practice cannot read the patient', async () => {
    const rows = await readProfileAs(db, ids.providerB, ids.patient1);
    expect(rows).toHaveLength(0);
  });

  it('CROSS-TENANT DENIED: symmetric — practice A cannot read practice B\'s patient', async () => {
    const rows = await readProfileAs(db, ids.adminA, ids.patient2);
    expect(rows).toHaveLength(0);
  });

  it('a patient with no plan anywhere is readable by no practice user', async () => {
    for (const caller of [ids.adminA, ids.adminB, ids.providerA, ids.staffA]) {
      expect(await readProfileAs(db, caller, ids.patientNoPlan)).toHaveLength(0);
    }
  });

  // ── the reads that must still work ──
  it('ALLOWED: an admin of the patient\'s OWN plan\'s practice can read them', async () => {
    const rows = await readProfileAs(db, ids.adminA, ids.patient1);
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe('patient1@x.test');
  });

  it('ALLOWED: the provider ON the patient\'s plan can read them', async () => {
    const rows = await readProfileAs(db, ids.providerA, ids.patient1);
    expect(rows).toHaveLength(1);
  });

  it('the patient can still read their own profile (0002 untouched)', async () => {
    expect(await readProfileAs(db, ids.patient1, ids.patient1)).toHaveLength(1);
  });

  it('one patient still cannot read another patient', async () => {
    expect(await readProfileAs(db, ids.patient1, ids.patient2)).toHaveLength(0);
  });

  // ── adversarial edges ──
  it('is_practice_admin is ROLE-based: same-practice non-admin staff is denied', async () => {
    // staffA is an active member of practice A, where patient1 has a plan.
    // Under 0006 this read succeeded. It must not now.
    const rows = await readProfileAs(db, ids.staffA, ids.patient1);
    expect(rows).toHaveLength(0);
  });

  it('a DEACTIVATED admin of the right practice is denied', async () => {
    const rows = await readProfileAs(db, ids.inactiveAdminA, ids.patient1);
    expect(rows).toHaveLength(0);
  });

  it('the role = \'patient\' guard holds: these policies expose no STAFF profile', async () => {
    // adminB has no manage capability over practice A, so the untouched
    // 0035 staff policy does not apply either.
    expect(await readProfileAs(db, ids.adminB, ids.staffA)).toHaveLength(0);
  });

  it('a provider reassigned off the plan loses the read', async () => {
    await db.query(`update plans set provider_id = $1 where patient_id = $2`,
      [ids.providerB, ids.patient1]);
    expect(await readProfileAs(db, ids.providerA, ids.patient1)).toHaveLength(0);
    // ...and the new provider gains it, even though they are at practice B.
    expect(await readProfileAs(db, ids.providerB, ids.patient1)).toHaveLength(1);
    await db.query(`update plans set provider_id = $1 where patient_id = $2`,
      [ids.providerA, ids.patient1]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('0093 is a no-op against a database already in production\'s state', () => {
  let db: PGlite;
  let before: { policyname: string; cmd: string; qual: string }[];
  let after: { policyname: string; cmd: string; qual: string }[];

  beforeAll(async () => {
    db = new PGlite();
    await db.exec(BASE_SCHEMA);
    await db.exec(PRODUCTION_POLICIES);   // production's actual state
    await seed(db);
    before = await profilePolicies(db);
    await db.exec(MIG_0093);
    after = await profilePolicies(db);
  });

  it('the profiles policy set is byte-identical before and after', () => {
    expect(after).toEqual(before);
  });

  it('production\'s state never contained 0006\'s policy, before or after', () => {
    expect(before.map((p) => p.policyname)).not.toContain(OLD_POLICY);
    expect(after.map((p) => p.policyname)).not.toContain(OLD_POLICY);
  });

  it('the two policy predicates the migration writes match production\'s qual', () => {
    // Production's live pg_policies.qual, transcribed. If 0093's SQL text
    // ever drifts from what production actually has, this fails.
    const admin = after.find((p) => p.policyname === NEW_ADMIN_POLICY)!;
    const provider = after.find((p) => p.policyname === NEW_PROVIDER_POLICY)!;
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

    expect(norm(admin.qual)).toBe(norm(
      `((role = 'patient'::text) AND (EXISTS ( SELECT 1
         FROM plans
        WHERE ((plans.patient_id = profiles.id) AND is_practice_admin(plans.practice_id)))))`));
    expect(norm(provider.qual)).toBe(norm(
      `((role = 'patient'::text) AND (EXISTS ( SELECT 1
         FROM plans
        WHERE ((plans.patient_id = profiles.id) AND (plans.provider_id = auth.uid())))))`));
  });

  it('applying 0093 twice is still a no-op (idempotent)', async () => {
    await db.exec(MIG_0093);
    expect(await profilePolicies(db)).toEqual(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('0093 source pins', () => {
  // Comments are stripped before every absence assertion — the migration
  // header quotes 0006's broken policy in full, so a naive substring search
  // would match prose rather than SQL.
  const code = MIG_0093
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

  it('creates both replacements and creates nothing else', () => {
    const created = [...code.matchAll(/CREATE POLICY\s+"([^"]+)"/gi)].map((m) => m[1]);
    expect(created.sort()).toEqual([NEW_ADMIN_POLICY, NEW_PROVIDER_POLICY].sort());
  });

  it('drops 0006\'s policy and never re-creates it', () => {
    expect(code).toMatch(new RegExp(`DROP POLICY IF EXISTS\\s+"${OLD_POLICY}"`, 'i'));
    expect(code).not.toMatch(new RegExp(`CREATE POLICY\\s+"${OLD_POLICY}"`, 'i'));
  });

  it('every DROP is guarded with IF EXISTS', () => {
    const drops = [...code.matchAll(/DROP POLICY(\s+IF EXISTS)?/gi)];
    expect(drops.length).toBeGreaterThan(0);
    for (const d of drops) expect(d[1]).toBeTruthy();
  });

  it('touches only profiles — no other table, and no write-side policy', () => {
    const targets = [...code.matchAll(/(?:CREATE|DROP) POLICY[^;]*?\bON\s+(\w+)/gi)].map((m) => m[1]);
    expect(new Set(targets)).toEqual(new Set(['profiles']));
    expect(code).not.toMatch(/FOR\s+(INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('does not touch the staff-profile policy (explicitly out of scope)', () => {
    expect(code).not.toMatch(/practice_admin_select_member_profiles/i);
  });
});
