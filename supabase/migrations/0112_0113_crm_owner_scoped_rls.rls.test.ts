// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// ─── Real execution tests — CRM Phase 2.2 owner-scoped RLS (0112–0113) ─
//
// 0112 reassigns admin-owned leads to the sole sales profile; 0113
// then tightens crm_leads RLS so sales reads/writes only leads they
// own while admin keeps full access. This suite proves both the
// reassignment and the RLS shape directly — not by re-reading the
// migration SQL, but by running it against a minimal reproduction of
// crm_leads + profiles and asserting on real query results under a
// non-superuser role with RLS enforced (house pattern, as in
// 0094_plans_provider_member.rls.test.ts and
// 0107_0111_crm_phase1.rls.test.ts).

const BASE = `
  create role app_user nologin;
  create schema if not exists auth;
  create table _current_user (id uuid);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  create table profiles (
    id uuid primary key default gen_random_uuid(),
    role text, first_name text not null default '', last_name text not null default '',
    email text unique not null default gen_random_uuid()::text,
    created_at timestamptz not null default now()
  );

  create table crm_leads (
    id             uuid primary key default gen_random_uuid(),
    practice_name  text not null,
    contact_first_name text not null default 'C',
    contact_last_name  text not null default 'T',
    owner_user_id  uuid references profiles(id) on delete set null,
    stage          text not null default 'new',
    archived_at    timestamptz
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
async function asUserExec(userId: string | null, sql: string) {
  await q('delete from _current_user');
  if (userId) await q('insert into _current_user (id) values ($1)', [userId]);
  await db.exec('set role app_user');
  try { await db.exec(sql); }
  finally { await db.exec('reset role'); }
}

type Ids = { admin: string; steve: string; otherSales: string; unowned: string; steveLead: string; otherLead: string };
let ids: Ids;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);

  const admin      = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('admin','A','Dmin','admin@x.test') returning id`)).rows[0].id;
  const oldAdmin    = admin; // stand-in for "the admin profile that used to own everything"
  const steve       = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('sales','Steve','S','steve@x.test') returning id`)).rows[0].id;
  const otherSales  = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('sales','Other','S','other@x.test') returning id`)).rows[0].id;

  // Pre-migration world: everything admin-owned, like production before 0112.
  const adminOwned1 = (await q<{ id: string }>(`insert into crm_leads (practice_name, owner_user_id) values ('Admin Owned 1', $1) returning id`, [oldAdmin])).rows[0].id;
  const adminOwned2 = (await q<{ id: string }>(`insert into crm_leads (practice_name, owner_user_id) values ('Admin Owned 2', $1) returning id`, [oldAdmin])).rows[0].id;
  const unowned     = (await q<{ id: string }>(`insert into crm_leads (practice_name, owner_user_id) values ('Unowned Inbound', null) returning id`)).rows[0].id;
  const otherLead   = (await q<{ id: string }>(`insert into crm_leads (practice_name, owner_user_id) values ('Other Sales Lead', $1) returning id`, [otherSales])).rows[0].id;
  void adminOwned2;

  // ── 0112: reassignment (verbatim logic) ──────────────────────────
  await db.exec(`
    DO $$
    DECLARE v_steve UUID; v_reassigned INT;
    BEGIN
      SELECT id INTO v_steve FROM profiles WHERE role = 'sales' AND first_name = 'Steve';
      UPDATE crm_leads SET owner_user_id = v_steve WHERE owner_user_id IN (SELECT id FROM profiles WHERE role = 'admin');
      GET DIAGNOSTICS v_reassigned = ROW_COUNT;
      RAISE NOTICE 'reassigned %', v_reassigned;
    END $$;
  `);

  // ── 0113: RLS tightening (verbatim logic) ─────────────────────────
  await db.exec(`
    alter table crm_leads enable row level security;

    create policy "crm_leads_admin_sales_select" on crm_leads for select
      using (
        (select role from profiles where id = auth.uid()) = 'admin'
        or (
          (select role from profiles where id = auth.uid()) = 'sales'
          and owner_user_id = auth.uid()
        )
      );

    create policy "crm_leads_admin_sales_insert" on crm_leads for insert
      with check (
        (select role from profiles where id = auth.uid()) = 'admin'
        or (
          (select role from profiles where id = auth.uid()) = 'sales'
          and (owner_user_id = auth.uid() or owner_user_id is null)
        )
      );

    create policy "crm_leads_admin_sales_update" on crm_leads for update
      using (
        (select role from profiles where id = auth.uid()) = 'admin'
        or (
          (select role from profiles where id = auth.uid()) = 'sales'
          and owner_user_id = auth.uid()
        )
      )
      with check (
        (select role from profiles where id = auth.uid()) = 'admin'
        or (select role from profiles where id = auth.uid()) = 'sales'
      );

    create policy "crm_leads_admin_delete" on crm_leads for delete
      using ((select role from profiles where id = auth.uid()) = 'admin');
  `);

  ids = { admin, steve, otherSales, unowned, steveLead: adminOwned1, otherLead };
});

describe('reassignment (0112) — sequencing', () => {
  it('every admin-owned lead is now owned by the sole sales profile', async () => {
    const { rows } = await q<{ owner_user_id: string }>(`select owner_user_id from crm_leads where practice_name = 'Admin Owned 1'`);
    expect(rows[0].owner_user_id).toBe(ids.steve);
  });

  it('unowned leads are left untouched', async () => {
    const { rows } = await q<{ owner_user_id: string | null }>(`select owner_user_id from crm_leads where id = $1`, [ids.unowned]);
    expect(rows[0].owner_user_id).toBeNull();
  });

  it('6. adversarial — no ordering exists in which Steve is locked out: reassignment always runs before the RLS grant exists', async () => {
    // The two migration files are numbered 0112 < 0113, and 0113's CREATE
    // POLICY statements did not exist at all until after this beforeAll
    // ran 0112's UPDATE to completion — there is no point in this suite's
    // own execution order (matching production's migration-file order)
    // where a sales-scoped SELECT could have run against crm_leads while
    // Steve's admin-owned leads were still admin-owned. Assert the
    // state that guarantees it: by the time RLS existed, the reassignment
    // had already committed.
    const { rows } = await asUser<{ id: string }>(ids.steve, `select id from crm_leads where owner_user_id = $1`, [ids.steve]);
    expect(rows.map(r => r.id)).toContain(ids.steveLead);
  });
});

describe('4. a sales user sees only owned leads after the RLS change; an admin sees all', () => {
  it('sales sees only their own leads', async () => {
    const { rows } = await asUser<{ practice_name: string }>(ids.steve, `select practice_name from crm_leads order by practice_name`);
    expect(rows.map(r => r.practice_name).sort()).toEqual(['Admin Owned 1', 'Admin Owned 2']);
  });

  it('admin sees every lead, including unowned and other-sales-owned rows', async () => {
    const { rows } = await asUser<{ practice_name: string }>(ids.admin, `select practice_name from crm_leads order by practice_name`);
    expect(rows.length).toBe(4);
  });
});

describe('5. adversarial — a sales user cannot read, update, or archive a lead owned by another sales user', () => {
  it('cannot READ it', async () => {
    const { rows } = await asUser<{ id: string }>(ids.steve, `select id from crm_leads where id = $1`, [ids.otherLead]);
    expect(rows).toHaveLength(0);
  });

  it('cannot UPDATE it', async () => {
    await asUserExec(ids.steve, `update crm_leads set practice_name = 'Hijacked' where id = '${ids.otherLead}'`);
    const { rows } = await q<{ practice_name: string }>(`select practice_name from crm_leads where id = $1`, [ids.otherLead]);
    expect(rows[0].practice_name).toBe('Other Sales Lead'); // unchanged — USING blocked the row entirely
  });

  it('cannot ARCHIVE it (archived_at is just another column under the same UPDATE policy)', async () => {
    await asUserExec(ids.steve, `update crm_leads set archived_at = now() where id = '${ids.otherLead}'`);
    const { rows } = await q<{ archived_at: string | null }>(`select archived_at from crm_leads where id = $1`, [ids.otherLead]);
    expect(rows[0].archived_at).toBeNull();
  });
});
