// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real Postgres proof: the manager-write operations themselves are
// ─── NOT the bug (ruling out an RLS/schema sibling of the checkout_
// ─── sessions gap) ─────────────────────────────────────────────────────
//
// The "This page couldn't load" bug on Set PIN / Generate Code turned out
// to be an uncaught TILL_AUTH_PEPPER-missing exception (see
// app/practice/pos/devices/actions.test.ts's "misconfigured environment"
// block for that regression test) — NOT an RLS/constraint gap like the
// checkout_sessions insert bug this investigation was explicitly told to
// check for. This file is the hard evidence for that: it runs the EXACT
// service-role writes generateDeviceRegistrationCode/setTillPin perform —
// INSERT into till_device_registration_codes, UPDATE practices.
// till_pin_hash, UPDATE till_devices.pin_attempts/pin_locked_until — as a
// BYPASSRLS role against real Postgres DDL (extracted verbatim from
// migration 0088, not hand-retyped), proving none of them fail at the
// database layer. Mirrors 0085_checkout_sessions.rls.test.ts's
// service-role-succeeds half exactly.

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

const TILL_DEVICES_DDL = ddlBlock(
  'CREATE TABLE IF NOT EXISTS till_devices',
  '-- ── 2. till_device_registration_codes',
);
const REGISTRATION_CODES_DDL = ddlBlock(
  'CREATE TABLE IF NOT EXISTS till_device_registration_codes',
  '-- ── 3. practices.till_pin_hash',
);
const TILL_PIN_HASH_DDL = ddlBlock(
  'ALTER TABLE practices',
  '-- ── 4. checkout_sessions.issued_via_device_id',
);

const STUB_SCHEMA = `
  create table practices (id uuid primary key default gen_random_uuid());
  create table profiles  (id uuid primary key default gen_random_uuid());
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable as $$ select false $$;
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(TILL_DEVICES_DDL);
  await db.exec(REGISTRATION_CODES_DDL);
  await db.exec(TILL_PIN_HASH_DDL);
  await db.exec(`
    create role service_role_test nologin bypassrls;
    grant select, insert, update, delete on till_devices to service_role_test;
    grant select, insert, update, delete on till_device_registration_codes to service_role_test;
    grant select, update on practices to service_role_test;
  `);
  return db;
}

let practiceId: string;
let userId: string;

async function seed(db: PGlite) {
  const p = await db.query<{ id: string }>(`insert into practices default values returning id`);
  practiceId = p.rows[0].id;
  const u = await db.query<{ id: string }>(`insert into profiles default values returning id`);
  userId = u.rows[0].id;
}

describe('service-role manager writes — the operations generateDeviceRegistrationCode/setTillPin perform', () => {
  let db: PGlite;
  beforeAll(async () => { db = await freshDb(); await seed(db); });

  it('INSERT into till_device_registration_codes succeeds (generateDeviceRegistrationCode)', async () => {
    await db.exec(`set role service_role_test;`);
    await db.query(
      `insert into till_device_registration_codes (practice_id, code_hash, created_by, expires_at)
       values ($1, $2, $3, now() + interval '10 minutes')`,
      [practiceId, 'code-hash-1', userId],
    );
    await db.exec(`reset role;`);
    const { rows } = await db.query(`select code_hash from till_device_registration_codes where practice_id = $1`, [practiceId]);
    expect(rows).toHaveLength(1);
  });

  it('UPDATE practices.till_pin_hash succeeds (setTillPin, step 1)', async () => {
    await db.exec(`set role service_role_test;`);
    await db.query(`update practices set till_pin_hash = $1 where id = $2`, ['pin-hash-1', practiceId]);
    await db.exec(`reset role;`);
    const { rows } = await db.query<{ till_pin_hash: string | null }>(`select till_pin_hash from practices where id = $1`, [practiceId]);
    expect(rows[0].till_pin_hash).toBe('pin-hash-1');
  });

  it('UPDATE till_devices pin_attempts/pin_locked_until reset succeeds (setTillPin, step 2)', async () => {
    await db.exec(`set role service_role_test;`);
    await db.query(
      `insert into till_devices (practice_id, secret_hash, pin_attempts, pin_locked_until)
       values ($1, 'secret-hash-1', 5, now() + interval '15 minutes')`,
      [practiceId],
    );
    await db.query(
      `update till_devices set pin_attempts = 0, pin_locked_until = null where practice_id = $1`,
      [practiceId],
    );
    await db.exec(`reset role;`);
    const { rows } = await db.query<{ pin_attempts: number; pin_locked_until: string | null }>(
      `select pin_attempts, pin_locked_until from till_devices where practice_id = $1`,
      [practiceId],
    );
    expect(rows[0].pin_attempts).toBe(0);
    expect(rows[0].pin_locked_until).toBeNull();
  });
});
