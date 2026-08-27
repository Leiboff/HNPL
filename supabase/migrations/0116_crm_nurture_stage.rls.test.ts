// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// ─── Real execution test — nurture stage requires nurture_wake_at (0116) ─
//
// Reproduces crm_leads/crm_activities exactly as they stood immediately
// BEFORE 0116 (stage CHECK without 'nurture', the 0108-shape stage_change
// trigger), then applies 0116's actual DDL — the DROP/ADD CONSTRAINT
// pair, the redefined trigger function, and the new
// crm_leads_nurture_wake_at_required CHECK — and proves the enforcement
// directly against a real Postgres, on both INSERT and UPDATE. Same
// house pattern as 0107_0111_crm_phase1.rls.test.ts.

const BASE = `
  create schema if not exists auth;
  create table _current_user (id uuid);
  create or replace function auth.uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  create table profiles (
    id uuid primary key default gen_random_uuid(), role text
  );

  create table crm_leads (
    id           uuid primary key default gen_random_uuid(),
    practice_name text not null default 'P',
    stage        text not null default 'new'
      check (stage in ('new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost')),
    lost_reason  text,
    created_by   uuid references profiles(id) on delete set null,
    constraint crm_leads_lost_reason_required
      check (stage <> 'lost' or (lost_reason is not null and btrim(lost_reason) <> ''))
  );

  create table crm_activities (
    id          uuid primary key default gen_random_uuid(),
    lead_id     uuid not null references crm_leads(id) on delete cascade,
    type        text not null,
    title       text not null,
    body        text,
    from_stage  text,
    to_stage    text,
    created_by  uuid references profiles(id) on delete set null
  );

  -- Pre-0116 stage_change (0108 shape — no nurture awareness yet).
  create or replace function crm_leads_stage_change()
  returns trigger language plpgsql security definer set search_path = public as $$
  declare
    v_actor uuid := auth.uid();
  begin
    if new.stage = 'lost' and (new.lost_reason is null or btrim(new.lost_reason) = '') then
      raise exception 'crm_leads.lost_reason is required when stage = ''lost''';
    end if;
    if new.stage is distinct from old.stage then
      insert into crm_activities (lead_id, type, title, body, from_stage, to_stage, created_by)
      values (
        new.id, 'stage_change',
        'Stage: ' || old.stage || ' → ' || new.stage,
        case when new.stage = 'lost' then 'Reason: ' || new.lost_reason else null end,
        old.stage, new.stage, v_actor
      );
    end if;
    return new;
  end;
  $$;
  create trigger trg_crm_leads_stage_change
    before update on crm_leads for each row
    when (old.stage is distinct from new.stage)
    execute function crm_leads_stage_change();
`;

// ── 0116, applied verbatim (same shape as the real migration) ─────────
const MIGRATION_0116 = `
  ALTER TABLE crm_leads DROP CONSTRAINT crm_leads_stage_check;
  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_stage_check
    CHECK (stage IN (
      'new', 'contacted', 'meeting_scheduled', 'demo_done',
      'agreement_sent', 'nurture', 'signed', 'onboarded', 'lost'
    ));

  ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS nurture_wake_at TIMESTAMPTZ;

  CREATE OR REPLACE FUNCTION crm_leads_stage_change()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    v_actor UUID := auth.uid();
  BEGIN
    IF NEW.stage = 'lost' AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
      RAISE EXCEPTION 'crm_leads.lost_reason is required when stage = ''lost''';
    END IF;

    IF NEW.stage = 'nurture' AND NEW.nurture_wake_at IS NULL THEN
      RAISE EXCEPTION 'crm_leads.nurture_wake_at is required when stage = ''nurture''';
    END IF;

    IF NEW.stage IS DISTINCT FROM OLD.stage THEN
      INSERT INTO crm_activities (lead_id, type, title, body, from_stage, to_stage, created_by)
      VALUES (
        NEW.id, 'stage_change',
        'Stage: ' || OLD.stage || ' → ' || NEW.stage,
        CASE WHEN NEW.stage = 'lost' THEN 'Reason: ' || NEW.lost_reason ELSE NULL END,
        OLD.stage, NEW.stage, v_actor
      );
    END IF;

    RETURN NEW;
  END;
  $$;

  ALTER TABLE crm_leads ADD CONSTRAINT crm_leads_nurture_wake_at_required
    CHECK (
      stage <> 'nurture' OR nurture_wake_at IS NOT NULL
    );
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIGRATION_0116);
});

afterAll(async () => { await db.close(); });

describe('0116 — entering nurture requires nurture_wake_at', () => {
  it('rejects an INSERT with stage=nurture and no nurture_wake_at (table CHECK)', async () => {
    await expect(
      db.query(`insert into crm_leads (practice_name, stage) values ('A', 'nurture')`),
    ).rejects.toThrow();
  });

  it('accepts an INSERT with stage=nurture when nurture_wake_at is set', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name, stage, nurture_wake_at) values ('B', 'nurture', now() + interval '90 days') returning id`,
    );
    expect(rows).toHaveLength(1);
  });

  it('rejects an UPDATE moving an existing lead to nurture without a wake date (trigger)', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name, stage) values ('C', 'contacted') returning id`,
    );
    await expect(
      db.query(`update crm_leads set stage = 'nurture' where id = $1`, [rows[0].id]),
    ).rejects.toThrow(/nurture_wake_at is required/);
  });

  it('accepts an UPDATE moving an existing lead to nurture with a wake date set in the same statement', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name, stage) values ('D', 'contacted') returning id`,
    );
    await db.query(
      `update crm_leads set stage = 'nurture', nurture_wake_at = now() + interval '60 days' where id = $1`,
      [rows[0].id],
    );
    const { rows: after } = await db.query<{ stage: string }>(`select stage from crm_leads where id = $1`, [rows[0].id]);
    expect(after[0].stage).toBe('nurture');
  });

  it('logs the stage_change activity with to_stage=nurture on a valid transition', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name, stage, nurture_wake_at) values ('E', 'nurture', now() + interval '90 days') returning id`,
    );
    // INSERT doesn't trigger the UPDATE-only stage_change trigger, so
    // move it again to prove the logged row carries to_stage=nurture.
    await db.query(`update crm_leads set stage = 'contacted' where id = $1`, [rows[0].id]);
    await db.query(
      `update crm_leads set stage = 'nurture', nurture_wake_at = now() + interval '60 days' where id = $1`,
      [rows[0].id],
    );
    const { rows: acts } = await db.query<{ to_stage: string }>(
      `select to_stage from crm_activities where lead_id = $1 and to_stage = 'nurture'`,
      [rows[0].id],
    );
    expect(acts.length).toBeGreaterThan(0);
  });
});
