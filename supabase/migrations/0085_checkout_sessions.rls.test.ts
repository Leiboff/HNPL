// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RLS enforcement test — checkout_sessions INSERT (Step 0) ────────
//
// This is the class of bug a mocked-client test structurally cannot catch:
// issueCounterSession inserted into checkout_sessions via the AUTHENTICATED
// Supabase client, but migration 0085 grants that table only a SELECT
// policy — no INSERT policy for anon/authenticated at all. Under real
// Postgres RLS the insert is denied outright. Every other test in this
// repo touching this code path mocks the Supabase client, so the mock's
// `.insert()` always "succeeds" regardless of what the real database
// would do — that's exactly how this shipped unnoticed.
//
// This test runs the ACTUAL migration SQL (table + RLS + policy, extracted
// verbatim, not hand-retyped) in a real Postgres (pglite), with a
// non-owner, non-superuser role standing in for Supabase's `authenticated`
// (granted the same broad table-level privileges Supabase grants by
// default — RLS, not a missing GRANT, must be what blocks it) and a
// BYPASSRLS role standing in for `service_role`. It proves BOTH halves:
//   (a) the authenticated-shaped role's INSERT is rejected BY RLS
//       specifically (the Postgres "row-level security policy" error,
//       not a generic permission-denied-by-grant error), and
//   (b) the service-role-shaped role's INSERT succeeds.
//
// General-purpose regression guard: any future table that ships with RLS
// enabled but an incomplete policy set for the write path it actually
// needs should be caught the same way — by running the real DDL against
// a real role, not by trusting a mock.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0085_checkout_sessions.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// Extract the table + index + RLS + policy block verbatim — from the
// CREATE TABLE statement up to (not including) the functions section.
// This is exactly the DDL that ships; nothing here is hand-retyped.
function tableAndPolicyDdl(): string {
  const start = MIG.indexOf('CREATE TABLE IF NOT EXISTS checkout_sessions');
  const end   = MIG.indexOf('-- ── First-timer hard-stop');
  if (start < 0 || end < 0) throw new Error('checkout_sessions DDL block not found in migration 0085');
  return MIG.slice(start, end);
}

// Minimal FK targets — just enough columns for checkout_sessions' own FK
// constraints to attach to. Not testing practices/plans' own RLS here.
const STUB_SCHEMA = `
  create table practices (id uuid primary key default gen_random_uuid());
  create table plans     (id uuid primary key default gen_random_uuid());
  create table profiles  (id uuid primary key default gen_random_uuid());
  -- Stub referenced by the SELECT policy's USING clause. Irrelevant to
  -- the INSERT behaviour under test, but must exist for CREATE POLICY to
  -- resolve the function reference.
  create or replace function is_practice_biller(p_practice_id uuid) returns boolean
    language sql stable as $$ select false $$;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  // gen_random_uuid() is available in pglite's default build without an
  // explicit extension (same as the sibling 0083 rpc test) — no
  // `create extension pgcrypto` needed/available.
  await db.exec(STUB_SCHEMA);
  await db.exec(tableAndPolicyDdl());

  // Supabase's real role shapes: authenticated/anon get broad table-level
  // grants (RLS is the actual gate); service_role has BYPASSRLS. Neither
  // is the table owner, so RLS applies to the first and is bypassed for
  // the second — same as production.
  await db.exec(`
    create role authenticated_test nologin;
    create role service_role_test nologin bypassrls;
    grant select, insert, update, delete on checkout_sessions to authenticated_test;
    grant select, insert, update, delete on checkout_sessions to service_role_test;
  `);

  return db;
}

let practiceId: string;
let planId: string;

async function seedFkTargets(db: PGlite) {
  const p = await db.query<{ id: string }>(`insert into practices default values returning id`);
  const pl = await db.query<{ id: string }>(`insert into plans default values returning id`);
  practiceId = p.rows[0].id;
  planId     = pl.rows[0].id;
}

function insertSql(): string {
  return `
    insert into checkout_sessions (token, practice_id, plan_id, sa_id_number, expires_at)
    values ('tok-rls-test', '${practiceId}', '${planId}', 'v1:iv:tag:ct', now() + interval '2 minutes')
  `;
}

describe('checkout_sessions RLS — authenticated client cannot insert (the bug)', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await seedFkTargets(db); });

  it('rejects an INSERT from the authenticated-shaped role with a row-level-security error', async () => {
    await expect(
      db.exec(`set role authenticated_test; ${insertSql()}; reset role;`),
    ).rejects.toThrow(/row-level security/i);
  });

  it('leaves the table empty after the rejected attempt (no partial write)', async () => {
    const { rows } = await db.query(`select count(*)::int as n from checkout_sessions`);
    expect((rows[0] as { n: number }).n).toBe(0);
  });
});

describe('checkout_sessions RLS — service-role client succeeds (the fix)', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await seedFkTargets(db); });

  it('the service-role-shaped (BYPASSRLS) role can insert', async () => {
    await db.exec(`set role service_role_test; ${insertSql()}; reset role;`);
    const { rows } = await db.query(`select token from checkout_sessions where token = 'tok-rls-test'`);
    expect(rows.length).toBe(1);
  });
});

describe('issueCounterSession source — uses the service-role client for this insert', () => {
  const ACTIONS = readFileSync(resolve(process.cwd(), 'app/practice/pos/actions.ts'), 'utf8');

  it('inserts into checkout_sessions via the service-role client, not a user-session client', () => {
    // Post-device-auth (Build D) issueCounterSession has no user session
    // at all — everything runs through the service-role client, now
    // named `client` in that file (there is no `supabase`/user-JWT
    // client anywhere in it any more). The property under test is
    // unchanged: this specific insert must not be reachable via a
    // caller-scoped RLS client, since checkout_sessions grants that
    // role no INSERT policy.
    expect(ACTIONS).toMatch(/client\.from\('checkout_sessions'\)\.insert\(/);
    expect(ACTIONS).not.toMatch(/\bsupabase\.from\('checkout_sessions'\)\.insert\(/);
  });
});
