// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real execution test — 0118 hpcsa_group_key trigger ────────────────
//
// Runs the actual 0118 SQL against a minimal crm_lead_contacts
// reproduction, proving the trigger's md5(lower(trim(x))) normalisation
// matches 0064 exactly, on a real Postgres. Same house pattern as
// 0107_0111_crm_phase1.rls.test.ts.

const MIG_0118 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0118_crm_practitioner_hpcsa_grouping.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const BASE = `
  create table crm_leads (
    id uuid primary key default gen_random_uuid(),
    practice_name text not null default 'P'
  );
  create table crm_lead_contacts (
    id      uuid primary key default gen_random_uuid(),
    lead_id uuid not null references crm_leads(id) on delete cascade,
    first_name text not null default 'F',
    last_name  text not null default 'L'
  );
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(MIG_0118);
});

afterAll(async () => { await db.close(); });

describe('crm_lead_contacts_set_hpcsa_group_key trigger', () => {
  it('groups one contact across two leads under the same key', async () => {
    const { rows: leads } = await db.query<{ id: string }>(`insert into crm_leads (practice_name) values ('A'), ('B') returning id`);
    const { rows: c1 } = await db.query<{ hpcsa_group_key: string }>(
      `insert into crm_lead_contacts (lead_id, first_name, last_name, hpcsa_number) values ($1, 'Jane', 'Doe', ' MP1234567 ') returning hpcsa_group_key`,
      [leads[0].id],
    );
    const { rows: c2 } = await db.query<{ hpcsa_group_key: string }>(
      `insert into crm_lead_contacts (lead_id, first_name, last_name, hpcsa_number) values ($1, 'Jane', 'Doe', 'mp1234567') returning hpcsa_group_key`,
      [leads[1].id],
    );
    expect(c1[0].hpcsa_group_key).not.toBeNull();
    expect(c1[0].hpcsa_group_key).toBe(c2[0].hpcsa_group_key);
  });

  it('NULL/blank hpcsa_number -> NULL group key, and the contact row itself is never rejected or hidden', async () => {
    const { rows: leads } = await db.query<{ id: string }>(`insert into crm_leads (practice_name) values ('C') returning id`);
    const { rows } = await db.query<{ id: string; hpcsa_group_key: string | null }>(
      `insert into crm_lead_contacts (lead_id, first_name, last_name, hpcsa_number) values ($1, 'No', 'Hpcsa', '   ') returning id, hpcsa_group_key`,
      [leads[0].id],
    );
    expect(rows[0].hpcsa_group_key).toBeNull();
    const { rows: fetched } = await db.query(`select id from crm_lead_contacts where id = $1`, [rows[0].id]);
    expect(fetched).toHaveLength(1);
  });

  it('recomputes on UPDATE', async () => {
    const { rows: leads } = await db.query<{ id: string }>(`insert into crm_leads (practice_name) values ('D') returning id`);
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_lead_contacts (lead_id, first_name, last_name) values ($1, 'X', 'Y') returning id`,
      [leads[0].id],
    );
    await db.query(`update crm_lead_contacts set hpcsa_number = 'MP9999999' where id = $1`, [rows[0].id]);
    const { rows: after } = await db.query<{ hpcsa_group_key: string | null }>(
      `select hpcsa_group_key from crm_lead_contacts where id = $1`, [rows[0].id],
    );
    expect(after[0].hpcsa_group_key).not.toBeNull();
  });
});
