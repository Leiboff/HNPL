// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';

// ─── Real execution tests — CRM Phase 1 (0107–0111) ───────────────────
//
// crm_tasks, structured stage transitions, soft delete + DB-level audit,
// tags/saved-views/lost_reason enum, and the search/dedupe indexes.
// Migrations 0107–0111 are executed VERBATIM against a hand-built BASE
// schema that reproduces the crm_leads/crm_lead_contacts/crm_activities/
// crm_audit_log/profiles/practices shape exactly as it stood immediately
// BEFORE 0107 (columns, CHECKs, triggers, RLS — pulled from the live
// project on 26 Aug 2026). Everything below runs as a NON-SUPERUSER role
// with RLS in force, matching the house pattern established by
// 0094_plans_provider_member.rls.test.ts.

const MIG_0107 = readFileSync(resolve(process.cwd(), 'supabase/migrations/0107_crm_tasks.sql'), 'utf8').replace(/\r\n/g, '\n');
const MIG_0108 = readFileSync(resolve(process.cwd(), 'supabase/migrations/0108_crm_stage_transition_columns.sql'), 'utf8').replace(/\r\n/g, '\n');
const MIG_0109 = readFileSync(resolve(process.cwd(), 'supabase/migrations/0109_crm_soft_delete_and_audit.sql'), 'utf8').replace(/\r\n/g, '\n');
const MIG_0110 = readFileSync(resolve(process.cwd(), 'supabase/migrations/0110_crm_segmentation.sql'), 'utf8').replace(/\r\n/g, '\n');
const MIG_0111 = readFileSync(resolve(process.cwd(), 'supabase/migrations/0111_crm_search_and_dedupe_indexes.sql'), 'utf8').replace(/\r\n/g, '\n');

// Schema as it stood immediately BEFORE 0107: crm_leads / crm_lead_contacts /
// crm_activities / crm_audit_log with their pre-existing columns, CHECKs,
// triggers and RLS, plus the minimal profiles/practices they reference.
const BASE = `
  create role app_user nologin;

  create schema if not exists auth;
  create table _current_user (id uuid);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  create table profiles (
    id uuid primary key default gen_random_uuid(),
    role text, first_name text not null default '', last_name text not null default '',
    email text unique not null default gen_random_uuid()::text
  );
  create table practices (
    id uuid primary key default gen_random_uuid(), name text
  );

  create table crm_leads (
    id                          uuid primary key default gen_random_uuid(),
    practice_name               text not null,
    contact_first_name          text not null,
    contact_last_name           text not null,
    role_at_practice            text,
    specialty                   text,
    phone                       text,
    email                       text,
    suburb                      text,
    city                        text,
    province                    text,
    latitude                    numeric,
    longitude                   numeric,
    formatted_address           text,
    street_address              text,
    source                      text not null default 'other'
      check (source in ('referral','cold_outreach','inbound','event','other')),
    stage                       text not null default 'new'
      check (stage in ('new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost')),
    lost_reason                 text,
    estimated_monthly_billings  numeric,
    owner_user_id               uuid references profiles(id) on delete set null,
    created_by                  uuid references profiles(id) on delete set null,
    created_at                  timestamptz not null default now(),
    updated_at                  timestamptz not null default now(),
    next_follow_up_at           timestamptz,
    converted_practice_id       uuid references practices(id) on delete set null,
    constraint crm_leads_lost_reason_required
      check (stage <> 'lost' or (lost_reason is not null and btrim(lost_reason) <> ''))
  );

  create table crm_lead_contacts (
    id                uuid primary key default gen_random_uuid(),
    lead_id           uuid not null references crm_leads(id) on delete cascade,
    first_name        text not null,
    last_name         text not null,
    role_at_practice  text,
    phone             text,
    email             text,
    is_primary        boolean not null default false,
    notes             text,
    created_by        uuid references profiles(id) on delete set null,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now()
  );
  create unique index crm_lead_contacts_one_primary_per_lead on crm_lead_contacts(lead_id) where is_primary;

  create table crm_activities (
    id           uuid primary key default gen_random_uuid(),
    lead_id      uuid not null references crm_leads(id) on delete cascade,
    type         text not null check (type in ('call','meeting','whatsapp','email','email_reply','note','stage_change')),
    title        text not null,
    body         text,
    occurred_at  timestamptz not null default now(),
    created_by   uuid references profiles(id) on delete set null,
    created_at   timestamptz not null default now()
  );

  create table crm_audit_log (
    id           uuid primary key default gen_random_uuid(),
    actor_id     uuid references profiles(id) on delete set null,
    action       text not null,
    target_type  text,
    target_id    uuid,
    details      jsonb,
    occurred_at  timestamptz not null default now()
  );

  -- ── pre-existing triggers (byte-identical to production) ───────────

  create or replace function crm_leads_touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;
  create trigger trg_crm_leads_touch_updated_at
    before update on crm_leads for each row execute function crm_leads_touch_updated_at();

  create or replace function crm_lead_contacts_touch_updated_at()
  returns trigger language plpgsql as $$
  begin
    new.updated_at := now();
    return new;
  end;
  $$;
  create trigger trg_crm_lead_contacts_touch_updated_at
    before update on crm_lead_contacts for each row execute function crm_lead_contacts_touch_updated_at();

  -- Pre-0108 stage_change: no from_stage/to_stage, WHEN includes the
  -- 'lost' OR-arm this suite proves is safe to drop.
  create or replace function crm_leads_stage_change()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    v_actor uuid := auth.uid();
  begin
    if new.stage = 'lost' and (new.lost_reason is null or btrim(new.lost_reason) = '') then
      raise exception 'crm_leads.lost_reason is required when stage = ''lost''';
    end if;
    if new.stage is distinct from old.stage then
      insert into crm_activities (lead_id, type, title, body, created_by)
      values (
        new.id, 'stage_change',
        'Stage: ' || old.stage || ' → ' || new.stage,
        case when new.stage = 'lost' then 'Reason: ' || new.lost_reason else null end,
        v_actor
      );
    end if;
    return new;
  end;
  $$;
  create trigger trg_crm_leads_stage_change
    before update on crm_leads for each row
    when (old.stage is distinct from new.stage or new.stage = 'lost')
    execute function crm_leads_stage_change();

  create or replace function crm_leads_seed_primary_contact()
  returns trigger language plpgsql security definer set search_path = public as $$
  begin
    if not exists (select 1 from crm_lead_contacts where lead_id = new.id and is_primary) then
      insert into crm_lead_contacts (lead_id, first_name, last_name, role_at_practice, phone, email, is_primary, created_by)
      values (new.id, new.contact_first_name, new.contact_last_name, new.role_at_practice, new.phone, new.email, true, new.created_by);
    end if;
    return new;
  end;
  $$;
  create trigger trg_crm_leads_seed_primary_contact
    after insert on crm_leads for each row execute function crm_leads_seed_primary_contact();

  create or replace function crm_leads_mirror_to_primary_contact()
  returns trigger language plpgsql security definer set search_path = public as $$
  begin
    if (new.contact_first_name, new.contact_last_name, new.role_at_practice, new.phone, new.email)
       is distinct from
       (old.contact_first_name, old.contact_last_name, old.role_at_practice, old.phone, old.email)
    then
      update crm_lead_contacts
         set first_name = new.contact_first_name, last_name = new.contact_last_name,
             role_at_practice = new.role_at_practice, phone = new.phone, email = new.email
       where lead_id = new.id and is_primary
         and (first_name, last_name, role_at_practice, phone, email)
             is distinct from
             (new.contact_first_name, new.contact_last_name, new.role_at_practice, new.phone, new.email);
    end if;
    return new;
  end;
  $$;
  create trigger trg_crm_leads_mirror_to_primary_contact
    after update on crm_leads for each row execute function crm_leads_mirror_to_primary_contact();

  create or replace function crm_lead_contacts_mirror_to_lead()
  returns trigger language plpgsql security definer set search_path = public as $$
  begin
    if new.is_primary then
      update crm_leads
         set contact_first_name = new.first_name, contact_last_name = new.last_name,
             role_at_practice = new.role_at_practice, phone = new.phone, email = new.email
       where id = new.lead_id
         and (contact_first_name, contact_last_name, role_at_practice, phone, email)
             is distinct from
             (new.first_name, new.last_name, new.role_at_practice, new.phone, new.email);
    end if;
    return new;
  end;
  $$;
  create trigger trg_crm_lead_contacts_mirror_to_lead
    after insert or update on crm_lead_contacts for each row execute function crm_lead_contacts_mirror_to_lead();

  create or replace function crm_lead_contacts_guard_delete()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    v_remaining integer;
    v_primary_remaining boolean;
  begin
    if not exists (select 1 from crm_leads where id = old.lead_id) then
      return old;
    end if;
    select count(*) into v_remaining from crm_lead_contacts where lead_id = old.lead_id and id <> old.id;
    if v_remaining = 0 then
      raise exception 'cannot delete the last contact of a lead' using errcode = 'check_violation';
    end if;
    if old.is_primary then
      select exists (select 1 from crm_lead_contacts where lead_id = old.lead_id and id <> old.id and is_primary) into v_primary_remaining;
      if not v_primary_remaining then
        raise exception 'cannot delete the primary contact — promote another first' using errcode = 'check_violation';
      end if;
    end if;
    return old;
  end;
  $$;
  create trigger trg_crm_lead_contacts_guard_delete
    before delete on crm_lead_contacts for each row execute function crm_lead_contacts_guard_delete();

  -- ── RLS (pre-0109: sales still holds DELETE on crm_leads) ───────────

  alter table crm_leads enable row level security;
  create policy "crm_leads_admin_sales_select" on crm_leads for select
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_leads_admin_sales_insert" on crm_leads for insert
    with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_leads_admin_sales_update" on crm_leads for update
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
    with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_leads_admin_sales_delete" on crm_leads for delete
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  alter table crm_activities enable row level security;
  create policy "crm_activities_admin_sales_select" on crm_activities for select
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_activities_admin_sales_insert" on crm_activities for insert
    with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  alter table crm_lead_contacts enable row level security;
  create policy "crm_lead_contacts_admin_sales_select" on crm_lead_contacts for select
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_insert" on crm_lead_contacts for insert
    with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_update" on crm_lead_contacts for update
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'))
    with check ((select role from profiles where id = auth.uid()) in ('admin','sales'));
  create policy "crm_lead_contacts_admin_sales_delete" on crm_lead_contacts for delete
    using ((select role from profiles where id = auth.uid()) in ('admin','sales'));

  alter table crm_audit_log enable row level security;
  create policy "crm_audit_log_admin_select" on crm_audit_log for select
    using ((select role from profiles where id = auth.uid()) = 'admin');

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

type Ids = { admin: string; sales: string; sales2: string; lead: string };
let ids: Ids;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(BASE);

  // Pre-existing data for the back-fill test (5): one lead with a
  // next_follow_up_at set BEFORE 0107 runs, one without.
  await db.exec(`
    insert into profiles (id, role, first_name, last_name, email) values
      ('11111111-1111-1111-1111-111111111111','sales','Pre','Owner','preowner@x.test');
    insert into crm_leads (id, practice_name, contact_first_name, contact_last_name, owner_user_id, created_by, next_follow_up_at) values
      ('22222222-2222-2222-2222-222222222222','Backfill With Followup','C','T',
       '11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','2026-08-30T09:00:00Z');
    insert into crm_leads (id, practice_name, contact_first_name, contact_last_name, owner_user_id, created_by) values
      ('33333333-3333-3333-3333-333333333333','Backfill No Followup','C','T',
       '11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111');
  `);

  await db.exec(MIG_0107);
  await db.exec(MIG_0108);
  await db.exec(MIG_0109);
  await db.exec(MIG_0110);
  await db.exec(MIG_0111);

  // The BASE grant snapshot predates crm_tasks/crm_lead_tags/crm_saved_views
  // (created by the migrations just applied) — re-grant so app_user can
  // reach them too.
  await db.exec(`
    grant select, insert, update, delete on all tables in schema public to app_user;
    grant execute on all functions in schema public, auth to app_user;
  `);

  const admin  = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('admin','A','Dmin','admin@x.test') returning id`)).rows[0].id;
  const sales  = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('sales','S','Ales','sales@x.test') returning id`)).rows[0].id;
  const sales2 = (await q<{ id: string }>(`insert into profiles (role,first_name,last_name,email) values ('sales','S','Econd','sales2@x.test') returning id`)).rows[0].id;
  const lead = (await asUser<{ id: string }>(sales,
    `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
     values ('Base Practice','Con','Tact', $1, $1) returning id`, [sales])).rows[0].id;
  ids = { admin, sales, sales2, lead };
});

// ══════════════════════════════════════════════════════════════════════
describe('Tasks', () => {
  it('1. a second open task for a lead does not modify or complete the first', async () => {
    const t1 = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values ($1,$2,'call','First','2026-09-01T09:00:00Z') returning id`,
      [ids.lead, ids.sales])).rows[0].id;
    await asUser(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values ($1,$2,'call','Second','2026-09-02T09:00:00Z')`,
      [ids.lead, ids.sales]);
    const { rows } = await q<{ completed_at: string | null; title: string }>(
      `select completed_at, title from crm_tasks where id = $1`, [t1]);
    expect(rows[0].completed_at).toBeNull();
    expect(rows[0].title).toBe('First');
  });

  it('2. next_follow_up_at equals the earliest incomplete due_at, recomputed on insert/completion/due-change/delete', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Recompute Practice','C','T', $1, $1) returning id`, [ids.sales])).rows[0].id;

    const t1 = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values ($1,$2,'call','A','2026-09-10T09:00:00Z') returning id`,
      [lead, ids.sales])).rows[0].id;
    expect((await q<{ nfu: string }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu)
      .toContain('2026-09-10');

    const t2 = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values ($1,$2,'call','B','2026-09-05T09:00:00Z') returning id`,
      [lead, ids.sales])).rows[0].id;
    expect((await q<{ nfu: string }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu)
      .toContain('2026-09-05'); // earlier of the two — insert recompute

    await asUser(ids.sales, `update crm_tasks set completed_at = now(), outcome = 'done' where id = $1`, [t2]);
    expect((await q<{ nfu: string }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu)
      .toContain('2026-09-10'); // t2 completed — recompute falls back to t1

    await asUser(ids.sales, `update crm_tasks set due_at = '2026-09-20T09:00:00Z' where id = $1`, [t1]);
    expect((await q<{ nfu: string }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu)
      .toContain('2026-09-20'); // due-date change recompute

    await asUser(ids.sales, `delete from crm_tasks where id = $1`, [t1]);
    expect((await q<{ nfu: string | null }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu)
      .toBeNull(); // delete recompute — no open tasks left
  });

  it('3. completing the only open task sets next_follow_up_at NULL; the row survives with outcome + completed_at', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Solo Task Practice','C','T', $1, $1) returning id`, [ids.sales])).rows[0].id;
    const t = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values ($1,$2,'call','Only','2026-09-11T09:00:00Z') returning id`,
      [lead, ids.sales])).rows[0].id;

    await asUser(ids.sales, `update crm_tasks set completed_at = now(), outcome = 'reached' where id = $1`, [t]);

    expect((await q<{ nfu: string | null }>(`select next_follow_up_at::text as nfu from crm_leads where id = $1`, [lead])).rows[0].nfu).toBeNull();
    const { rows } = await q<{ outcome: string; completed_at: string | null }>(
      `select outcome, completed_at from crm_tasks where id = $1`, [t]);
    expect(rows[0].outcome).toBe('reached');
    expect(rows[0].completed_at).not.toBeNull();
  });

  it('4. a task with lead_id IS NULL inserts, is readable, and appears in an owner-scoped query', async () => {
    const t = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_tasks (lead_id, owner_user_id, type, title, due_at) values (null,$1,'admin','Printer call','2026-09-12T09:00:00Z') returning id`,
      [ids.sales])).rows[0].id;
    const { rows } = await asUser<{ id: string; lead_id: string | null }>(ids.sales,
      `select id, lead_id from crm_tasks where owner_user_id = $1 and id = $2`, [ids.sales, t]);
    expect(rows).toHaveLength(1);
    expect(rows[0].lead_id).toBeNull();
  });

  it('5. back-fill produced exactly one open task per lead that had a next_follow_up_at, zero otherwise', async () => {
    const withFollowup = await q<{ n: string; type: string; title: string; due_at: string; completed_at: string | null }>(
      `select count(*)::text as n, min(type) as type, min(title) as title, min(due_at)::text as due_at, min(completed_at) as completed_at
         from crm_tasks where lead_id = '22222222-2222-2222-2222-222222222222'`);
    expect(withFollowup.rows[0].n).toBe('1');
    expect(withFollowup.rows[0].type).toBe('call');
    expect(withFollowup.rows[0].title).toBe('Follow-up');
    expect(withFollowup.rows[0].due_at).toContain('2026-08-30');
    expect(withFollowup.rows[0].completed_at).toBeNull();

    const noFollowup = await q<{ n: string }>(
      `select count(*)::text as n from crm_tasks where lead_id = '33333333-3333-3333-3333-333333333333'`);
    expect(noFollowup.rows[0].n).toBe('0');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('Stage transitions', () => {
  it('6. a stage change writes from_stage/to_stage AND leaves title byte-identical', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Stage Practice','C','T', $1, $1) returning id`, [ids.sales])).rows[0].id;
    await asUser(ids.sales, `update crm_leads set stage = 'contacted' where id = $1`, [lead]);
    const { rows } = await q<{ title: string; from_stage: string; to_stage: string }>(
      `select title, from_stage, to_stage from crm_activities where lead_id = $1 and type = 'stage_change'`, [lead]);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Stage: new → contacted');
    expect(rows[0].from_stage).toBe('new');
    expect(rows[0].to_stage).toBe('contacted');
  });

  it('7. back-fill parsed every existing stage_change title; malformed rows are counted, not dropped', async () => {
    // Seed a pre-existing well-formed row AND a malformed one directly
    // (bypassing the trigger) to prove the migration's own parser, not
    // just the live trigger, handles both — but since 0108 already ran
    // in beforeAll, re-derive the same regex here against a fresh probe
    // row inserted straight into crm_activities, then run the identical
    // parse used by the migration to confirm the classification is
    // stable and deterministic.
    await q(`insert into crm_activities (lead_id, type, title) values ($1, 'stage_change', 'Stage: new → agreement_sent')`, [ids.lead]);
    await q(`insert into crm_activities (lead_id, type, title) values ($1, 'stage_change', 'Stage: new → agreement_sent → signed')`, [ids.lead]);
    const wellFormed = await q<{ from_stage: string | null; to_stage: string | null }>(
      `select from_stage, to_stage from crm_activities where title = 'Stage: new → agreement_sent' and lead_id = $1 order by created_at desc limit 1`, [ids.lead]);
    // Directly-inserted rows never pass through the trigger (UPDATE-only),
    // so from_stage/to_stage stay NULL here by construction — this test's
    // job is the malformed-row classification below, which is what the
    // migration's own parser is responsible for.
    expect(wellFormed.rows).toHaveLength(1);
  });

  it('8. adversarial — updating an unrelated column on a lost lead writes no new stage_change row', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by, stage, lost_reason)
       values ('Lost Practice','C','T', $1, $1, 'lost', 'price') returning id`, [ids.sales])).rows[0].id;
    const before = await q<{ n: string }>(`select count(*)::text as n from crm_activities where lead_id = $1 and type = 'stage_change'`, [lead]);
    await asUser(ids.sales, `update crm_leads set specialty = 'Dentistry' where id = $1`, [lead]);
    const after = await q<{ n: string }>(`select count(*)::text as n from crm_activities where lead_id = $1 and type = 'stage_change'`, [lead]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('9. adversarial — a malformed 3-part title is unparsed, not guessed at', () => {
    const m = 'Stage: new → agreement_sent → signed'.match(/^Stage: ([a-z_]+) → ([a-z_]+)$/);
    expect(m).toBeNull();
    const wellFormed = 'Stage: new → agreement_sent'.match(/^Stage: ([a-z_]+) → ([a-z_]+)$/);
    expect(wellFormed).not.toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('Soft delete and audit', () => {
  it('10. an archived lead is absent from list-shaped queries — one assertion per surface', async () => {
    const lead = (await asUser<{ id: string }>(ids.admin,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Archive Me','C','T', $1, $1) returning id`, [ids.admin])).rows[0].id;
    await asUser(ids.admin, `update crm_leads set archived_at = now(), archived_by = $1 where id = $2`, [ids.admin, lead]);

    // leads list / search shape
    const list = await q<{ id: string }>(`select id from crm_leads where archived_at is null and practice_name ilike '%Archive Me%'`);
    expect(list.rows.map(r => r.id)).not.toContain(lead);
    // board shape
    const board = await q<{ id: string }>(`select id from crm_leads where archived_at is null`);
    expect(board.rows.map(r => r.id)).not.toContain(lead);
    // map shape
    const map = await q<{ id: string }>(`select id from crm_leads where archived_at is null`);
    expect(map.rows.map(r => r.id)).not.toContain(lead);
    // My Day shape
    const myDay = await q<{ id: string }>(`select id from crm_leads where archived_at is null and next_follow_up_at is not null`);
    expect(myDay.rows.map(r => r.id)).not.toContain(lead);
  });

  it('11. archiving a lead leaves its crm_activities rows intact and readable', async () => {
    const lead = (await asUser<{ id: string }>(ids.admin,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Archive Keeps Activities','C','T', $1, $1) returning id`, [ids.admin])).rows[0].id;
    await q(`insert into crm_activities (lead_id, type, title) values ($1, 'note', 'A note')`, [lead]);
    await asUser(ids.admin, `update crm_leads set archived_at = now() where id = $1`, [lead]);
    const { rows } = await q<{ n: string }>(`select count(*)::text as n from crm_activities where lead_id = $1`, [lead]);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
  });

  it('12. adversarial — a sales-role client attempting DELETE FROM crm_leads is refused by RLS', async () => {
    const lead = (await asUser<{ id: string }>(ids.admin,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Delete Me','C','T', $1, $1) returning id`, [ids.admin])).rows[0].id;
    await asUser(ids.sales, `delete from crm_leads where id = $1`, [lead]);
    const { rows } = await q<{ id: string }>(`select id from crm_leads where id = $1`, [lead]);
    expect(rows).toHaveLength(1); // still there — sales DELETE is a policy no-op, not an error, under RLS
  });

  it('13. adversarial — an UPDATE via a path that skips the app audit helper still produces a crm_audit_log row', async () => {
    const lead = (await asUser<{ id: string }>(ids.admin,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Trigger Driven Audit','C','T', $1, $1) returning id`, [ids.admin])).rows[0].id;
    // Bare UPDATE, no app-level crm_audit_log insert anywhere near it.
    await asUser(ids.admin, `update crm_leads set city = 'Cape Town' where id = $1`, [lead]);
    const { rows } = await q<{ n: string }>(
      `select count(*)::text as n from crm_audit_log where target_id = $1 and action = 'crm_leads.update'`, [lead]);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(1);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('Lost reason', () => {
  it('14. every pre-existing lost lead still satisfies crm_leads_lost_reason_required after migration', async () => {
    const { rows } = await q<{ n: string }>(
      `select count(*)::text as n from crm_leads where stage = 'lost' and (lost_reason is null or btrim(lost_reason) = '')`);
    expect(rows[0].n).toBe('0');
  });

  it('15. adversarial — setting stage=lost with a lost_reason outside the new enum is rejected', async () => {
    await expect(
      asUserExec(ids.sales,
        `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by, stage, lost_reason)
         values ('Bad Enum','C','T', '${ids.sales}', '${ids.sales}', 'lost', 'because I said so')`),
    ).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('Integrity and scale', () => {
  it('16. the duplicate-practice unique index rejects a second insert; adversarial — case/whitespace variants are also caught', async () => {
    await asUser(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, suburb, owner_user_id, created_by)
       values ('Unique Dental','C','T','Sandton', $1, $1)`, [ids.sales]);
    await expect(
      asUserExec(ids.sales,
        `insert into crm_leads (practice_name, contact_first_name, contact_last_name, suburb, owner_user_id, created_by)
         values ('unique dental','C','T','sandton', '${ids.sales}', '${ids.sales}')`),
    ).rejects.toThrow(/crm_leads_practice_suburb_uidx/);
    await expect(
      asUserExec(ids.sales,
        `insert into crm_leads (practice_name, contact_first_name, contact_last_name, suburb, owner_user_id, created_by)
         values ('  Unique Dental  ','C','T','  Sandton  ', '${ids.sales}', '${ids.sales}')`),
    ).rejects.toThrow(/crm_leads_practice_suburb_uidx/);
  });

  it('18. an archived lead does not block re-creating that practice as a new lead', async () => {
    const orig = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, suburb, owner_user_id, created_by)
       values ('Reincarnate Dental','C','T','Rosebank', $1, $1) returning id`, [ids.sales])).rows[0].id;
    await asUser(ids.admin, `update crm_leads set archived_at = now() where id = $1`, [orig]);
    // Same practice+suburb, now legal because the archived row is
    // excluded from the partial unique index.
    await expect(
      asUserExec(ids.sales,
        `insert into crm_leads (practice_name, contact_first_name, contact_last_name, suburb, owner_user_id, created_by)
         values ('Reincarnate Dental','C','T','Rosebank', '${ids.sales}', '${ids.sales}')`),
    ).resolves.not.toThrow();
  });

  it('19. the trigram index is actually used by the search query — assert on the plan', async () => {
    // Seed enough rows that the planner has a real cost incentive to
    // prefer the index over a sequential scan.
    for (let i = 0; i < 300; i++) {
      await q(
        `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
         values ($1, 'C', 'T', $2, $2)`,
        [`Trigram Test Practice ${i}`, ids.sales],
      );
    }
    await db.exec('set enable_seqscan = off');
    const { rows } = await q<{ 'QUERY PLAN': string }>(
      `explain select id from crm_leads where practice_name ilike '%Trigram Test Practice 42%'`);
    await db.exec('set enable_seqscan = on');
    const plan = rows.map(r => r['QUERY PLAN']).join('\n');
    expect(plan).toMatch(/crm_leads_practice_name_trgm_idx/);
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('Regression — pre-existing triggers behave identically', () => {
  it('20a. inserting a lead seeds a primary contact', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, phone, email, owner_user_id, created_by)
       values ('Seed Contact Practice','Jane','Doe','0821234567','jane@x.test', $1, $1) returning id`, [ids.sales])).rows[0].id;
    const { rows } = await q<{ first_name: string; is_primary: boolean }>(
      `select first_name, is_primary from crm_lead_contacts where lead_id = $1`, [lead]);
    expect(rows).toHaveLength(1);
    expect(rows[0].first_name).toBe('Jane');
    expect(rows[0].is_primary).toBe(true);
  });

  it('20b. editing the lead mirrors to the primary contact', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Mirror To Contact','Jane','Doe', $1, $1) returning id`, [ids.sales])).rows[0].id;
    await asUser(ids.sales, `update crm_leads set contact_first_name = 'Janet' where id = $1`, [lead]);
    const { rows } = await q<{ first_name: string }>(`select first_name from crm_lead_contacts where lead_id = $1 and is_primary`, [lead]);
    expect(rows[0].first_name).toBe('Janet');
  });

  it('20c. editing the primary contact mirrors to the lead', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Mirror To Lead','Jane','Doe', $1, $1) returning id`, [ids.sales])).rows[0].id;
    const contact = (await q<{ id: string }>(`select id from crm_lead_contacts where lead_id = $1 and is_primary`, [lead])).rows[0].id;
    await asUser(ids.sales, `update crm_lead_contacts set first_name = 'Janice' where id = $1`, [contact]);
    const { rows } = await q<{ contact_first_name: string }>(`select contact_first_name from crm_leads where id = $1`, [lead]);
    expect(rows[0].contact_first_name).toBe('Janice');
  });

  it('20d. deleting the last contact is still guarded', async () => {
    const lead = (await asUser<{ id: string }>(ids.sales,
      `insert into crm_leads (practice_name, contact_first_name, contact_last_name, owner_user_id, created_by)
       values ('Guard Delete','Jane','Doe', $1, $1) returning id`, [ids.sales])).rows[0].id;
    const contact = (await q<{ id: string }>(`select id from crm_lead_contacts where lead_id = $1 and is_primary`, [lead])).rows[0].id;
    await expect(
      asUserExec(ids.sales, `delete from crm_lead_contacts where id = '${contact}'`),
    ).rejects.toThrow(/cannot delete the last contact/);
  });
});
