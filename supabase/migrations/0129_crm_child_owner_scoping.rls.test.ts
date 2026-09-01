// @vitest-environment node
//
// ─── The CRM child tables inherit their lead's ownership (A-09, A-10) ──────
//
// 0113 scoped `crm_leads` to `owner_user_id` for a `sales` caller and left
// seven child tables reading `role IN ('admin','sales')`. So the parent row
// was hidden and the children were not — and the children hold the
// practitioner contact details and the call notes.
//
// This suite is written from two seats: rep A owns lead A, rep B owns lead B,
// and an admin owns nothing. Every assertion is "what can rep A see and do
// about lead B", because that is the boundary 0129 draws.
//
// Runs as a real non-superuser role. pglite's default role bypasses RLS
// unconditionally, which would make this file pass with 0129 deleted.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0129_crm_child_owner_scoping.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const REP_A  = '0000000a-0000-0000-0000-00000000000a';
const REP_B  = '0000000b-0000-0000-0000-00000000000b';
const ADMIN  = '0000ad00-0000-0000-0000-00000000ad00';
const LEAD_A = '11110000-0000-0000-0000-000000001111';
const LEAD_B = '22220000-0000-0000-0000-000000002222';

/**
 * The pre-0129 state: the tables, and the child policies as 0069/0071/0075/
 * 0107/0110/0117 wrote them, plus 0113's own scoping of the parent. 0129 is
 * then applied verbatim, so the test exercises the real rewrite rather than a
 * description of its end state.
 */
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

  create table crm_leads (
    id uuid primary key, owner_user_id uuid, practice_name text,
    archived_at timestamptz, converted_practice_id uuid
  );
  create table crm_activities (
    id uuid primary key default gen_random_uuid(),
    lead_id uuid not null references crm_leads(id) on delete cascade,
    kind text, note text
  );
  create table crm_lead_contacts (
    id uuid primary key default gen_random_uuid(),
    lead_id uuid not null references crm_leads(id) on delete cascade,
    full_name text, email text, phone text, hpcsa_number text
  );
  create table crm_lead_tags (
    id uuid primary key default gen_random_uuid(),
    lead_id uuid not null references crm_leads(id) on delete cascade,
    tag text
  );
  create table crm_tasks (
    id uuid primary key default gen_random_uuid(),
    lead_id uuid references crm_leads(id) on delete cascade,
    owner_user_id uuid not null, type text, title text,
    due_at timestamptz not null default now()
  );
  create table crm_saved_views (
    id uuid primary key default gen_random_uuid(),
    owner_user_id uuid not null, name text, is_shared boolean not null default false
  );
  create table crm_suggestion_dismissals (
    id uuid primary key default gen_random_uuid(),
    lead_a_id uuid not null references crm_leads(id) on delete cascade,
    lead_b_id uuid not null references crm_leads(id) on delete cascade,
    kind text
  );
  create table crm_email_templates (
    id uuid primary key default gen_random_uuid(),
    name text, subject text, body text, is_seed boolean default true
  );

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;

  alter table crm_leads                 enable row level security;
  alter table crm_activities            enable row level security;
  alter table crm_lead_contacts         enable row level security;
  alter table crm_lead_tags             enable row level security;
  alter table crm_tasks                 enable row level security;
  alter table crm_saved_views           enable row level security;
  alter table crm_suggestion_dismissals enable row level security;
  alter table crm_email_templates       enable row level security;

  -- 0113 — the parent, already scoped. Its UPDATE policy carries the A-10
  -- defect: ownership in USING, dropped from WITH CHECK.
  create policy "crm_leads_admin_sales_select" on crm_leads
    for select using (
      (select role from profiles where id = auth.uid()) = 'admin'
      or ((select role from profiles where id = auth.uid()) = 'sales'
          and owner_user_id = auth.uid())
    );
  create policy "crm_leads_admin_sales_update" on crm_leads
    for update using (
      (select role from profiles where id = auth.uid()) = 'admin'
      or ((select role from profiles where id = auth.uid()) = 'sales'
          and owner_user_id = auth.uid())
    ) with check (
      (select role from profiles where id = auth.uid()) = 'admin'
      or (select role from profiles where id = auth.uid()) = 'sales'
    );

  -- 0069 / 0071 / 0075 / 0107 / 0110 / 0117 — the unscoped children.
  create policy "crm_activities_admin_sales_select" on crm_activities
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_activities_admin_sales_insert" on crm_activities
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_activities_admin_sales_update" on crm_activities
    for update using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
               with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_activities_admin_sales_delete" on crm_activities
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_lead_contacts_admin_sales_select" on crm_lead_contacts
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_insert" on crm_lead_contacts
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_update" on crm_lead_contacts
    for update using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
               with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_delete" on crm_lead_contacts
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_lead_tags_admin_sales_select" on crm_lead_tags
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_tags_admin_sales_insert" on crm_lead_tags
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_tags_admin_sales_delete" on crm_lead_tags
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_tasks_admin_sales_select" on crm_tasks
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_tasks_admin_sales_insert" on crm_tasks
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_tasks_admin_sales_update" on crm_tasks
    for update using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
               with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_tasks_admin_sales_delete" on crm_tasks
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_saved_views_admin_sales_select" on crm_saved_views
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_saved_views_admin_sales_insert" on crm_saved_views
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_saved_views_admin_sales_update" on crm_saved_views
    for update using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
               with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_saved_views_admin_sales_delete" on crm_saved_views
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_suggestion_dismissals_admin_sales_select" on crm_suggestion_dismissals
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_suggestion_dismissals_admin_sales_insert" on crm_suggestion_dismissals
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_suggestion_dismissals_admin_sales_delete" on crm_suggestion_dismissals
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  create policy "crm_email_templates_admin_sales_select" on crm_email_templates
    for select using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_email_templates_admin_sales_insert" on crm_email_templates
    for insert with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_email_templates_admin_sales_update" on crm_email_templates
    for update using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
               with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_email_templates_admin_sales_delete" on crm_email_templates
    for delete using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
`;

const SEED = `
  insert into profiles (id, role) values
    ('${REP_A}', 'sales'), ('${REP_B}', 'sales'), ('${ADMIN}', 'admin');
  insert into crm_leads (id, owner_user_id, practice_name) values
    ('${LEAD_A}', '${REP_A}', 'A Practice'),
    ('${LEAD_B}', '${REP_B}', 'B Practice');

  insert into crm_activities   (lead_id, kind, note) values
    ('${LEAD_A}', 'call', 'A note'), ('${LEAD_B}', 'call', 'B note');
  insert into crm_lead_contacts (lead_id, full_name, email, phone, hpcsa_number) values
    ('${LEAD_A}', 'Dr A', 'a@x.co.za', '+27820000001', 'MP111111'),
    ('${LEAD_B}', 'Dr B', 'b@x.co.za', '+27820000002', 'MP222222');
  insert into crm_lead_tags     (lead_id, tag) values
    ('${LEAD_A}', 'hot'), ('${LEAD_B}', 'hot');
  insert into crm_tasks (lead_id, owner_user_id, type, title) values
    ('${LEAD_A}', '${REP_A}', 'call', 'A task'),
    ('${LEAD_B}', '${REP_B}', 'call', 'B task'),
    (null,        '${REP_B}', 'admin', 'B admin task');
  insert into crm_saved_views (owner_user_id, name, is_shared) values
    ('${REP_A}', 'A private', false),
    ('${REP_B}', 'B private', false),
    ('${REP_B}', 'B shared',  true);
  insert into crm_suggestion_dismissals (lead_a_id, lead_b_id, kind) values
    ('${LEAD_A}', '${LEAD_B}', 'duplicate_practice');
  insert into crm_email_templates (name, subject, body) values ('Intro', 'Hi', 'Body');
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

const count = async (uid: string, table: string): Promise<number> => {
  const r = await as<{ n: number }>(uid, `select count(*)::int as n from ${table};`);
  return r[0].n;
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);   // verbatim
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('0129 — a rep sees only their own leads\' children (A-09)', () => {
  it.each([
    ['crm_activities'],
    ['crm_lead_contacts'],
    ['crm_lead_tags'],
  ])('%s: rep A sees one row, not both', async (table) => {
    expect(await count(REP_A, table)).toBe(1);
    expect(await count(REP_B, table)).toBe(1);
    expect(await count(ADMIN, table)).toBe(2);
  });

  it('the contact row rep A sees is their OWN lead\'s', async () => {
    const rows = await as<{ hpcsa_number: string }>(REP_A,
      `select hpcsa_number from crm_lead_contacts;`);
    expect(rows).toHaveLength(1);
    expect(rows[0].hpcsa_number).toBe('MP111111');
  });

  it('rep A cannot delete rep B\'s task', async () => {
    await as(REP_A, `delete from crm_tasks where title = 'B task';`);
    const still = await db.query<{ n: number }>(
      `select count(*)::int as n from crm_tasks where title = 'B task';`);
    expect(still.rows[0].n).toBe(1);
  });

  it('rep A cannot insert an activity onto rep B\'s lead', async () => {
    await expect(as(REP_A,
      `insert into crm_activities (lead_id, kind, note) values ('${LEAD_B}', 'call', 'injected');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('rep A cannot update rep B\'s contact row', async () => {
    await as(REP_A, `update crm_lead_contacts set email = 'stolen@x.co' where hpcsa_number = 'MP222222';`);
    const row = await db.query<{ email: string }>(
      `select email from crm_lead_contacts where hpcsa_number = 'MP222222';`);
    expect(row.rows[0].email).toBe('b@x.co.za');
  });

  it('and rep A can still do all of that on their OWN lead', async () => {
    await as(REP_A,
      `insert into crm_activities (lead_id, kind, note) values ('${LEAD_A}', 'email', 'mine');`);
    await as(REP_A, `update crm_lead_contacts set phone = '+27829999999' where hpcsa_number = 'MP111111';`);
    expect(await count(REP_A, 'crm_activities')).toBe(2);
    const row = await as<{ phone: string }>(REP_A,
      `select phone from crm_lead_contacts where hpcsa_number = 'MP111111';`);
    expect(row[0].phone).toBe('+27829999999');
  });
});

describe('0129 — crm_tasks keeps lead-less admin tasks working', () => {
  it('rep B still sees their own task with no lead attached', async () => {
    const rows = await as<{ title: string }>(REP_B,
      `select title from crm_tasks where lead_id is null;`);
    expect(rows.map(r => r.title)).toEqual(['B admin task']);
  });

  it('rep A does not see it', async () => {
    const rows = await as<{ title: string }>(REP_A, `select title from crm_tasks where lead_id is null;`);
    expect(rows).toEqual([]);
  });

  it('a rep may create a lead-less task for themselves', async () => {
    await as(REP_A,
      `insert into crm_tasks (lead_id, owner_user_id, type, title)
         values (null, '${REP_A}', 'admin', 'A admin task');`);
    const rows = await as<{ title: string }>(REP_A, `select title from crm_tasks where lead_id is null;`);
    expect(rows.map(r => r.title)).toEqual(['A admin task']);
  });

  it('…but not one owned by somebody else', async () => {
    await expect(as(REP_A,
      `insert into crm_tasks (lead_id, owner_user_id, type, title)
         values (null, '${REP_B}', 'admin', 'planted');`,
    )).rejects.toThrow(/row-level security/i);
  });
});

describe('0129 — crm_saved_views is own-plus-shared', () => {
  it('a rep sees their own views and other reps\' SHARED ones only', async () => {
    const rows = await as<{ name: string }>(REP_A, `select name from crm_saved_views order by name;`);
    expect(rows.map(r => r.name)).toEqual(['A private', 'B shared']);
  });

  it('a rep cannot create a view owned by somebody else', async () => {
    await expect(as(REP_A,
      `insert into crm_saved_views (owner_user_id, name) values ('${REP_B}', 'planted');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('a rep cannot delete another rep\'s shared view', async () => {
    await as(REP_A, `delete from crm_saved_views where name = 'B shared';`);
    const still = await db.query<{ n: number }>(
      `select count(*)::int as n from crm_saved_views where name = 'B shared';`);
    expect(still.rows[0].n).toBe(1);
  });
});

describe('0129 — a dedupe dismissal needs BOTH leads', () => {
  it('a rep who owns one side of the pair sees nothing', async () => {
    expect(await count(REP_A, 'crm_suggestion_dismissals')).toBe(0);
    expect(await count(REP_B, 'crm_suggestion_dismissals')).toBe(0);
  });

  it('an admin sees it', async () => {
    expect(await count(ADMIN, 'crm_suggestion_dismissals')).toBe(1);
  });
});

describe('0129 — crm_email_templates is shared read, admin write', () => {
  it('a rep may read the template library', async () => {
    expect(await count(REP_A, 'crm_email_templates')).toBe(1);
  });

  it('a rep may not edit the copy every rep sends', async () => {
    await as(REP_A, `update crm_email_templates set body = 'hijacked' where name = 'Intro';`);
    const row = await db.query<{ body: string }>(
      `select body from crm_email_templates where name = 'Intro';`);
    expect(row.rows[0].body).toBe('Body');
  });

  it('a rep may not add one', async () => {
    await expect(as(REP_A,
      `insert into crm_email_templates (name, subject, body) values ('X', 'S', 'B');`,
    )).rejects.toThrow(/row-level security/i);
  });

  it('an admin may', async () => {
    await as(ADMIN, `insert into crm_email_templates (name, subject, body) values ('X', 'S', 'B');`);
    expect(await count(ADMIN, 'crm_email_templates')).toBe(2);
  });
});

describe('0129 — crm_leads UPDATE cannot reassign an owner (A-10)', () => {
  it('a rep cannot push their lead onto a colleague', async () => {
    // RAISES rather than silently filtering: the USING clause admits the row
    // (rep A does own lead A), so it is the restored WITH CHECK predicate
    // that rejects the new owner_user_id. Worth asserting the mechanism —
    // a silent no-op here would mean USING had blocked it, which would not
    // be the same fix.
    await expect(as(REP_A,
      `update crm_leads set owner_user_id = '${REP_B}' where id = '${LEAD_A}';`,
    )).rejects.toThrow(/row-level security/i);

    const row = await db.query<{ owner_user_id: string }>(
      `select owner_user_id from crm_leads where id = '${LEAD_A}';`);
    expect(row.rows[0].owner_user_id).toBe(REP_A);
  });

  it('a rep can still edit their own lead\'s fields', async () => {
    await as(REP_A, `update crm_leads set practice_name = 'A Practice (renamed)' where id = '${LEAD_A}';`);
    const row = await as<{ practice_name: string }>(REP_A,
      `select practice_name from crm_leads where id = '${LEAD_A}';`);
    expect(row[0].practice_name).toBe('A Practice (renamed)');
  });

  it('an admin can reassign', async () => {
    await as(ADMIN, `update crm_leads set owner_user_id = '${REP_A}' where id = '${LEAD_B}';`);
    const row = await db.query<{ owner_user_id: string }>(
      `select owner_user_id from crm_leads where id = '${LEAD_B}';`);
    expect(row.rows[0].owner_user_id).toBe(REP_A);
  });
});
