// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Real RPC execution test — redeem_till_registration_code (Build A) ────
//
// Loads the ACTUAL function body out of migration 0088 and runs it in a
// real Postgres (pglite). Proves the atomic verify+mint+consume
// behaviour that matters most here: a code can be redeemed exactly
// once, even under a race (two concurrent redemption attempts on the
// SAME code), because the function row-locks the code before deciding.

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0088_till_devices.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

function fnSql(name: string): string {
  const start = MIG.indexOf(`CREATE OR REPLACE FUNCTION ${name}`);
  if (start < 0) throw new Error(`function ${name} not found in migration`);
  const end = MIG.indexOf('$$;', start);
  return MIG.slice(start, end + 3);
}

const SCHEMA = `
  create table practices    (id uuid primary key default gen_random_uuid());
  create table profiles     (id uuid primary key default gen_random_uuid());
  create table till_devices (
    id                uuid primary key default gen_random_uuid(),
    practice_id       uuid not null references practices(id),
    secret_hash       text not null unique,
    registered_by     uuid references profiles(id),
    registered_at     timestamptz not null default now(),
    revoked_at        timestamptz,
    revoked_by        uuid references profiles(id),
    unlocked_at       timestamptz,
    last_activity_at  timestamptz,
    pin_attempts      smallint not null default 0,
    pin_locked_until  timestamptz,
    label             text
  );
  create table till_device_registration_codes (
    id                 uuid primary key default gen_random_uuid(),
    practice_id        uuid not null references practices(id),
    code_hash          text not null unique,
    created_by         uuid references profiles(id),
    created_at         timestamptz not null default now(),
    expires_at         timestamptz not null,
    used_at            timestamptz,
    used_by_device_id  uuid references till_devices(id)
  );
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fnSql('redeem_till_registration_code'));
  return db;
}

let practiceId: string;

async function seedCode(db: PGlite, opts: { codeHash: string; expiresAt: string; usedAt?: string | null }) {
  const p = await db.query<{ id: string }>(`insert into practices default values returning id`);
  practiceId = p.rows[0].id;
  await db.query(
    `insert into till_device_registration_codes (practice_id, code_hash, expires_at, used_at)
     values ($1, $2, $3, $4)`,
    [practiceId, opts.codeHash, opts.expiresAt, opts.usedAt ?? null],
  );
}

async function redeem(db: PGlite, codeHash: string, secretHash: string) {
  const { rows } = await db.query<{ result: string; device_id: string | null; practice_id: string | null }>(
    `select * from redeem_till_registration_code($1, $2)`,
    [codeHash, secretHash],
  );
  return rows[0];
}

const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString();
const PAST   = new Date(Date.now() - 60 * 1000).toISOString();

describe('redeem_till_registration_code — happy path', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('mints a device row scoped to the code\'s practice and marks the code used', async () => {
    await seedCode(db, { codeHash: 'hash-a', expiresAt: FUTURE });
    const row = await redeem(db, 'hash-a', 'secret-hash-a');
    expect(row.result).toBe('ok');
    expect(row.device_id).toBeTruthy();
    expect(row.practice_id).toBe(practiceId);

    const { rows: devices } = await db.query<{ secret_hash: string; practice_id: string }>(`select secret_hash, practice_id from till_devices where id = $1`, [row.device_id]);
    expect(devices[0].secret_hash).toBe('secret-hash-a');
    expect(devices[0].practice_id).toBe(practiceId);

    const { rows: codes } = await db.query<{ used_at: string | null; used_by_device_id: string }>(`select used_at, used_by_device_id from till_device_registration_codes where code_hash = 'hash-a'`);
    expect(codes[0].used_at).not.toBeNull();
    expect(codes[0].used_by_device_id).toBe(row.device_id);
  });
});

describe('redeem_till_registration_code — rejection reasons', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('invalid_code for a hash with no matching row', async () => {
    const row = await redeem(db, 'nonexistent', 'secret-x');
    expect(row.result).toBe('invalid_code');
    expect(row.device_id).toBeNull();
    expect(row.practice_id).toBeNull();
  });

  it('expired for a code past its expires_at', async () => {
    await seedCode(db, { codeHash: 'hash-expired', expiresAt: PAST });
    const row = await redeem(db, 'hash-expired', 'secret-x');
    expect(row.result).toBe('expired');
  });

  it('already_used for a code redeemed a second time', async () => {
    await seedCode(db, { codeHash: 'hash-reuse', expiresAt: FUTURE });
    const first = await redeem(db, 'hash-reuse', 'secret-first');
    expect(first.result).toBe('ok');

    const second = await redeem(db, 'hash-reuse', 'secret-second');
    expect(second.result).toBe('already_used');
    expect(second.device_id).toBeNull();

    // Only ONE device was minted, not two.
    const { rows } = await db.query(`select count(*)::int as n from till_devices`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});

describe('redeem_till_registration_code — concurrent double-redemption is impossible', () => {
  let db: PGlite;
  beforeEach(async () => { db = await freshDb(); });

  it('two simultaneous redemption attempts on the SAME code: exactly one succeeds', async () => {
    await seedCode(db, { codeHash: 'hash-race', expiresAt: FUTURE });

    // pglite serializes queries on a single connection, but the
    // function's own FOR UPDATE row lock is what actually guarantees
    // this under real concurrent connections in production (two
    // separate Postgres backends). Firing both without awaiting between
    // them exercises the same "who gets there first" decision path.
    const [a, b] = await Promise.all([
      redeem(db, 'hash-race', 'secret-a'),
      redeem(db, 'hash-race', 'secret-b'),
    ]);

    const results = [a.result, b.result].sort();
    expect(results).toEqual(['already_used', 'ok']);

    const { rows } = await db.query(`select count(*)::int as n from till_devices`);
    expect((rows[0] as { n: number }).n).toBe(1);
  });
});
