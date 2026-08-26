// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution — crm_accounts_billing_summary (Phase 2 2.3) ──
//
// SECURITY DEFINER functions bypass RLS on every table they touch —
// this one re-implements admin-sees-all / sales-sees-own-crm_leads
// itself. That re-implementation is exactly the kind of logic that's
// dangerous to trust from reading the SQL alone, so this runs the
// function VERBATIM under a non-superuser role and asserts on what
// each caller actually gets back.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0114_crm_accounts_billing_summary.sql'), 'utf8',
).replace(/\r\n/g, '\n');

const BASE = `
  create role app_user nologin;
  create role authenticated nologin;
  create schema if not exists auth;
  create table _current_user (id uuid);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  create table profiles (
    id uuid primary key default gen_random_uuid(), role text,
    first_name text default '', last_name text default '', email text unique default gen_random_uuid()::text
  );
  create table practices (id uuid primary key default gen_random_uuid(), name text);
  create table plans (id uuid primary key default gen_random_uuid(), practice_id uuid references practices(id));
  create table payments (
    id uuid primary key default gen_random_uuid(),
    plan_id uuid references plans(id),
    amount numeric, status text, collected_at timestamptz
  );
  create table crm_leads (
    id uuid primary key default gen_random_uuid(),
    practice_name text not null,
    owner_user_id uuid,
    converted_practice_id uuid references practices(id),
    archived_at timestamptz
  );

  grant usage on schema public, auth to app_user;
  grant select, insert, update, delete on all tables in schema public to app_user;
  grant execute on all functions in schema public, auth to app_user;
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => db.query<T>(sql, p);

async function asUser<T = Record<string, unknown>>(userId: string | null, sql: string, p: unknown[] = []) {
  await q('delete from _current_user');
  if (userId) await q('insert into _current_user (id) values ($1)', [userId]);
  await db.exec('set role app_user');
  try { return await db.query<T>(sql, p); }
  finally { await db.exec('reset role'); }
}

type Ids = { admin: string; steve: string; otherSales: string; steveLead: string; otherLead: string; steveP: string; otherP: string };
let ids: Ids;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIG);
  await db.exec(`grant select, insert, update, delete on all tables in schema public to app_user;`);

  const admin     = (await q<{ id: string }>(`insert into profiles (role) values ('admin') returning id`)).rows[0].id;
  const steve     = (await q<{ id: string }>(`insert into profiles (role) values ('sales') returning id`)).rows[0].id;
  const otherSales= (await q<{ id: string }>(`insert into profiles (role) values ('sales') returning id`)).rows[0].id;

  const steveP  = (await q<{ id: string }>(`insert into practices (name) values ('Steve Practice') returning id`)).rows[0].id;
  const otherP  = (await q<{ id: string }>(`insert into practices (name) values ('Other Practice') returning id`)).rows[0].id;

  const steveLead = (await q<{ id: string }>(
    `insert into crm_leads (practice_name, owner_user_id, converted_practice_id) values ('Steve Practice', $1, $2) returning id`,
    [steve, steveP])).rows[0].id;
  const otherLead = (await q<{ id: string }>(
    `insert into crm_leads (practice_name, owner_user_id, converted_practice_id) values ('Other Practice', $1, $2) returning id`,
    [otherSales, otherP])).rows[0].id;

  const planSteve = (await q<{ id: string }>(`insert into plans (practice_id) values ($1) returning id`, [steveP])).rows[0].id;
  await q(`insert into payments (plan_id, amount, status, collected_at) values ($1, 5000, 'collected', now())`, [planSteve]);

  ids = { admin, steve, otherSales, steveLead, otherLead, steveP, otherP };
});

describe('crm_accounts_billing_summary — access scoping', () => {
  it('admin sees every converted practice', async () => {
    const { rows } = await asUser<{ practice_id: string }>(ids.admin, `select distinct practice_id from crm_accounts_billing_summary()`);
    expect(rows.map(r => r.practice_id).sort()).toEqual([ids.otherP, ids.steveP].sort());
  });

  it('sales sees only practices converted from leads they own', async () => {
    const { rows } = await asUser<{ practice_id: string }>(ids.steve, `select distinct practice_id from crm_accounts_billing_summary()`);
    expect(rows.map(r => r.practice_id)).toEqual([ids.steveP]);
  });

  it('adversarial — a sales user gets zero rows for a teammate-owned practice', async () => {
    const { rows } = await asUser(ids.steve, `select * from crm_accounts_billing_summary() where practice_id = $1`, [ids.otherP]);
    expect(rows).toHaveLength(0);
  });

  it('a non-CRM role (e.g. patient) gets zero rows, not an error', async () => {
    const patient = (await q<{ id: string }>(`insert into profiles (role) values ('patient') returning id`)).rows[0].id;
    const { rows } = await asUser(patient, `select * from crm_accounts_billing_summary()`);
    expect(rows).toHaveLength(0);
  });

  it('returns the actual collected payment for the visible practice', async () => {
    const { rows } = await asUser<{ payment_amount: number }>(ids.steve, `select payment_amount from crm_accounts_billing_summary() where practice_id = $1`, [ids.steveP]);
    expect(Number(rows[0].payment_amount)).toBe(5000);
  });
});

describe('10. adversarial — the Accounts view performs zero writes', () => {
  it('the RPC function body contains no INSERT/UPDATE/DELETE statement', () => {
    const start = MIG.indexOf('CREATE OR REPLACE FUNCTION crm_accounts_billing_summary');
    const end = MIG.indexOf('$$;', start);
    const body = MIG.slice(start, end);
    expect(body).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(body).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('the Accounts page source issues only SELECT-shaped Supabase calls', () => {
    const PAGE = readFileSync(resolve(process.cwd(), 'app/crm/accounts/page.tsx'), 'utf8');
    expect(PAGE).not.toMatch(/\.insert\(/);
    expect(PAGE).not.toMatch(/\.update\(/);
    expect(PAGE).not.toMatch(/\.delete\(/);
    expect(PAGE).not.toMatch(/\.upsert\(/);
  });
});
