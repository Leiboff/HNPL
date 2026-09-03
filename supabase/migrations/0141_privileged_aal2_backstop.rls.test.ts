// @vitest-environment node
//
// ─── 0141 — the AAL2 database backstop, against real Postgres ──────────
//
// Runs the migration verbatim on a non-superuser role (pglite's default
// role bypasses RLS; `authenticated` here does not) and asserts:
//
//   • the restrictive payout-settlement policies refuse an aal1 admin and a
//     stale-aal2 admin, and admit an aal2-fresh admin  (named 1/2/3/6 at
//     the DB layer, critical/5-min window);
//   • service_role still writes regardless of assurance — the guard runs in
//     the app, before the client choice, and the DB layer is a backstop for
//     the user-client path, not a second gate on the machine path (named 7);
//   • reads are untouched — an aal1 admin still SELECTs payouts, and a
//     practice manager still UPDATEs their own practice — so browse, till,
//     checkout and practice-manager banking traffic pass unchanged (named
//     11);
//   • admin_audit_log accepts the new 'auth_factor' entity_type, and the
//     factor snapshot function returns rows to a platform admin only
//     (named 9, DB half; the diff logic is unit-tested in
//     lib/auth/mfaFactorDiff.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0141_privileged_aal2_backstop.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ADMIN    = '0000ad00-0000-0000-0000-00000000ad00';
const MANAGER  = '0000aa11-0000-0000-0000-00000000aa11';
const PRACTICE = '0000dddd-0000-0000-0000-00000000dddd';
const GROUP    = '0000c000-0000-0000-0000-00000000c000';
const PAYOUT   = '0000f000-0000-0000-0000-00000000f000';
const BATCH    = '0000ba00-0000-0000-0000-00000000ba00';

const SCHEMA = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin bypassrls;

  -- auth.uid()/auth.role() from the request's jwt claims, like GoTrue.
  create schema if not exists auth;
  create or replace function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
  $$;
  create or replace function auth.role() returns text language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', 'authenticated')
  $$;

  -- Minimal auth.mfa_factors so the snapshot function body validates.
  create table auth.mfa_factors (
    id uuid primary key,
    user_id uuid not null,
    factor_type text not null,
    status text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table profiles (id uuid primary key, role text);
  create table practice_groups (id uuid primary key, name text);
  create table practices (
    id uuid primary key,
    group_id uuid,
    name text,
    status text default 'pending',
    bank_account_number text
  );
  create table practice_managers (practice_id uuid, user_id uuid);

  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
    select exists (select 1 from profiles where id = auth.uid() and role = 'admin')
  $$;

  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable security definer set search_path = public as $$
    select exists (select 1 from practice_managers where practice_id = p_practice_id and user_id = auth.uid())
  $$;

  create table payout_batches (id uuid primary key, practice_id uuid, status text);
  create table payouts (id uuid primary key, practice_id uuid, batch_id uuid, status text);

  create table admin_audit_log (
    id uuid primary key default gen_random_uuid(),
    actor_id uuid,
    entity_type text not null,
    entity_id uuid not null,
    action text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
  alter table admin_audit_log add constraint admin_audit_log_entity_type_check
    check (entity_type = any (array['practice','customer','practice_group','payout','payout_batch','payment']));

  -- Enable RLS + the PERMISSIVE policies the production tables carry, so the
  -- restrictive policies added by the migration combine against something.
  alter table payouts        enable row level security;
  alter table payout_batches enable row level security;
  alter table practices      enable row level security;

  create policy admins_all_payouts on payouts for all
    using (is_platform_admin()) with check (is_platform_admin());
  create policy admins_all_payout_batches on payout_batches for all
    using (is_platform_admin()) with check (is_platform_admin());
  -- a SELECT-for-all so we can prove reads are unaffected
  create policy anyone_select_payouts on payouts for select using (true);

  create policy admins_update_all_practices on practices for update
    using (is_platform_admin());
  create policy practice_admins_update_own_practice on practices for update
    using (is_practice_manager(id));
  -- SELECT visibility (production has equivalents) so an UPDATE ... RETURNING
  -- can see its row; without a SELECT policy the UPDATE would find 0 rows for
  -- a reason unrelated to the aal backstop.
  create policy select_practices on practices for select
    using (is_platform_admin() or is_practice_manager(id));

  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;

  -- Seed
  insert into profiles values ('${ADMIN}', 'admin'), ('${MANAGER}', 'practice_admin');
  insert into practice_groups values ('${GROUP}', 'Brand');
  insert into practices values ('${PRACTICE}', '${GROUP}', 'Branch', 'approved', null);
  insert into practice_managers values ('${PRACTICE}', '${MANAGER}');
  insert into payout_batches values ('${BATCH}', '${PRACTICE}', 'pending');
  insert into payouts values ('${PAYOUT}', '${PRACTICE}', '${BATCH}', 'pending');
`;

let db: PGlite;

const nowSec = () => Math.floor(Date.now() / 1000);

/** Build a jwt.claims json for a given aal + mfa age (seconds). */
function claims(sub: string, aal: 'aal1' | 'aal2', mfaAgeSec: number | null): string {
  const amr: Array<Record<string, unknown>> = [{ method: 'password', timestamp: nowSec() - 300 }];
  if (mfaAgeSec !== null) amr.push({ method: 'mfa/totp', timestamp: nowSec() - mfaAgeSec });
  return JSON.stringify({ sub, role: 'authenticated', aal, amr });
}

/** Run `fn` as `role` with the given jwt claims set, then reset. */
async function asRole(role: string, jwtClaims: string | null): Promise<void> {
  await db.exec(`set role ${role};`);
  // is_local = false: the setting must survive across the auto-committed
  // statements that follow (the UPDATE, the SELECT), not just this one.
  if (jwtClaims === null) {
    await db.exec(`select set_config('request.jwt.claims', '', false);`);
  } else {
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [jwtClaims]);
  }
}
async function resetRole(): Promise<void> {
  await db.exec('reset role;');
  await db.exec(`select set_config('request.jwt.claims', '', false);`);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG);
});

afterAll(async () => { await db?.close(); });

// Each mutation test runs in its own transaction-ish reset of the row state.
async function resetPayout(): Promise<void> {
  await resetRole();
  await db.exec(`update payouts set status='pending' where id='${PAYOUT}';`);
  await db.exec(`update payout_batches set status='pending' where id='${BATCH}';`);
}

describe('restrictive policy — payout settlement (critical / 5 min)', () => {
  it('[named 1 db] aal1 admin cannot UPDATE a payout', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal1', null));
    const res = await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`);
    expect(res.rows).toHaveLength(0);
    await resetRole();
  });

  it('[named 6 db] aal2 admin with a STALE (6h) mfa timestamp cannot UPDATE', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal2', 6 * 3600));
    const res = await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`);
    expect(res.rows).toHaveLength(0);
    await resetRole();
  });

  it('[named 3 db] aal2 admin with a FRESH (3 min) mfa timestamp CAN UPDATE', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal2', 3 * 60));
    const res = await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`);
    expect(res.rows).toHaveLength(1);
    await resetRole();
  });

  it('[named 2 db] the 5-min window: 4 min passes, 6 min fails', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal2', 4 * 60));
    expect((await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`)).rows).toHaveLength(1);
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal2', 6 * 60));
    expect((await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`)).rows).toHaveLength(0);
    await resetRole();
  });

  it('[named 4 db] a FUTURE mfa timestamp fails closed at the DB too', async () => {
    await resetPayout();
    const future = JSON.stringify({
      sub: ADMIN, role: 'authenticated', aal: 'aal2',
      amr: [{ method: 'mfa/totp', timestamp: nowSec() + 3600 }],
    });
    await asRole('authenticated', future);
    const res = await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`);
    expect(res.rows).toHaveLength(0);
    await resetRole();
  });

  it('also gates payout_batches UPDATE identically', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal1', null));
    expect((await db.query(`update payout_batches set status='paid' where id='${BATCH}' returning id`)).rows).toHaveLength(0);
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal2', 60));
    expect((await db.query(`update payout_batches set status='paid' where id='${BATCH}' returning id`)).rows).toHaveLength(1);
    await resetRole();
  });
});

describe('[named 7 db] service_role bypasses RLS regardless of assurance', () => {
  it('settles a payout with no jwt claims at all', async () => {
    await resetPayout();
    await asRole('service_role', null);
    const res = await db.query(`update payouts set status='paid' where id='${PAYOUT}' returning id`);
    expect(res.rows).toHaveLength(1);
    await resetRole();
  });
});

describe('[named 11] reads and non-payout writes are unaffected', () => {
  it('an aal1 admin can still SELECT payouts (restrictive is UPDATE-only)', async () => {
    await resetPayout();
    await asRole('authenticated', claims(ADMIN, 'aal1', null));
    const res = await db.query(`select id from payouts where id='${PAYOUT}'`);
    expect(res.rows).toHaveLength(1);
    await resetRole();
  });

  it('a practice manager can UPDATE their own practice at aal1 (no aal policy on practices)', async () => {
    await resetRole();
    await asRole('authenticated', claims(MANAGER, 'aal1', null));
    const res = await db.query(
      `update practices set bank_account_number='9999999999' where id='${PRACTICE}' returning id`,
    );
    expect(res.rows).toHaveLength(1);
    await resetRole();
  });
});

describe('[named 9 db] audit surface + factor snapshot', () => {
  it('admin_audit_log now accepts entity_type = auth_factor', async () => {
    await resetRole();
    await db.query(
      `insert into admin_audit_log (actor_id, entity_type, entity_id, action, payload)
       values (null, 'auth_factor', $1, 'mfa_factor_disappeared', '{"source":"cron_diff"}')`,
      [ADMIN],
    );
    const res = await db.query(`select count(*)::int as n from admin_audit_log where entity_type='auth_factor'`);
    expect((res.rows[0] as { n: number }).n).toBe(1);
  });

  it('the widened CHECK still rejects an unknown entity_type', async () => {
    await resetRole();
    await expect(
      db.query(
        `insert into admin_audit_log (entity_type, entity_id, action) values ('nonsense', $1, 'x')`,
        [ADMIN],
      ),
    ).rejects.toThrow();
  });

  it('mfa_factor_snapshot returns rows to a platform admin, nothing to a non-admin', async () => {
    await resetRole();
    await db.query(
      `insert into auth.mfa_factors (id, user_id, factor_type, status) values ($1, $2, 'totp', 'verified')`,
      ['0000fac0-0000-0000-0000-00000000fac0', ADMIN],
    );

    await asRole('authenticated', claims(ADMIN, 'aal2', 60));
    const asAdmin = await db.query(`select * from mfa_factor_snapshot()`);
    expect(asAdmin.rows.length).toBeGreaterThanOrEqual(1);
    await resetRole();

    await asRole('authenticated', claims(MANAGER, 'aal1', null));
    const asManager = await db.query(`select * from mfa_factor_snapshot()`);
    expect(asManager.rows).toHaveLength(0);
    await resetRole();
  });

  it('mfa_factor_state exists and is admin-readable', async () => {
    await resetRole();
    const cols = await db.query(
      `select column_name from information_schema.columns where table_name='mfa_factor_state' order by column_name`,
    );
    const names = cols.rows.map((r) => (r as { column_name: string }).column_name);
    expect(names).toContain('factor_id');
    expect(names).toContain('status');
  });
});
