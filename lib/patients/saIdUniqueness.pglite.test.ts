// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── One SA ID = one patient account, against a real Postgres ─────────────
//
// The whole claim of this feature is a database constraint, so it is tested
// by running the SHIPPED migration file against a real Postgres and then
// trying to break it — not by asserting that a string appears in a .sql
// file. In particular "a direct DB insert bypassing the app still hits the
// unique constraint" cannot be demonstrated any other way: the app is not
// in the picture at all.
//
// A throwaway HMAC key is generated per run and injected before the module
// under test is imported, because getLookupKey() reads process.env lazily.

process.env.SA_ID_LOOKUP_HMAC_KEY = randomBytes(32).toString('base64');

const PATIENT_SA_ID = '9001015800086';
const OTHER_SA_ID   = '8202025800085';

let hashIdForLookup: (s: string) => string;

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0097_sa_id_lookup_hash_unique.sql'),
  'utf8',
);

beforeAll(async () => {
  ({ hashIdForLookup } = await import('@/lib/idEncryption'));
});

// Only the columns the index and its predicate touch. `role` deliberately
// has no CHECK here — the point is to exercise the index, not the enum.
const SCHEMA = `
  create table profiles (
    id                uuid primary key,
    email             text,
    role              text,
    sa_id_number      text,
    sa_id_lookup_hash text
  );
`;

let db: PGlite;

async function insertProfile(opts: {
  role: string;
  saId?: string | null;
  hash?: string | null;
}): Promise<string> {
  const id = randomUUID();
  const hash =
    opts.hash !== undefined ? opts.hash
    : opts.saId ? hashIdForLookup(opts.saId)
    : null;
  await db.query(
    `insert into profiles (id, email, role, sa_id_number, sa_id_lookup_hash) values ($1, $2, $3, $4, $5)`,
    [id, `${id}@example.test`, opts.role, opts.saId ?? null, hash],
  );
  return id;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  // The migration exactly as it ships. If the shipped SQL is invalid, this
  // throws and every test below fails — which is the point.
  await db.exec(MIGRATION);
});

describe('the shipped migration', () => {
  it('creates the index it says it does', async () => {
    const r = await db.query<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where tablename = 'profiles'`,
    );
    const idx = r.rows.find((x) => x.indexname === 'profiles_sa_id_lookup_hash_patient_uniq');
    expect(idx).toBeDefined();
    expect(idx!.indexdef).toMatch(/UNIQUE/i);
    expect(idx!.indexdef).toMatch(/sa_id_lookup_hash/);
    expect(idx!.indexdef).toMatch(/role = 'patient'/);
  });

  it('is re-runnable — IF NOT EXISTS means a repeat apply is a no-op', async () => {
    await expect(db.exec(MIGRATION)).resolves.toBeDefined();
  });
});

describe('the rule: one SA ID, one patient account', () => {
  it('accepts the first patient to claim an ID', async () => {
    await expect(insertProfile({ role: 'patient', saId: PATIENT_SA_ID })).resolves.toBeTruthy();
  });

  it('REFUSES a second patient account on the same ID — a direct insert, no app involved', async () => {
    await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    await expect(insertProfile({ role: 'patient', saId: PATIENT_SA_ID })).rejects.toThrow(
      /duplicate key value violates unique constraint/i,
    );
  });

  it('refuses the duplicate even when the CIPHERTEXT differs, which it always does', async () => {
    // The reason the index is on the hash and not on sa_id_number: the two
    // rows below hold visibly different sa_id_number values for one ID.
    const hash = hashIdForLookup(PATIENT_SA_ID);
    await insertProfile({ role: 'patient', saId: 'v1:ciphertext-A', hash });
    await expect(
      insertProfile({ role: 'patient', saId: 'v1:completely-different-ciphertext-B', hash }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('leaves DIFFERENT IDs completely unaffected', async () => {
    await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    await expect(insertProfile({ role: 'patient', saId: OTHER_SA_ID })).resolves.toBeTruthy();
  });

  it('an existing account can still be updated in place — the row does not collide with itself', async () => {
    const id = await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    await expect(
      db.query(`update profiles set email = $2 where id = $1`, [id, 'changed@example.test']),
    ).resolves.toBeDefined();
    await expect(
      db.query(`update profiles set sa_id_lookup_hash = $2 where id = $1`, [id, hashIdForLookup(PATIENT_SA_ID)]),
    ).resolves.toBeDefined();
  });
});

describe('what the partial predicate deliberately allows', () => {
  it('a practice_provider may share an ID with a patient — one person, two roles', async () => {
    // The audit found exactly this: practice_admin, practice_provider and
    // patient rows on a single ID. A global unique would refuse the doctor.
    await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    await expect(insertProfile({ role: 'practice_provider', saId: PATIENT_SA_ID })).resolves.toBeTruthy();
    await expect(insertProfile({ role: 'practice_admin',    saId: PATIENT_SA_ID })).resolves.toBeTruthy();
  });

  it('two STAFF rows may share an ID — out of scope, and not silently fixed', async () => {
    await insertProfile({ role: 'practice_provider', saId: PATIENT_SA_ID });
    await expect(insertProfile({ role: 'practice_provider', saId: PATIENT_SA_ID })).resolves.toBeTruthy();
  });

  it('any number of patients may have NO ID on file', async () => {
    await insertProfile({ role: 'patient', saId: null });
    await insertProfile({ role: 'patient', saId: null });
    const r = await db.query<{ n: number }>(`select count(*)::int as n from profiles`);
    expect(r.rows[0].n).toBe(2);
  });
});

describe('the sharp edge: a NULL hash is invisible to the index', () => {
  it('two patients with the SAME ID but no hash are BOTH accepted', async () => {
    // This is why the backfill exits non-zero unless every row with an SA
    // ID carries a hash, and why both write paths derive it inside
    // encryptId's own try. Documented as a test because it is the one way
    // this constraint can be true and still not hold.
    await insertProfile({ role: 'patient', saId: 'v1:whatever', hash: null });
    await expect(
      insertProfile({ role: 'patient', saId: 'v1:whatever-else', hash: null }),
    ).resolves.toBeTruthy();
  });
});

describe('role changes move rows across the index boundary', () => {
  it('demoting sales -> patient FAILS when another patient holds that ID', async () => {
    // app/admin/sales-team/actions.ts's revokeSalesRole. The row enters the
    // partial index at the moment its role becomes 'patient'.
    await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    const salesId = await insertProfile({ role: 'sales', saId: PATIENT_SA_ID });
    await expect(
      db.query(`update profiles set role = 'patient' where id = $1`, [salesId]),
    ).rejects.toThrow(/duplicate key/i);
  });

  it('promoting patient -> sales always succeeds — it LEAVES the index', async () => {
    const a = await insertProfile({ role: 'patient', saId: PATIENT_SA_ID });
    await expect(db.query(`update profiles set role = 'sales' where id = $1`, [a])).resolves.toBeDefined();
    // …and the ID is now free for a patient account to take.
    await expect(insertProfile({ role: 'patient', saId: PATIENT_SA_ID })).resolves.toBeTruthy();
  });
});
