// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real execution test — 0117 address_match_key trigger + dismissals ──
//
// Runs the actual 0117 SQL (the crm_normalise_address_text function,
// the address_match_key trigger, and crm_suggestion_dismissals) against
// a minimal crm_leads/profiles reproduction, proving the trigger fires
// on INSERT/UPDATE and the dismissals table's ordering/uniqueness
// constraints hold — the same house pattern as
// 0107_0111_crm_phase1.rls.test.ts.

const MIG_0117 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0117_crm_address_dedupe.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const BASE = `
  create table profiles (
    id uuid primary key default gen_random_uuid(), role text
  );

  create table crm_leads (
    id                 uuid primary key default gen_random_uuid(),
    practice_name      text not null default 'P',
    street_address     text,
    formatted_address  text,
    suburb             text,
    archived_at        timestamptz
  );
`;

// Strip the RLS block (needs auth.uid()/auth schema we don't need for
// this test) — everything else (columns, the normalise function, the
// trigger, the dismissals table + its CHECK/UNIQUE INDEX) runs as-is.
function withoutRls(sql: string): string {
  const cut = sql.indexOf('ALTER TABLE crm_suggestion_dismissals ENABLE ROW LEVEL SECURITY');
  return cut === -1 ? sql : sql.slice(0, cut);
}

let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BASE);
  await db.exec(withoutRls(MIG_0117));
});

afterAll(async () => { await db.close(); });

describe('crm_leads_set_address_match_key trigger', () => {
  it('populates address_match_key from street_address + suburb on INSERT', async () => {
    const { rows } = await db.query<{ address_match_key: string }>(
      `insert into crm_leads (practice_name, street_address, suburb) values ('A', '5 Oak Rd', 'Sandton') returning address_match_key`,
    );
    expect(rows[0].address_match_key).toBe('5 oak road|sandton');
  });

  it('falls back to formatted_address when street_address is null', async () => {
    const { rows } = await db.query<{ address_match_key: string }>(
      `insert into crm_leads (practice_name, formatted_address, suburb) values ('B', '5 Oak Rd, Sandton', null) returning address_match_key`,
    );
    expect(rows[0].address_match_key).toBe('5 oak road sandton');
  });

  it('strips noise words like "Hospital" so two variants of the same building match', async () => {
    const { rows: r1 } = await db.query<{ address_match_key: string }>(
      `insert into crm_leads (practice_name, street_address) values ('C', 'Life Fourways Hospital') returning address_match_key`,
    );
    const { rows: r2 } = await db.query<{ address_match_key: string }>(
      `insert into crm_leads (practice_name, street_address) values ('D', 'Life Fourways') returning address_match_key`,
    );
    expect(r1[0].address_match_key).toBe(r2[0].address_match_key);
  });

  it('is NULL when there is nothing to key on', async () => {
    const { rows } = await db.query<{ address_match_key: string | null }>(
      `insert into crm_leads (practice_name) values ('E') returning address_match_key`,
    );
    expect(rows[0].address_match_key).toBeNull();
  });

  it('recomputes on UPDATE', async () => {
    const { rows } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name, street_address) values ('F', 'Old Address') returning id`,
    );
    await db.query(`update crm_leads set street_address = '5 Oak Rd' where id = $1`, [rows[0].id]);
    const { rows: after } = await db.query<{ address_match_key: string }>(
      `select address_match_key from crm_leads where id = $1`, [rows[0].id],
    );
    expect(after[0].address_match_key).toBe('5 oak road');
  });
});

describe('crm_suggestion_dismissals', () => {
  it('rejects an insert where lead_a_id > lead_b_id (must be the lower UUID first)', async () => {
    const { rows: leads } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name) values ('X'), ('Y') returning id`,
    );
    const [a, b] = [leads[0].id, leads[1].id].sort();
    // Deliberately reversed — should violate the ordered-pair CHECK.
    await expect(
      db.query(`insert into crm_suggestion_dismissals (lead_a_id, lead_b_id, kind) values ($1, $2, 'duplicate_practice')`, [b, a]),
    ).rejects.toThrow();
  });

  it('accepts the correctly-ordered pair and rejects a duplicate of the same (pair, kind)', async () => {
    const { rows: leads } = await db.query<{ id: string }>(
      `insert into crm_leads (practice_name) values ('X2'), ('Y2') returning id`,
    );
    const [a, b] = [leads[0].id, leads[1].id].sort();
    await db.query(`insert into crm_suggestion_dismissals (lead_a_id, lead_b_id, kind) values ($1, $2, 'duplicate_practice')`, [a, b]);
    await expect(
      db.query(`insert into crm_suggestion_dismissals (lead_a_id, lead_b_id, kind) values ($1, $2, 'duplicate_practice')`, [a, b]),
    ).rejects.toThrow();
  });
});
