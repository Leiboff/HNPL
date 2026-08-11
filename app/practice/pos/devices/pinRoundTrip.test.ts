// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Part 1 investigation: does DeviceAdminView's PIN generate/reset show
// ─── a THIRD instance of the salary-date/phone-editor stale-display bug
// ─── (field re-renders the OLD pre-mutation value instead of what was
// ─── just written)? ─────────────────────────────────────────────────────
//
// Traced by hand first (DeviceAdminView.tsx): pinInput is a plain
// useState set DIRECTLY from generateTillPinValue's response
// (`setPinInput(result.pin)`) or from manual typing — it is NEVER reset
// to a stale prop/initial value the way the fixed salary-date and phone
// editors were. PinInput's `value` is fully controlled from that same
// state, and handleSetPin's onSubmit reads that identical state variable
// into setTillPin(pinInput, ...). So: NOT a recurrence of that pattern —
// there is no prop-derived display to go stale in the first place.
//
// That rules out the specific known-pattern hypothesis, but doesn't by
// itself PROVE displayed === stored === unlock-accepted without reversing
// a hash. This file is that proof: it calls the three REAL exported
// functions — generateTillPinValue, setTillPin (app/practice/pos/devices/
// actions.ts), unlockTill (app/practice/pos/actions.ts) — completely
// unmodified, against a real Postgres schema (till_devices/practices DDL
// extracted verbatim from migration 0088, same extraction helper as
// 0088_till_devices.manager_writes.rls.test.ts) instead of a hand-rolled
// mock of the hashing logic. No test anywhere in the existing suite
// chains all three — devices/actions.test.ts and unlockTill.test.ts each
// exercise setTillPin/unlockTill in ISOLATION against independently
// seeded hashes, which proves each function is internally consistent but
// never proves the handoff between them.

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

const TILL_DEVICES_DDL  = ddlBlock('CREATE TABLE IF NOT EXISTS till_devices', '-- ── 2. till_device_registration_codes');
const TILL_PIN_HASH_DDL = ddlBlock('ALTER TABLE practices', '-- ── 4. checkout_sessions.issued_via_device_id');

const STUB_SCHEMA = `
  create table practices (id uuid primary key default gen_random_uuid());
  create table profiles  (id uuid primary key default gen_random_uuid());
  create table practice_members (
    user_id             uuid not null,
    practice_id         uuid not null,
    active              boolean not null default true,
    can_manage_practice boolean not null default false
  );
  -- Referenced by till_devices' CREATE POLICY statements below (migration
  -- 0088's actual function, not redefined here). We run every query as
  -- the pglite default superuser, which bypasses RLS unconditionally, so
  -- this stub only needs to exist for CREATE POLICY to parse — its
  -- return value is never actually consulted in this test.
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable as $$ select true $$;
`;

let db: PGlite;

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.query<T>(sql, params);
}

// Generic Supabase-JS-shaped client backed by REAL SQL against pglite —
// same .from/.select/.eq/.maybeSingle/.update surface the actual actions
// call, translated to parameterized queries instead of an in-memory array.
function makeSqlClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.maybeSingle = async () => {
        const where = filters.map((f, i) => `${f[0]} = $${i + 1}`).join(' and ') || 'true';
        const { rows } = await q(`select * from ${table} where ${where} limit 1`, filters.map((f) => f[1]));
        return { data: rows[0] ?? null, error: null };
      };
      b.update = (patch: Record<string, unknown>) => ({
        eq: async (c: string, v: unknown) => {
          const cols = Object.keys(patch);
          const setClause = cols.map((k, i) => `${k} = $${i + 1}`).join(', ');
          await q(`update ${table} set ${setClause} where ${c} = $${cols.length + 1}`, [...cols.map((k) => patch[k]), v]);
          return { data: null, error: null };
        },
      });
      return b;
    },
  };
}

const MANAGER_ID = '11111111-1111-1111-1111-111111111111';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => makeSqlClient()),
}));
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: async () => ({ data: { user: { id: MANAGER_ID } } }) },
    from: makeSqlClient().from,
  })),
}));

let practiceId: string;
let deviceId: string;
const DEVICE_SECRET = 'device-secret-for-round-trip';

beforeEach(async () => {
  process.env.TILL_AUTH_PEPPER          = 'roundtrip-test-pepper';
  process.env.NEXT_PUBLIC_SUPABASE_URL  = 'http://localhost';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(TILL_DEVICES_DDL);
  await db.exec(TILL_PIN_HASH_DDL);

  const { hashTillSecret } = await import('@/lib/auth/tillDevice');
  const p = await q<{ id: string }>('insert into practices default values returning id');
  practiceId = p.rows[0].id;
  await q(
    'insert into practice_members (user_id, practice_id, active, can_manage_practice) values ($1, $2, true, true)',
    [MANAGER_ID, practiceId],
  );
  const d = await q<{ id: string }>(
    'insert into till_devices (practice_id, secret_hash) values ($1, $2) returning id',
    [practiceId, hashTillSecret(DEVICE_SECRET)],
  );
  deviceId = d.rows[0].id;
});

describe('PIN generate/reset -> unlock — real round trip through the actual server actions', () => {
  it('the exact PIN generateTillPinValue returns (what the manager sees) is exactly the PIN that unlocks the till', async () => {
    const { generateTillPinValue, setTillPin } = await import('./actions');
    const { unlockTill } = await import('../actions');

    const generated = await generateTillPinValue(practiceId);
    expect(generated.error).toBeNull();
    const displayedPin = generated.pin!;
    expect(displayedPin).toMatch(/^\d{6}$/);

    const setResult = await setTillPin(displayedPin, practiceId);
    expect(setResult.error).toBeNull();

    // This is the assertion that would have failed under the
    // salary-date/phone-editor pattern: unlock with EXACTLY the value the
    // UI would have displayed, not a value re-derived from anywhere else.
    const unlockResult = await unlockTill(DEVICE_SECRET, displayedPin);
    expect(unlockResult.error).toBeNull();

    const { rows } = await q<{ unlocked_at: string | null }>(
      'select unlocked_at from till_devices where id = $1', [deviceId],
    );
    expect(rows[0].unlocked_at).toBeTruthy();
  });

  it('adversarial: resetting an existing PIN invalidates the OLD PIN — only the newly displayed PIN unlocks', async () => {
    const { generateTillPinValue, setTillPin } = await import('./actions');
    const { unlockTill } = await import('../actions');

    // An existing PIN is already configured (set directly, not via the
    // generator, to keep this test's outcome independent of the RNG).
    const OLD_PIN = '111111';
    await setTillPin(OLD_PIN, practiceId);
    const oldUnlock = await unlockTill(DEVICE_SECRET, OLD_PIN);
    expect(oldUnlock.error).toBeNull(); // prove it genuinely worked before rotating it
    await q('update till_devices set unlocked_at = null, last_activity_at = null, pin_attempts = 0 where id = $1', [deviceId]);

    const generated = await generateTillPinValue(practiceId);
    const newPin = generated.pin!;
    await setTillPin(newPin, practiceId);

    const oldPinAfterReset = await unlockTill(DEVICE_SECRET, OLD_PIN);
    expect(oldPinAfterReset.error).toMatch(/incorrect/i);
    expect((await q<{ unlocked_at: string | null }>('select unlocked_at from till_devices where id = $1', [deviceId])).rows[0].unlocked_at).toBeFalsy();

    const newPinAfterReset = await unlockTill(DEVICE_SECRET, newPin);
    expect(newPinAfterReset.error).toBeNull();
  });
});
