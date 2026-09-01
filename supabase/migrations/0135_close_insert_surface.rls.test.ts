// @vitest-environment node
//
// ─── 0135 closes the two INSERT holes, and breaks nothing ─────────────────
//
// The inverted form of security-audit-r3-payouts-practices.rls.test.ts.
// That file demonstrates the exploits; this one runs the SAME setup, applies
// 0135 verbatim, and asserts every one of them now fails.
//
// Half of this suite is about what must KEEP working, because that is where
// a lock like this actually goes wrong. Three paths are load-bearing:
//
//   • service_role INSERTs the payout (activateFirstInstalment.ts:207)
//   • a platform admin flips status pending→paid on the SESSION client
//     (app/admin/payouts/actions.ts:79 and :131) — not service_role, so a
//     blanket refusal on payouts would have taken settlement down, and
//     0131's audit row would have lost its actor_id
//   • service_role INSERTs a practice (signup/practice/actions.ts:282 and
//     brand/actions.ts:142) and approvePractice UPDATEs it (svc())
//
// Runs as a real non-superuser role. pglite's default role bypasses RLS.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0135_close_insert_surface_payouts_practices.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const PATIENT  = '0000aaaa-0000-0000-0000-00000000aaaa';
const OUTSIDER = '0000bbbb-0000-0000-0000-00000000bbbb';
const ADMIN    = '0000ad00-0000-0000-0000-00000000ad00';
const GROUP    = '0000c000-0000-0000-0000-00000000c000';
const PRACTICE = '0000dddd-0000-0000-0000-00000000dddd';
const PLAN     = '0000eeee-0000-0000-0000-00000000eeee';
const PLAN2    = '0000eee2-0000-0000-0000-00000000eee2';

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

  create table profiles (id uuid primary key, role text);
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
      check (status = any (array['pending','approved','suspended','inactive']))
  );

  create table practice_members (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid, user_id uuid, role text,
    active boolean default true,
    can_create_bills boolean default false,
    can_manage_practice boolean not null default false,
    constraint practice_members_role_check
      check (role = any (array['admin','staff','provider']))
  );

  create table plans (
    id uuid primary key, patient_id uuid, practice_id uuid,
    total_amount numeric, status text
  );

  create table payouts (
    id uuid primary key default gen_random_uuid(),
    practice_id uuid, plan_id uuid,
    gross_amount numeric not null,
    fee_amount numeric not null,
    net_amount numeric not null,
    status text default 'pending',
    paid_at timestamptz,
    created_at timestamptz default now(),
    provider_id uuid,
    payout_destination text default 'practice',
    snapshot_bank_name text, snapshot_account_holder text,
    snapshot_account_number text, snapshot_branch_code text,
    snapshot_account_type text,
    batch_id uuid,
    constraint payouts_plan_id_unique unique (plan_id),
    constraint payouts_status_check
      check (status = any (array['pending','processing','paid','failed']))
  );

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;

  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
    $$;
  create or replace function is_practice_member(p uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from practice_members
                      where practice_id = p and user_id = auth.uid() and active = true);
    $$;
  create or replace function is_practice_manager(p uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from practice_members
                      where practice_id = p and user_id = auth.uid()
                        and active = true and can_manage_practice = true);
    $$;
  create or replace function practice_can_trade(p uuid) returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from practices where id = p and status = 'approved')
         and exists (select 1 from practice_members
                      where practice_id = p and active = true and role = 'provider');
    $$;
  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$
      select coalesce(auth.role() = 'service_role', false)
          or coalesce(current_setting('app.privileged_write', true) = 'on', false);
    $$;

  -- The PRE-0135 trigger, exactly as 0054 left it: UPDATE only.
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
    end; $$;
  drop trigger if exists trg_protect_practices_columns on practices;
  create trigger trg_protect_practices_columns
    before update on practices for each row
    execute function protect_practices_columns();

  alter table profiles         enable row level security;
  alter table practices        enable row level security;
  alter table practice_members enable row level security;
  alter table plans            enable row level security;
  alter table payouts          enable row level security;

  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());
  create policy "admins_select_all_profiles" on profiles
    for select using (is_platform_admin());

  create policy "authenticated_insert_practice" on practices
    for insert with check ((auth.uid() is not null) and (owner_id = auth.uid()));
  create policy "owners_select_own_practice" on practices
    for select using (owner_id = auth.uid());
  create policy "patients_select_practice_for_own_plans" on practices
    for select using (exists (
      select 1 from plans where plans.practice_id = practices.id
                            and plans.patient_id = auth.uid()));
  create policy "admins_select_all_practices" on practices
    for select using (is_platform_admin());
  create policy "practice_admins_update_own_practice" on practices
    for update using (is_practice_manager(id));

  create policy "owners_insert_own_membership" on practice_members
    for insert with check (exists (
      select 1 from practices where practices.id = practice_members.practice_id
                                and practices.owner_id = auth.uid()));
  create policy "members_select_own_membership" on practice_members
    for select using (user_id = auth.uid());

  create policy "patients_select_own_plans" on plans
    for select using (patient_id = auth.uid());
  create policy "practice_members_insert_plans" on plans
    for insert with check (is_practice_member(practice_id) and practice_can_trade(practice_id));

  create policy "patients_insert_payout_on_accept" on payouts
    for insert with check (exists (
      select 1 from plans where plans.id = payouts.plan_id
                            and plans.patient_id = auth.uid()));
  create policy "admins_all_payouts" on payouts
    for all using (is_platform_admin());
  create policy "provider_select_own_payouts" on payouts
    for select using (provider_id = auth.uid());
`;

const SEED = `
  insert into profiles (id, role) values
    ('${PATIENT}', 'patient'), ('${OUTSIDER}', 'patient'), ('${ADMIN}', 'admin');
  insert into practice_groups (id, name) values ('${GROUP}', 'Real Group');
  insert into practices (id, owner_id, name, specialty, email, group_id, status)
  values ('${PRACTICE}', null, 'Real Practice', 'Dentist', 'real@x.co', '${GROUP}', 'approved');
  insert into plans (id, patient_id, practice_id, total_amount, status) values
    ('${PLAN}',  '${PATIENT}', '${PRACTICE}', 10000, 'pending_first_payment'),
    ('${PLAN2}', '${PATIENT}', '${PRACTICE}',  5000, 'pending_first_payment');
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

/** service_role — what every server-side write in the app actually holds. */
async function asService<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = null, role = 'service_role';`);
  await db.exec('set role service_role;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
    await db.exec(`update _ctx set role = 'authenticated';`);
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);          // 0135, verbatim
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────
// R3-01 — closed
// ─────────────────────────────────────────────────────────────────────────

describe('0135 / R3-01 — payouts is no longer patient-writable', () => {
  it('the patient INSERT policy is gone', async () => {
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies
        where tablename = 'payouts' and policyname = 'patients_insert_payout_on_accept';`);
    expect(rows.rows[0].n).toBe(0);
  });

  it('a patient can no longer forge the payout row for their own plan', async () => {
    // Two independent refusals now stand in front of this, and on INSERT the
    // BEFORE ROW trigger runs before the RLS WITH CHECK is evaluated — so the
    // trigger's message is the one that surfaces, even though the policy is
    // also gone. Either refusal is a pass; both being present is the point.
    await expect(as(PATIENT, `
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount, net_amount)
      values ('${PLAN}', '${PRACTICE}', 10000, 9999.99, 0.01);
    `)).rejects.toThrow(/row-level security|forged settlement instruction/i);
  });

  it('the trigger refuses the insert even if a policy were restored', async () => {
    await db.exec(`
      create policy "tmp_patient_insert" on payouts for insert
        with check (exists (select 1 from plans
                             where plans.id = payouts.plan_id
                               and plans.patient_id = auth.uid()));
    `);
    await expect(as(PATIENT, `
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount, net_amount)
      values ('${PLAN}', '${PRACTICE}', 10000, 9999.99, 0.01);
    `)).rejects.toThrow(/forged settlement instruction|audit R3-01/i);
    await db.exec(`drop policy "tmp_patient_insert" on payouts;`);
  });

  it('service_role — activateFirstInstalment — still creates the payout', async () => {
    await asService(`
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount,
                           net_amount, status, payout_destination)
      values ('${PLAN}', '${PRACTICE}', 10000, 600, 9400, 'pending', 'practice')
      on conflict (plan_id) do nothing;
    `);
    const row = (await db.query<{ net_amount: string }>(
      `select net_amount from payouts where plan_id = '${PLAN}';`)).rows[0];
    expect(Number(row.net_amount)).toBe(9400);
  });

  it('a platform admin can still settle it on the SESSION client', async () => {
    await as(ADMIN, `
      update payouts set status = 'paid', paid_at = now()
       where plan_id = '${PLAN}' and status = 'pending';
    `);
    const row = (await db.query<{ status: string }>(
      `select status from payouts where plan_id = '${PLAN}';`)).rows[0];
    expect(row.status).toBe('paid');
  });

  it('but an admin cannot move the money while settling it', async () => {
    await asService(`
      insert into payouts (plan_id, practice_id, gross_amount, fee_amount, net_amount)
      values ('${PLAN2}', '${PRACTICE}', 5000, 300, 4700);
    `);
    await expect(as(ADMIN, `
      update payouts set status = 'paid', paid_at = now(), net_amount = 1
       where plan_id = '${PLAN2}';
    `)).rejects.toThrow(/only status and paid_at/i);
  });

  it('and cannot redirect the banking snapshot', async () => {
    await expect(as(ADMIN, `
      update payouts set snapshot_account_number = '1234567890'
       where plan_id = '${PLAN2}';
    `)).rejects.toThrow(/only status and paid_at/i);
  });

  it('a non-admin cannot update a payout at all', async () => {
    // RLS filters the row out before the trigger is reached, and an UPDATE
    // matching no rows is a silent no-op in PostgreSQL rather than an error.
    // So the property to assert is that nothing moved, not that it threw.
    await as(PATIENT, `update payouts set status = 'paid' where plan_id = '${PLAN2}';`);
    const row = (await db.query<{ status: string }>(
      `select status from payouts where plan_id = '${PLAN2}';`)).rows[0];
    expect(row.status).toBe('pending');
  });

  it('nobody but a privileged caller may delete a payout', async () => {
    await expect(as(ADMIN, `
      delete from payouts where plan_id = '${PLAN2}';
    `)).rejects.toThrow(/never deleted/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// R3-02 — closed
// ─────────────────────────────────────────────────────────────────────────

describe('0135 / R3-02 — practices cannot be self-approved at INSERT', () => {
  it('the open INSERT policy is gone', async () => {
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies
        where tablename = 'practices' and policyname = 'authenticated_insert_practice';`);
    expect(rows.rows[0].n).toBe(0);
  });

  it('the trigger now fires on INSERT as well as UPDATE', async () => {
    const rows = await db.query<{ tgtype: number }>(
      `select tgtype from pg_trigger
        where tgname = 'trg_protect_practices_columns' and not tgisinternal;`);
    // bit 2 = INSERT, bit 4 = UPDATE (pg_trigger.tgtype)
    expect(rows.rows[0].tgtype & 4).toBe(4);
    expect(rows.rows[0].tgtype & 16).toBe(16);
  });

  it('a self-approved practice is refused even with a policy restored', async () => {
    await db.exec(`
      create policy "tmp_auth_insert" on practices for insert
        with check ((auth.uid() is not null) and (owner_id = auth.uid()));
    `);
    await expect(as(PATIENT, `
      insert into practices (owner_id, name, specialty, email, group_id, status)
      values ('${PATIENT}', 'Evil', 'Dentist', 'e@x.co', '${GROUP}', 'approved');
    `)).rejects.toThrow(/starts at pending|audit R3-02/i);
  });

  it('a zero-fee practice is refused', async () => {
    await expect(as(PATIENT, `
      insert into practices (owner_id, name, specialty, email, group_id, fee_percent)
      values ('${PATIENT}', 'Evil', 'Dentist', 'e@x.co', '${GROUP}', 0);
    `)).rejects.toThrow(/platform margin/i);
  });

  it('a pre-stamped approved_at is refused', async () => {
    await expect(as(PATIENT, `
      insert into practices (owner_id, name, specialty, email, group_id, approved_at)
      values ('${PATIENT}', 'Evil', 'Dentist', 'e@x.co', '${GROUP}', now());
    `)).rejects.toThrow(/approved_at \/ approved_by/i);
  });

  it('a plain pending practice is still allowed through the trigger', async () => {
    await as(PATIENT, `
      insert into practices (id, owner_id, name, specialty, email, group_id)
      values ('0000f00f-0000-0000-0000-00000000f00f', '${PATIENT}',
              'Honest Dental', 'Dentist', 'h@x.co', '${GROUP}');
    `);
    const row = (await db.query<{ status: string; fee_percent: string }>(
      `select status, fee_percent from practices
        where id = '0000f00f-0000-0000-0000-00000000f00f';`)).rows[0];
    expect(row.status).toBe('pending');
    expect(Number(row.fee_percent)).toBe(6);
    await db.exec(`drop policy "tmp_auth_insert" on practices;`);
  });

  it('a pending practice cannot trade, even with a self-granted provider row', async () => {
    await as(PATIENT, `
      insert into practice_members (practice_id, user_id, role, active,
                                    can_create_bills, can_manage_practice)
      values ('0000f00f-0000-0000-0000-00000000f00f', '${PATIENT}',
              'provider', true, true, true);
    `);
    const rows = await as<{ can: boolean }>(PATIENT,
      `select practice_can_trade('0000f00f-0000-0000-0000-00000000f00f') as can;`);
    expect(rows[0].can).toBe(false);
  });

  it('and it cannot raise a bill', async () => {
    await expect(as(PATIENT, `
      insert into plans (id, patient_id, practice_id, total_amount, status)
      values ('0000ffff-0000-0000-0000-00000000ffff', '${OUTSIDER}',
              '0000f00f-0000-0000-0000-00000000f00f', 49999, 'pending_acceptance');
    `)).rejects.toThrow(/row-level security/i);
  });

  it('service_role — practice signup and brand branch creation — still works', async () => {
    await asService(`
      insert into practices (id, owner_id, name, specialty, email, group_id, status)
      values ('0000abcd-0000-0000-0000-00000000abcd', '${OUTSIDER}',
              'Signup Practice', 'Dentist', 's@x.co', '${GROUP}', 'pending');
    `);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from practices
        where id = '0000abcd-0000-0000-0000-00000000abcd';`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('service_role — approvePractice — still approves', async () => {
    await asService(`
      update practices set status = 'approved', approved_at = now(), approved_by = '${ADMIN}'
       where id = '0000abcd-0000-0000-0000-00000000abcd';
    `);
    const row = (await db.query<{ status: string }>(
      `select status from practices where id = '0000abcd-0000-0000-0000-00000000abcd';`)).rows[0];
    expect(row.status).toBe('approved');
  });

  it('the 0054 UPDATE branch is unchanged — an owner still cannot self-approve', async () => {
    await expect(as(PATIENT, `
      update practices set status = 'approved'
       where id = '0000f00f-0000-0000-0000-00000000f00f';
    `)).rejects.toThrow(/status is set only by an admin action|row-level security/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The literal the migration has to keep in step with the schema
// ─────────────────────────────────────────────────────────────────────────

describe('0135 — the fee_percent literal tracks the column default', () => {
  it('practices.fee_percent still defaults to the value the trigger pins', async () => {
    const row = (await db.query<{ column_default: string }>(
      `select column_default from information_schema.columns
        where table_name = 'practices' and column_name = 'fee_percent';`)).rows[0];
    // If this default ever changes, c_default_fee in
    // 0135_close_insert_surface_payouts_practices.sql must change with it,
    // or every practice signup starts failing.
    expect(Number(String(row.column_default).replace(/[^0-9.]/g, ''))).toBe(6);
  });
});
