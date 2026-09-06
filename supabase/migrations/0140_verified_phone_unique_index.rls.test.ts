// @vitest-environment node
//
// ─── 0140: the guarantee stops depending on a trigger ────────────────────
//
// 0139 guarded new verifications with a trigger because forty-one existing
// rows shared one number and the index could not be built. Those rows are
// gone, so this is the real constraint.
//
// Both are now in place, and the two tests that matter are about the SEAM
// between them:
//
//   • the index refuses even when the trigger cannot — a raw UPDATE that
//     slips past the trigger's change-detection, or a trigger that has been
//     dropped, still hits the storage engine;
//   • the trigger still fires FIRST, so the error a customer's request
//     produces is the legible one rather than "duplicate key value violates
//     unique constraint …".
//
// If those two ever stop being true the pair has silently become one thing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Full repo-relative paths in one resolve() call, matching every other
// migration test here — app/test-path-integrity.test.ts checks that each
// source-text read points at a real file, and it cannot follow a helper
// that joins a directory to a variable.
const MIG_0139 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0139_unique_verified_phone.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const MIG_0140 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0140_verified_phone_unique_index.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const A = '0000aaaa-0000-0000-0000-00000000aaaa';
const B = '0000bbbb-0000-0000-0000-00000000bbbb';
const C = '0000cccc-0000-0000-0000-00000000cccc';

const NUMBER = '+27821234567';
const LOCAL  = '0821234567';

const SCHEMA = `
  create role service_role nologin bypassrls;
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

  create table profiles (
    id uuid primary key, role text, email text unique,
    phone text, phone_verified_at timestamptz
  );

  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$ select true $$;
`;

let db: PGlite;

const insert = (id: string, email: string, phone: string | null, verified: boolean, role = 'patient') =>
  db.exec(`insert into profiles (id, role, email, phone, phone_verified_at)
           values ('${id}', '${role}', '${email}',
                   ${phone === null ? 'null' : `'${phone}'`},
                   ${verified ? 'now()' : 'null'});`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0139);
  await db.exec(MIG_0140);
}, 60_000);

afterAll(async () => { await db?.close(); });

describe('the index exists and has the right predicate', () => {
  it('is a UNIQUE index on the NORMALISED number', async () => {
    const rows = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where tablename='profiles' and indexname='profiles_verified_phone_patient_uniq';`);
    expect(rows.rows).toHaveLength(1);
    const def = rows.rows[0].indexdef;
    expect(def).toMatch(/CREATE UNIQUE INDEX/i);
    // On the function, never the raw column — production stored two shapes,
    // so a bare `btree (phone)` would be evadable by typing the other one.
    expect(def).toMatch(/hnpl_normalise_phone_za\(phone\)/);
    expect(def).not.toMatch(/btree\s*\(\s*phone\s*\)/);
  });

  it('is partial on patient + verified', async () => {
    const rows = await db.query<{ indexdef: string }>(
      `select indexdef from pg_indexes
        where indexname='profiles_verified_phone_patient_uniq';`);
    expect(rows.rows[0].indexdef).toMatch(/WHERE/i);
    expect(rows.rows[0].indexdef).toMatch(/role = 'patient'/);
    expect(rows.rows[0].indexdef).toMatch(/phone_verified_at IS NOT NULL/);
  });
});

describe('the index refuses a duplicate even with the trigger gone', () => {
  beforeAll(async () => { await insert(A, 'a@x.co', NUMBER, true); });

  it('the trigger produces the legible message while it is there', async () => {
    // BEFORE trigger runs ahead of the index check, so this is what a
    // customer's request actually surfaces.
    await expect(insert(B, 'b@x.co', NUMBER, true))
      .rejects.toThrow(/already verified on another account/i);
  });

  it('and the index still refuses once the trigger is dropped', async () => {
    // The whole reason for adding 0140. A dropped or bypassed trigger used
    // to mean no constraint at all.
    await db.exec('drop trigger trg_enforce_unique_verified_phone on profiles;');
    try {
      await expect(insert(B, 'b@x.co', NUMBER, true))
        .rejects.toThrow(/duplicate key value|profiles_verified_phone_patient_uniq/i);

      // Still evasion-proof across the two stored formats, because the index
      // is on the normalised value rather than the column.
      await expect(insert(C, 'c@x.co', LOCAL, true))
        .rejects.toThrow(/duplicate key value|profiles_verified_phone_patient_uniq/i);
    } finally {
      await db.exec(`create trigger trg_enforce_unique_verified_phone
                       before insert or update on profiles
                       for each row execute function enforce_unique_verified_phone();`);
    }
  });

  it('both refusals carry SQLSTATE 23505, so one handler covers each', async () => {
    // isPhoneAlreadyVerifiedElsewhere matches on the code. If the two
    // mechanisms reported different codes, dropping the trigger would
    // silently turn a handled refusal into "something went wrong".
    const codeOf = async (fn: () => Promise<unknown>) => {
      try { await fn(); return 'no error'; }
      catch (e) { return (e as { code?: string }).code ?? 'no code'; }
    };
    expect(await codeOf(() => insert(B, 'b@x.co', NUMBER, true))).toBe('23505');

    await db.exec('drop trigger trg_enforce_unique_verified_phone on profiles;');
    try {
      expect(await codeOf(() => insert(B, 'b@x.co', NUMBER, true))).toBe('23505');
    } finally {
      await db.exec(`create trigger trg_enforce_unique_verified_phone
                       before insert or update on profiles
                       for each row execute function enforce_unique_verified_phone();`);
    }
  });
});

describe('the predicate lets through everything it should', () => {
  it('a practice admin may share the number', async () => {
    await insert('0000dddd-0000-0000-0000-00000000dddd', 'd@x.co', NUMBER, true, 'practice_admin');
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from profiles where phone = '${NUMBER}';`);
    expect(rows.rows[0].n).toBe(2);
  });

  it('unverified duplicates are unconstrained', async () => {
    await insert('0000eeee-0000-0000-0000-00000000eeee', 'e@x.co', NUMBER, false);
    await insert('0000ffff-0000-0000-0000-00000000ffff', 'f@x.co', LOCAL,  false);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from profiles where phone_verified_at is null and phone is not null;`);
    expect(rows.rows[0].n).toBeGreaterThanOrEqual(2);
  });

  it('many patients may have NO phone at all', async () => {
    // A NULL normalised value must not collide with another NULL — the
    // index carries an explicit IS NOT NULL guard so an unparseable number
    // cannot make two unrelated accounts conflict.
    await insert('00001111-0000-0000-0000-000000001111', 'g@x.co', 'not a number', true);
    await insert('00002222-0000-0000-0000-000000002222', 'h@x.co', 'also not one', true);
    await insert('00003333-0000-0000-0000-000000003333', 'i@x.co', null, true);
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from profiles;`);
    expect(rows.rows[0].n).toBeGreaterThan(5);
  });
});
