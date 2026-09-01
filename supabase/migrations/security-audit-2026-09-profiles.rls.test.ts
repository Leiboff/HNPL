// @vitest-environment node
//
// ─── Regression guards for the 2026-09 audit — profiles ─────────────────
//
// These began as adversarial proofs that the KYC gate could be forged with
// one PATCH. Migration 0122 replaced 0054/0065's deny-list with an
// ALLOW-LIST, so the assertions are inverted: they now pin the refusal.
//
// Structure worth keeping as-is:
//
//   F-04  the columns the OLD deny-list already covered, still covered.
//         These are the control — if the harness ever stopped enforcing
//         the trigger, they would fail too, and their passing is what
//         makes the F-05 block's failures meaningful rather than an
//         artefact of a broken fixture.
//
//   F-05  the columns the deny-list missed: every input to
//         lib/onboarding/state.ts::stepIsSatisfied, plus the
//         onboarding_completed short-circuit.
//
//   F-05b the allow-list itself — the writes that must KEEP working. A
//         lock that also blocks the passkey prompt and the provider's
//         phone field would be reverted within a day, so the exemptions
//         are pinned as tightly as the refusals.
//
//   F-05c the inversion property: a column added AFTER this migration is
//         locked by default. That is the whole reason for the rewrite —
//         0102-0105 added five identity columns and not one of them was
//         added to the deny-list.
//
// 0122 is executed VERBATIM from the file, on top of a 0065-shaped
// starting state, so the migration itself is what is under test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG_0122 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0122_profiles_column_allowlist.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const SCHEMA = `
  create role app_user nologin;

  create table profiles (
    id uuid primary key,
    role text,
    email text unique not null,
    first_name text, last_name text,
    phone text, phone_pending text,
    phone_verified_at     timestamptz,
    sa_id_number          text,
    sa_id_lookup_hash     text,
    salary_day            int,
    salary_amount         numeric(12,2) check (salary_amount is null or salary_amount > 0),
    credit_check_status   text,
    liveness_verified_at  timestamptz,
    identity_verification_status text,
    onboarding_completed  boolean not null default false,
    approved_credit_limit numeric(10,2),
    must_change_password  boolean default false,
    login_count           int not null default 0,
    passkey_prompt_next_show_at_login int not null default 1,
    passkey_prompt_permanent_dismiss  boolean not null default false,
    passkey_prompt_dismissed_at       timestamptz,
    passkey_prompt_dismissed_count    int default 0
  );

  create table _ctx (role text, uid uuid);
  insert into _ctx values ('authenticated', null);
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;

  -- 0121 extracted this shared predicate; 0122 depends on it.
  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$
      select auth.role() = 'service_role'
          or current_setting('app.privileged_write', true) = 'on'
    $$;

  alter table profiles enable row level security;
  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());
  create policy "users_update_own_profile" on profiles
    for update using (id = auth.uid()) with check (id = auth.uid());

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public to app_user;
  grant execute on all functions in schema auth to app_user;
`;

const PATIENT = '11111111-1111-1111-1111-111111111111';

let db: PGlite;

type Attempt = { ok: true } | { ok: false; error: string };

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

async function reset() {
  await db.exec('reset role;');
  await db.exec("update _ctx set role = 'service_role';");
  await db.exec('delete from profiles;');
  // A brand-new patient: nothing verified, nothing approved, nothing done.
  await db.query(
    `insert into profiles (id, role, email, onboarding_completed) values ($1,'patient','p@x.test',false)`,
    [PATIENT],
  );
  await db.exec("update _ctx set role = 'authenticated';");
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0122);   // the fix under test, verbatim
});

afterAll(async () => { await db?.close(); });

describe('AUDIT F-04 — the columns the old deny-list covered are still covered', () => {
  beforeAll(reset);

  it('refuses a self-service role escalation', async () => {
    const r = await asPatient(`update profiles set role = 'admin' where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not user-editable/);
  });

  it('refuses a self-asserted phone_verified_at', async () => {
    const r = await asPatient(`update profiles set phone_verified_at = now() where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
  });

  it('refuses a self-granted credit limit', async () => {
    const r = await asPatient(`update profiles set approved_credit_limit = 500000 where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
  });

  it('refuses an email change outside the auth ceremony', async () => {
    const r = await asPatient(`update profiles set email = 'other@x.test' where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
  });
});

describe('AUDIT F-05 — the KYC / affordability gate is no longer self-writable', () => {
  beforeAll(reset);

  it('refuses onboarding_completed — the computeOnboarding short-circuit', async () => {
    const r = await asPatient(`update profiles set onboarding_completed = true where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/onboarding_completed/);

    await db.exec('reset role;');
    const { rows } = await db.query<{ onboarding_completed: boolean }>(
      `select onboarding_completed from profiles where id = '${PATIENT}'`,
    );
    expect(rows[0].onboarding_completed).toBe(false);
  });

  it('refuses the whole forged identity + affordability record', async () => {
    await reset();
    const r = await asPatient(`
      update profiles set
        sa_id_number                 = 'v1:forged',
        sa_id_lookup_hash            = 'deadbeef',
        liveness_verified_at         = now(),
        identity_verification_status = 'approved',
        salary_day                   = 25,
        salary_amount                = 90000,
        credit_check_status          = 'passed'
      where id = '${PATIENT}'
    `);
    expect(r.ok).toBe(false);

    await db.exec('reset role;');
    const { rows } = await db.query<{
      sa_id_number: string | null; liveness_verified_at: string | null;
      credit_check_status: string | null; salary_amount: string | null;
    }>(`select sa_id_number, liveness_verified_at, credit_check_status, salary_amount
        from profiles where id = '${PATIENT}'`);
    expect(rows[0].sa_id_number).toBeNull();
    expect(rows[0].liveness_verified_at).toBeNull();
    expect(rows[0].credit_check_status).toBeNull();
    expect(rows[0].salary_amount).toBeNull();
  });

  it('refuses each gate column on its own, not only as a batch', async () => {
    // A single-column PATCH is the realistic request shape, and a
    // whole-row assertion could pass while one column stayed writable.
    for (const col of [
      "sa_id_number = 'v1:x'",
      "sa_id_lookup_hash = 'abc'",
      'liveness_verified_at = now()',
      "identity_verification_status = 'approved'",
      "credit_check_status = 'passed'",
      'salary_amount = 90000',
      'salary_day = 25',
      'onboarding_completed = true',
    ]) {
      await reset();
      const r = await asPatient(`update profiles set ${col} where id = '${PATIENT}'`);
      expect(r.ok, `expected refusal for: ${col}`).toBe(false);
    }
  });

  it('names the offending column so a legitimate new one can be allow-listed', async () => {
    await reset();
    const r = await asPatient(`update profiles set credit_check_status = 'passed' where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/credit_check_status/);
  });
});

describe('AUDIT F-05b — the allow-list still lets real patient edits through', () => {
  beforeAll(reset);

  it('allows the passkey-prompt counters the layout writes on every login', async () => {
    const r = await asPatient(`
      update profiles set
        login_count = 3,
        passkey_prompt_next_show_at_login = 6,
        passkey_prompt_permanent_dismiss  = true,
        passkey_prompt_dismissed_at       = now()
      where id = '${PATIENT}'
    `);
    expect(r.ok).toBe(true);
  });

  it('allows the provider phone field and the setup password flag', async () => {
    await reset();
    const r = await asPatient(
      `update profiles set phone = '+27821234567', must_change_password = false where id = '${PATIENT}'`,
    );
    expect(r.ok).toBe(true);
  });

  it('allows a name correction', async () => {
    await reset();
    const r = await asPatient(`update profiles set first_name = 'Thandi', last_name = 'Mokoena' where id = '${PATIENT}'`);
    expect(r.ok).toBe(true);
  });

  it('lets the privileged writer set everything — the webhook and onboarding path', async () => {
    // Without this the lock would be a lock on the Didit webhook too, and
    // no patient could ever finish onboarding.
    await reset();
    await db.exec("update _ctx set role = 'service_role';");
    await db.exec('set role app_user;');
    await db.query(`
      update profiles set
        sa_id_number         = 'v1:real',
        liveness_verified_at = now(),
        credit_check_status  = 'passed',
        onboarding_completed = true,
        approved_credit_limit = 5000
      where id = '${PATIENT}'
    `);
    await db.exec('reset role;');
    await db.exec("update _ctx set role = 'authenticated';");
    const { rows } = await db.query<{ onboarding_completed: boolean }>(
      `select onboarding_completed from profiles where id = '${PATIENT}'`,
    );
    expect(rows[0].onboarding_completed).toBe(true);
  });

  it('lets a SECURITY DEFINER RPC opt in via app.privileged_write', async () => {
    await reset();
    await db.exec('set role app_user;');
    try {
      await db.query("select set_config('app.privileged_write', 'on', false)");
      await db.query(`update profiles set credit_check_status = 'passed' where id = '${PATIENT}'`);
    } finally {
      await db.query("select set_config('app.privileged_write', 'off', false)");
      await db.exec('reset role;');
    }
    const { rows } = await db.query<{ credit_check_status: string }>(
      `select credit_check_status from profiles where id = '${PATIENT}'`,
    );
    expect(rows[0].credit_check_status).toBe('passed');
  });
});

describe('AUDIT F-05c — a column added later is locked by default', () => {
  // The point of the whole inversion. Under the old deny-list a new
  // column was writable until someone remembered to add it; under the
  // allow-list it is locked until someone deliberately opens it.
  beforeAll(async () => {
    await reset();
    await db.exec('alter table profiles add column if not exists some_future_risk_flag boolean default false;');
  });

  afterAll(async () => {
    await db.exec('reset role;');
    await db.exec('alter table profiles drop column if exists some_future_risk_flag;');
  });

  it('refuses a column the lock has never heard of', async () => {
    const r = await asPatient(`update profiles set some_future_risk_flag = true where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/some_future_risk_flag/);
  });
});

describe('AUDIT F-05d — salary_amount has a ceiling', () => {
  beforeAll(reset);

  it('refuses an absurd declared income even on the privileged path', async () => {
    // The CHECK binds the service-role writer too, which the trigger
    // deliberately does not — saveSalaryAmount now writes privileged, so
    // without this its validator would be the only bound.
    await db.exec("update _ctx set role = 'service_role';");
    await db.exec('set role app_user;');
    let refused = false;
    try {
      await db.query(`update profiles set salary_amount = 999999999 where id = '${PATIENT}'`);
    } catch {
      refused = true;
    } finally {
      await db.exec('reset role;');
      await db.exec("update _ctx set role = 'authenticated';");
    }
    expect(refused).toBe(true);
  });
});
