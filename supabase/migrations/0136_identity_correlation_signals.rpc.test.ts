// @vitest-environment node
//
// ─── The signal ledger, executed ────────────────────────────────────────
//
// identityGraph.test.ts proves the thresholds; ringGate.test.ts proves the
// gate is called. Neither runs a line of SQL, so this file runs the actual
// migration against a real Postgres (pglite) and pins the three properties
// the TypeScript above is entitled to ASSUME but cannot check:
//
//   1. counts are over DISTINCT IDENTITIES, not rows and not accounts —
//      the difference between "one patient who reconnects every morning"
//      and "a hundred people";
//   2. the applicant is excluded from their own count, so a returning
//      patient never appears to share a device with themselves;
//   3. NULL-identity rows are counted for NOBODY, which is what stops
//      anonymous signup spam from being able to implicate real customers.
//
// Each of those is a silent-wrong-answer failure if it breaks: the number
// still looks plausible, and the control keeps reporting that it works.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0136_identity_correlation_signals.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// pglite has no Supabase roles, and the migration's GRANTs name
// service_role. Created here rather than stripped from the migration text:
// running the file VERBATIM is the point of this test, since a GRANT to a
// role that does not exist is exactly the kind of thing that passes review
// and fails on deploy.
const SCHEMA = `
  create role service_role nologin bypassrls;
  create table profiles (id uuid primary key);
`;

const P1 = '00000000-0000-0000-0000-000000000001';
const P2 = '00000000-0000-0000-0000-000000000002';
const P3 = '00000000-0000-0000-0000-000000000003';
const P4 = '00000000-0000-0000-0000-000000000004';

/** A 64-hex value of the shape the CHECK constraint demands. */
const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const DEVICE = hash('a');

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG);
  for (const id of [P1, P2, P3, P4]) {
    await db.query('insert into profiles (id) values ($1)', [id]);
  }
});
afterEach(async () => { await db.close(); });

async function record(profileId: string, identityHash: string | null, kind: string, signalHash: string) {
  await db.query('select record_identity_signal($1, $2, $3, $4, $5)',
    [profileId, identityHash, kind, signalHash, 'accept_plan']);
}

async function countFor(identityHash: string, kind = 'device', signalHash = DEVICE) {
  const res = await db.query<{ kind: string; distinct_identities: number; recent_identities: number }>(
    'select * from count_identity_links($1, $2::text[], $3::text[], $4)',
    [identityHash, [kind], [signalHash], 24],
  );
  return res.rows[0];
}

describe('the migration applies', () => {
  it('creates the table, the functions and the constraints', async () => {
    const t = await db.query<{ count: number }>(
      `select count(*)::int as count from information_schema.tables where table_name = 'identity_signals'`);
    expect(t.rows[0].count).toBe(1);

    const f = await db.query<{ proname: string }>(
      `select proname from pg_proc where proname in
         ('record_identity_signal','count_identity_links','delete_expired_identity_signals')
       order by proname`);
    expect(f.rows.map((r) => r.proname)).toEqual([
      'count_identity_links', 'delete_expired_identity_signals', 'record_identity_signal',
    ]);
  });
});

describe('counting is over distinct identities', () => {
  it('counts one returning patient once, however many times they appear', async () => {
    // The bug this pins: counting ROWS would turn a loyal customer into a
    // hundred-person ring.
    for (let i = 0; i < 50; i++) await record(P2, 'identity-B', 'device', DEVICE);
    const row = await countFor('identity-A');
    expect(row.distinct_identities).toBe(1);
  });

  it('counts one identity once even across several accounts', async () => {
    // Counting PROFILES would turn one person's abandoned signups into a
    // ring of three.
    await record(P2, 'identity-B', 'device', DEVICE);
    await record(P3, 'identity-B', 'device', DEVICE);
    await record(P4, 'identity-B', 'device', DEVICE);
    expect((await countFor('identity-A')).distinct_identities).toBe(1);
  });

  it('counts genuinely distinct identities separately', async () => {
    await record(P2, 'identity-B', 'device', DEVICE);
    await record(P3, 'identity-C', 'device', DEVICE);
    await record(P4, 'identity-D', 'device', DEVICE);
    expect((await countFor('identity-A')).distinct_identities).toBe(3);
  });
});

describe('the applicant is excluded from their own count', () => {
  it('reports zero others for a patient alone on their device', async () => {
    await record(P1, 'identity-A', 'device', DEVICE);
    await record(P1, 'identity-A', 'device', DEVICE);
    const row = await countFor('identity-A');
    expect(row.distinct_identities).toBe(0);
  });

  it('does not let the applicant inflate a real count', async () => {
    await record(P1, 'identity-A', 'device', DEVICE);
    await record(P2, 'identity-B', 'device', DEVICE);
    expect((await countFor('identity-A')).distinct_identities).toBe(1);
  });
});

describe('unverified accounts are counted for nobody', () => {
  it('ignores NULL-identity rows entirely', async () => {
    // Otherwise anonymous signup spam could implicate every real customer
    // who shares a network with it.
    for (let i = 0; i < 30; i++) await record(P2, null, 'device', DEVICE);
    expect((await countFor('identity-A')).distinct_identities).toBe(0);
  });
});

describe('the recency window', () => {
  it('separates a burst from an accumulation', async () => {
    await record(P2, 'identity-B', 'device', DEVICE);
    await record(P3, 'identity-C', 'device', DEVICE);
    // Age one of them past the window.
    await db.query(
      `update identity_signals set occurred_at = now() - interval '10 days' where identity_hash = 'identity-B'`);

    const row = await countFor('identity-A');
    expect(row.distinct_identities).toBe(2);
    expect(row.recent_identities).toBe(1);
  });
});

describe('a probe with no matches answers zero rather than nothing', () => {
  it('returns a row for a key nobody stands on', async () => {
    // The TypeScript maps rows to links; a missing row and a zero row must
    // not be the same thing to debug.
    const row = await countFor('identity-A', 'card', hash('f'));
    expect(row).toBeDefined();
    expect(row.distinct_identities).toBe(0);
  });
});

describe('recording never throws at the caller', () => {
  it('swallows a malformed hash rather than failing a signup', async () => {
    await expect(record(P1, 'identity-A', 'device', 'not-a-hash')).resolves.not.toThrow();
    const n = await db.query<{ count: number }>('select count(*)::int as count from identity_signals');
    expect(n.rows[0].count).toBe(0);
  });

  it('swallows an unknown kind', async () => {
    await expect(record(P1, 'identity-A', 'bank_account', DEVICE)).resolves.not.toThrow();
    const n = await db.query<{ count: number }>('select count(*)::int as count from identity_signals');
    expect(n.rows[0].count).toBe(0);
  });

  it('swallows a profile id that does not exist', async () => {
    const ghost = '00000000-0000-0000-0000-0000000000ff';
    await expect(record(ghost, 'identity-A', 'device', DEVICE)).resolves.not.toThrow();
  });
});

describe('retention', () => {
  it('deletes only rows past the retention horizon', async () => {
    await record(P2, 'identity-B', 'device', DEVICE);
    await record(P3, 'identity-C', 'device', DEVICE);
    await db.query(
      `update identity_signals set occurred_at = now() - interval '200 days' where identity_hash = 'identity-B'`);

    const res = await db.query<{ delete_expired_identity_signals: number }>(
      'select delete_expired_identity_signals(180)');
    expect(res.rows[0].delete_expired_identity_signals).toBe(1);
    expect((await countFor('identity-A')).distinct_identities).toBe(1);
  });
});
