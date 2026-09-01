// @vitest-environment node
//
// ─── Regression guards for the 2026-09 audit — plans / payments ─────────
//
// These began as adversarial proofs that asserted the exploits SUCCEEDED.
// Migration 0121 closed them, so the assertions are inverted: each one now
// pins the refusal. If any of these starts passing an exploit again,
// somebody has re-added a column-unrestricted policy — which is exactly
// the mistake migration 0007 made and this file exists to catch.
//
// Every statement runs as `app_user`, a NON-superuser role, because
// pglite's default role bypasses RLS unconditionally and would make an RLS
// suite pass identically with the policies removed.
//
// The schema below installs 0007's and 0011's policies FIRST and then
// applies 0121 verbatim from the file — so the test exercises the actual
// migration doing the actual removal, not a hand-written approximation of
// its end state.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG_0121 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0121_lock_plans_and_payments.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// Pre-0121 state: the tables, and the three policies the migration drops.
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
    completed_at timestamptz,
    terms_accepted_at timestamptz
  );
  create table payments (
    id uuid primary key,
    plan_id uuid references plans(id),
    patient_id uuid references profiles(id),
    instalment_number integer not null,
    amount numeric(10,2) not null,
    due_date date not null,
    status text default 'scheduled',
    kind text not null default 'instalment',
    collected_at timestamptz
  );

  create table _ctx (role text, uid uuid);
  insert into _ctx values ('authenticated', null);
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;

  alter table plans    enable row level security;
  alter table payments enable row level security;

  -- 0002 — reads, untouched by 0121.
  create policy "patients_select_own_plans" on plans
    for select using (patient_id = auth.uid());
  create policy "patients_select_own_payments" on payments
    for select using (patient_id = auth.uid());

  -- 0007 + 0011 — the three write policies 0121 removes.
  create policy "patients_update_own_plans" on plans
    for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());
  create policy "patients_update_own_payments" on payments
    for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());
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
const PRACTICE = '33333333-3333-3333-3333-333333333333';
const PLAN     = '44444444-4444-4444-4444-444444444444';
const PAY1     = '55555555-5555-5555-5555-555555555551';
const PAY2     = '55555555-5555-5555-5555-555555555552';

let db: PGlite;

type Attempt = { ok: true } | { ok: false; error: string };

/** Run a statement as the RLS-bound, non-privileged `app_user`. */
async function asPatient(sql: string): Promise<Attempt> {
  await db.exec(`update _ctx set uid = '${PATIENT}', role = 'authenticated';`);
  await db.exec('set role app_user;');
  try {
    await db.query(sql);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await db.exec('reset role;');
  }
}

/**
 * Fixtures are PRIVILEGED writes — `_ctx.role = 'service_role'` — because
 * that is what they are in production: every plan and payment row is
 * written by a server action, a webhook or a cron holding the service-role
 * client. Seeding as `authenticated` would trip the very triggers under
 * test and is what a first run of this file did.
 *
 * Restored to 'authenticated' on the way out so each test starts as an
 * ordinary patient session unless it says otherwise.
 */
async function asPrivileged<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("update _ctx set role = 'service_role';");
  try {
    return await fn();
  } finally {
    await db.exec("update _ctx set role = 'authenticated';");
  }
}

async function seed() {
  await db.exec('reset role;');
  await asPrivileged(async () => {
    await db.exec('delete from payments; delete from plans; delete from practices; delete from profiles;');
    await db.query('insert into profiles (id, role, email) values ($1,$2,$3)', [PATIENT, 'patient', 'p@x.test']);
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
  });
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0121);   // the fix under test, verbatim
  await seed();
});

afterAll(async () => { await db?.close(); });

describe('AUDIT F-01 — a patient can no longer rewrite their own plan', () => {
  beforeAll(seed);

  it('drops the three column-unrestricted write policies', async () => {
    await db.exec('reset role;');
    const { rows } = await db.query<{ policyname: string }>(
      `select policyname from pg_policies
        where tablename in ('plans','payments')
          and cmd in ('UPDATE','INSERT')
        order by policyname`,
    );
    expect(rows.map(r => r.policyname)).toEqual([]);
  });

  it('refuses to mark a live plan completed — the debt-erasure exploit', async () => {
    // With the policy gone there is no UPDATE path at all, so the
    // statement matches zero rows rather than raising. Both outcomes are
    // "refused"; what matters is the row is unchanged.
    await asPatient(`update plans set status = 'completed', completed_at = now() where id = '${PLAN}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ status: string }>(`select status from plans where id = '${PLAN}'`);
    expect(rows[0].status).toBe('active');
  });

  it('refuses to rewrite total_amount — the payout-inflation input', async () => {
    await seed();
    await asPatient(`update plans set total_amount = 0.01, instalment_amount = 0.01 where id = '${PLAN}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ total_amount: string }>(`select total_amount from plans where id = '${PLAN}'`);
    expect(Number(rows[0].total_amount)).toBe(10000);
  });

  it('still refuses another patient\'s plan (0007 always did enforce this much)', async () => {
    await seed();
    await db.exec(`update _ctx set uid = '22222222-2222-2222-2222-222222222222';`);
    await db.exec('set role app_user;');
    try { await db.query(`update plans set status = 'completed' where id = '${PLAN}'`); } catch { /* refused */ }
    await db.exec('reset role;');
    const { rows } = await db.query<{ status: string }>(`select status from plans where id = '${PLAN}'`);
    expect(rows[0].status).toBe('active');
  });
});

describe('AUDIT F-02 — a patient can no longer write the payments ledger', () => {
  beforeAll(seed);

  it('refuses to mark outstanding instalments collected', async () => {
    await asPatient(
      `update payments set status = 'collected', collected_at = now() where patient_id = '${PATIENT}'`,
    );
    await db.exec('reset role;');
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from payments where plan_id = '${PLAN}' and status <> 'collected'`,
    );
    // Instalment 2 is still outstanding.
    expect(Number(rows[0].n)).toBe(1);
  });

  it('refuses to zero the amount of a scheduled instalment before it is charged', async () => {
    await seed();
    await asPatient(`update payments set amount = 0 where id = '${PAY2}'`);
    await db.exec('reset role;');
    const { rows } = await db.query<{ amount: string }>(`select amount from payments where id = '${PAY2}'`);
    // This is the input initializeFirstPayment reads to decide what to charge.
    expect(Number(rows[0].amount)).toBe(5000);
  });

  it('refuses to insert a payment row', async () => {
    await seed();
    const r = await asPatient(
      `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
       values ('66666666-6666-6666-6666-666666666666','${PLAN}','${PATIENT}',3,0.01,'2026-11-01','collected')`,
    );
    expect(r.ok).toBe(false);
    await db.exec('reset role;');
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from payments where plan_id = '${PLAN}'`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('AUDIT F-01/F-02 — the triggers hold even if a policy comes back', () => {
  // The policies are gone, so the triggers are unreachable from a patient
  // session TODAY. That is precisely why they are worth testing: they are
  // the layer that catches the re-introduction of 0007's mistake, and a
  // defence nobody exercises is a defence nobody knows is broken.
  beforeAll(async () => {
    await seed();
    await db.exec(`
      create policy "regression_patients_update_plans" on plans
        for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());
      create policy "regression_patients_update_payments" on payments
        for update using (patient_id = auth.uid()) with check (patient_id = auth.uid());
    `);
  });

  afterAll(async () => {
    await db.exec('reset role;');
    await db.exec(`
      drop policy if exists "regression_patients_update_plans" on plans;
      drop policy if exists "regression_patients_update_payments" on payments;
    `);
  });

  it('protect_plans_write refuses the re-opened UPDATE', async () => {
    const r = await asPatient(`update plans set status = 'completed' where id = '${PLAN}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not writable from a user session/);
  });

  it('protect_payments_write refuses the re-opened UPDATE', async () => {
    const r = await asPatient(`update payments set status = 'collected' where id = '${PAY2}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not writable from a user session/);
  });

  it('lets the privileged writer through — the server actions still work', async () => {
    // service_role is the bypass every acceptPlan / webhook / cron write
    // now runs under. Without this the lock would be a lock on everything.
    await db.exec(`update _ctx set role = 'service_role', uid = '${PATIENT}';`);
    await db.exec('set role app_user;');
    await db.query(`update plans set status = 'completed' where id = '${PLAN}'`);
    await db.exec('reset role;');
    await db.exec(`update _ctx set role = 'authenticated';`);
    const { rows } = await db.query<{ status: string }>(`select status from plans where id = '${PLAN}'`);
    expect(rows[0].status).toBe('completed');
  });
});

describe('AUDIT F-03 — payments now has UNIQUE (plan_id, instalment_number)', () => {
  beforeAll(seed);

  it('rejects a duplicate instalment row for the same plan', async () => {
    // This is what makes the acceptPlan / payWithSavedCard check-then-write
    // race a constraint violation instead of a duplicated schedule. Written
    // as a PRIVILEGED insert on purpose: the race happens inside the server
    // actions, which hold the service-role client, so a test that only
    // proved the patient cannot insert would prove nothing about it.
    await db.exec('reset role;');
    await asPrivileged(async () => {
      await expect(db.query(
        `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status)
         values ('66666666-6666-6666-6666-666666666666','${PLAN}','${PATIENT}',1,5000.00,'2026-09-01','processing')`,
      )).rejects.toThrow(/payments_plan_instalment_uniq|duplicate key/i);
    });
  });

  it('still allows a settlement row alongside the instalment it covers', async () => {
    // The index is partial on kind='instalment' because settlement rows
    // (0058) share the table and duplicate instalment_number by design.
    await db.exec('reset role;');
    await asPrivileged(() => db.query(
      `insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
       values ('77777777-7777-7777-7777-777777777777','${PLAN}','${PATIENT}',1,5000.00,'2026-09-01','processing','settlement')`,
    ));
    const { rows } = await db.query<{ n: string }>(
      `select count(*)::text as n from payments where plan_id = '${PLAN}' and instalment_number = 1`,
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('AUDIT F-01 — plans INSERT/DELETE from a practice session stay bounded', () => {
  // createBill raises a bill and rolls its own insert back; nothing else
  // legitimately inserts or deletes a plan from a user session. The trigger
  // pins both to that shape so a practice cannot manufacture a debt that
  // is already accepted, or delete a customer's live agreement.
  beforeAll(async () => {
    await seed();
    await db.exec(`
      create policy "regression_practice_insert_plans" on plans for insert with check (true);
      create policy "regression_practice_delete_plans" on plans for delete using (true);
    `);
  });

  afterAll(async () => {
    await db.exec('reset role;');
    await db.exec(`
      drop policy if exists "regression_practice_insert_plans" on plans;
      drop policy if exists "regression_practice_delete_plans" on plans;
    `);
  });

  it('allows a bill raised at pending_acceptance', async () => {
    const r = await asPatient(
      `insert into plans (id, patient_id, practice_id, total_amount, status)
       values ('88888888-8888-8888-8888-888888888888','${PATIENT}','${PRACTICE}',500,'pending_acceptance')`,
    );
    expect(r.ok).toBe(true);
  });

  it('refuses a plan inserted already active', async () => {
    const r = await asPatient(
      `insert into plans (id, patient_id, practice_id, total_amount, status)
       values ('99999999-9999-9999-9999-999999999999','${PATIENT}','${PRACTICE}',500,'active')`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/must start at pending_acceptance/);
  });

  it('refuses a plan inserted with the acceptance already stamped', async () => {
    const r = await asPatient(
      `insert into plans (id, patient_id, practice_id, total_amount, status, terms_accepted_at)
       values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','${PATIENT}','${PRACTICE}',500,'pending_acceptance', now())`,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cannot be pre-set/);
  });

  it('refuses deleting a plan past acceptance, but allows the rollback case', async () => {
    const live = await asPatient(`delete from plans where id = '${PLAN}'`);
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.error).toMatch(/only a plan still at pending_acceptance/);

    const pending = await asPatient(`delete from plans where id = '88888888-8888-8888-8888-888888888888'`);
    expect(pending.ok).toBe(true);
  });
});
