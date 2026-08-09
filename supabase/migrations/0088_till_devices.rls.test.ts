// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RLS enforcement test — till_devices / registration codes ────────
//
// Mirrors 0085_checkout_sessions.rls.test.ts's approach: run the ACTUAL
// table + RLS + policy DDL (extracted verbatim from migration 0088) in a
// real Postgres, with a non-owner role standing in for `authenticated`
// (granted the same broad table-level privileges Supabase grants by
// default) — proving is_practice_manager(), not a missing GRANT, is what
// gates access. is_practice_manager itself is stubbed to a settable GUC
// (same technique as the 0083 rpc test's auth.uid() stub) since its real
// implementation (auth.uid() + practice_members lookup) is tested
// elsewhere — this test is about the NEW policies referencing it
// correctly, not re-proving the helper itself.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0088_till_devices.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

function ddlBlock(startMarker: string, endMarker: string): string {
  const start = MIG.indexOf(startMarker);
  const end   = MIG.indexOf(endMarker);
  if (start < 0 || end < 0) throw new Error('DDL block markers not found in migration 0088');
  return MIG.slice(start, end);
}

// Table + index + RLS + policy DDL only (both tables) — not the
// redeem_till_registration_code function, not the practices/
// checkout_sessions ALTER statements (covered by their own tests).
const TABLES_AND_POLICIES_DDL = ddlBlock(
  'CREATE TABLE IF NOT EXISTS till_devices',
  '-- ── 3. practices.till_pin_hash',
);

const STUB_SCHEMA = `
  create table practices (id uuid primary key default gen_random_uuid());
  create table profiles  (id uuid primary key default gen_random_uuid());
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable as $$ select coalesce(current_setting('test.is_manager', true)::boolean, false) $$;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(TABLES_AND_POLICIES_DDL);
  await db.exec(`
    create role authenticated_test nologin;
    grant select, insert, update, delete on till_devices to authenticated_test;
    grant select, insert, update, delete on till_device_registration_codes to authenticated_test;
  `);
  return db;
}

let practiceId: string;

async function seedPractice(db: PGlite) {
  const p = await db.query<{ id: string }>(`insert into practices default values returning id`);
  practiceId = p.rows[0].id;
}

describe('till_devices RLS — manager-only SELECT/UPDATE, no INSERT policy for anyone', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await seedPractice(db); });

  it('a non-manager cannot SELECT any row', async () => {
    // Seed as the owner (bypasses RLS), then read back as the
    // non-manager role.
    await db.exec(`insert into till_devices (practice_id, secret_hash) values ('${practiceId}', 'h1')`);
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'false', false);`);
    const { rows } = await db.query(`select * from till_devices`);
    await db.exec(`reset role;`);
    expect(rows.length).toBe(0);
  });

  it('a manager-shaped caller CAN SELECT rows at their practice', async () => {
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'true', false);`);
    const { rows } = await db.query(`select * from till_devices`);
    await db.exec(`reset role;`);
    expect(rows.length).toBe(1);
  });

  it('a non-manager cannot revoke (UPDATE) a device', async () => {
    // UPDATE's USING clause (which rows are even visible to the
    // command) evaluating false is NOT an error — it's a silent 0-row
    // match, unlike INSERT's WITH CHECK (which throws). Assert on the
    // actual effect: the row is untouched.
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'false', false);`);
    await db.query(`update till_devices set revoked_at = now() where practice_id = $1`, [practiceId]);
    await db.exec(`reset role;`);
    const { rows } = await db.query<{ revoked_at: string | null }>(`select revoked_at from till_devices where practice_id = $1`, [practiceId]);
    expect(rows[0].revoked_at).toBeNull();
  });

  it('a manager-shaped caller CAN revoke (UPDATE) a device', async () => {
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'true', false);`);
    await db.query(`update till_devices set revoked_at = now() where practice_id = $1`, [practiceId]);
    await db.exec(`reset role;`);
    const { rows } = await db.query<{ revoked_at: string | null }>(`select revoked_at from till_devices where practice_id = $1`, [practiceId]);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it('NO ONE (not even a manager) can INSERT — devices are minted only via the RPC', async () => {
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'true', false);`);
    await expect(
      db.exec(`insert into till_devices (practice_id, secret_hash) values ('${practiceId}', 'h-direct-insert')`),
    ).rejects.toThrow(/row-level security/i);
    await db.exec(`reset role;`);
  });
});

describe('till_device_registration_codes RLS — manager SELECT + INSERT, no UPDATE policy', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await seedPractice(db); });

  it('a non-manager cannot INSERT a registration code', async () => {
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'false', false);`);
    await expect(
      db.exec(`insert into till_device_registration_codes (practice_id, code_hash, expires_at)
                values ('${practiceId}', 'code-1', now() + interval '10 minutes')`),
    ).rejects.toThrow(/row-level security/i);
    await db.exec(`reset role;`);
  });

  it('a manager-shaped caller CAN INSERT a registration code for their own practice', async () => {
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'true', false);`);
    await db.exec(`insert into till_device_registration_codes (practice_id, code_hash, expires_at)
                    values ('${practiceId}', 'code-2', now() + interval '10 minutes')`);
    await db.exec(`reset role;`);
    const { rows } = await db.query(`select code_hash from till_device_registration_codes where code_hash = 'code-2'`);
    expect(rows.length).toBe(1);
  });

  it('NO ONE can UPDATE (mark used) directly — that happens only inside the RPC', async () => {
    // No UPDATE policy exists at all for this table — same silent
    // 0-row-match semantics as the till_devices non-manager case above
    // (a missing policy is not a hard error for UPDATE, unlike INSERT).
    await db.exec(`set role authenticated_test; select set_config('test.is_manager', 'true', false);`);
    await db.query(`update till_device_registration_codes set used_at = now() where code_hash = 'code-2'`);
    await db.exec(`reset role;`);
    const { rows } = await db.query<{ used_at: string | null }>(`select used_at from till_device_registration_codes where code_hash = 'code-2'`);
    expect(rows[0].used_at).toBeNull();
  });
});
