// @vitest-environment node
//
// ─── SECURITY AUDIT PROOF-OF-CONCEPT — 2026-09 — profiles column lock ─────
//
// ADVERSARIAL. Demonstrates that migration 0054/0065's protect_profiles_
// columns() trigger locks FOUR columns (role, email, phone_verified_at,
// approved_credit_limit) but leaves every column the onboarding /
// KYC gate actually reads writable by the row's owner.
//
// Both halves are here on purpose:
//   • the columns the lock DOES hold (so the test proves the harness is
//     really enforcing the trigger, not silently no-opping), and
//   • the columns it does not, which is the finding.
//
// The trigger body and the profiles UPDATE policy are copied VERBATIM
// from the migrations. The caller runs as `app_user` — a non-superuser —
// because pglite's default role bypasses RLS unconditionally.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const SCHEMA = `
  create role app_user nologin;
  create role service_role nologin;

  create table profiles (
    id uuid primary key,
    role text,
    email text unique not null,
    phone text,
    phone_verified_at     timestamptz,
    sa_id_number          text,
    sa_id_lookup_hash     text,
    salary_day            int,
    salary_amount         numeric(10,2),
    credit_check_status   text,
    liveness_verified_at  timestamptz,
    identity_verification_status text,
    onboarding_completed  boolean not null default false,
    approved_credit_limit numeric(10,2)
  );

  create table _current_user (id uuid);
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;
  -- Stand-in for Supabase's auth.role(); our caller is never service_role.
  create or replace function auth.role() returns text
    language sql stable as $$ select 'authenticated'::text $$;

  alter table profiles enable row level security;

  -- ── VERBATIM from 0002_rls_policies.sql ──
  create policy "users_select_own_profile" on profiles
    for select using (id = auth.uid());
  create policy "users_update_own_profile" on profiles
    for update using (id = auth.uid()) with check (id = auth.uid());

  -- ── VERBATIM from 0065 (which supersedes 0054's body) ──
  create or replace function protect_profiles_columns()
  returns trigger language plpgsql security definer set search_path = public as $fn$
  begin
    if auth.role() = 'service_role'
       or current_setting('app.privileged_write', true) = 'on' then
      return new;
    end if;
    if new.role is distinct from old.role then
      raise exception 'profiles.role is not user-editable (privilege escalation guard)';
    end if;
    if new.email is distinct from old.email then
      raise exception 'profiles.email must be changed via the auth.users email-change ceremony';
    end if;
    if new.phone_verified_at is distinct from old.phone_verified_at then
      raise exception 'profiles.phone_verified_at is set only by the OTP verification path';
    end if;
    if new.approved_credit_limit is distinct from old.approved_credit_limit then
      raise exception 'profiles.approved_credit_limit is admin-set only (service-role / privileged RPC)';
    end if;
    return new;
  end;
  $fn$;

  create trigger trg_protect_profiles_columns
    before update on profiles
    for each row execute function protect_profiles_columns();

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public to app_user;
  grant execute on all functions in schema auth to app_user;
`;

const PATIENT = '11111111-1111-1111-1111-111111111111';

let db: PGlite;

async function asPatient(sql: string): Promise<{ ok: true } | { ok: false; error: string }> {
  await db.exec('delete from _current_user;');
  await db.query('insert into _current_user (id) values ($1)', [PATIENT]);
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
  await db.exec('delete from profiles;');
  // A brand-new patient: email confirmed, nothing else done. No phone
  // verification, no SA ID, no liveness, no salary, no credit check.
  await db.query(
    `insert into profiles (id, role, email, onboarding_completed) values ($1,'patient','p@x.test',false)`,
    [PATIENT],
  );
}

beforeAll(async () => { db = new PGlite(); await db.exec(SCHEMA); });
afterAll(async () => { await db?.close(); });

describe('AUDIT F-04 — the 0054/0065 column lock holds on the four columns it names', () => {
  beforeAll(reset);

  it('refuses a self-service role escalation', async () => {
    const r = await asPatient(`update profiles set role = 'admin' where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/privilege escalation guard/);
  });

  it('refuses a self-asserted phone_verified_at', async () => {
    const r = await asPatient(`update profiles set phone_verified_at = now() where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
  });

  it('refuses a self-granted credit limit', async () => {
    const r = await asPatient(`update profiles set approved_credit_limit = 500000 where id = '${PATIENT}'`);
    expect(r.ok).toBe(false);
  });
});

describe('AUDIT F-05 — every column the onboarding/KYC gate reads is NOT locked', () => {
  beforeAll(reset);

  it('lets the patient set onboarding_completed = true, which short-circuits computeOnboarding', async () => {
    const r = await asPatient(`update profiles set onboarding_completed = true where id = '${PATIENT}'`);
    expect(r.ok).toBe(true);
    await db.exec('reset role;');
    const { rows } = await db.query<{ onboarding_completed: boolean }>(
      `select onboarding_completed from profiles where id = '${PATIENT}'`,
    );
    expect(rows[0].onboarding_completed).toBe(true);
  });

  it('lets the patient forge the whole identity + affordability record in one statement', async () => {
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
    expect(r.ok).toBe(true);

    await db.exec('reset role;');
    const { rows } = await db.query<{
      sa_id_number: string; liveness_verified_at: string;
      credit_check_status: string; salary_amount: string;
    }>(`select sa_id_number, liveness_verified_at, credit_check_status, salary_amount
        from profiles where id = '${PATIENT}'`);

    // With these four set, stepIsSatisfied() returns true for 'salary',
    // 'identity' AND 'credit-check' — the full KYC gate, satisfied
    // without any Didit session, any DHA match, or any face match.
    expect(rows[0].sa_id_number).toBe('v1:forged');
    expect(rows[0].liveness_verified_at).not.toBeNull();
    expect(rows[0].credit_check_status).toBe('passed');
    expect(Number(rows[0].salary_amount)).toBe(90000);
  });
});
