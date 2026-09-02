// @vitest-environment node
//
// ─── Promotion and practice linkage, executed ──────────────────────────
//
// Two properties the TypeScript cannot check for itself:
//
//   1. promotion only ever FILLS A NULL, so a replayed webhook, a second
//      verification, or a re-verification under a different ID can never
//      rewrite an identity already on record. Webhook delivery is
//      at-least-once, so this is not a theoretical concern;
//   2. concentration counts the right things — distinct identities, plans
//      in any status, practices behind them.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Full repo-relative paths, not a directory plus a bare filename:
// app/test-path-integrity.test.ts resolves every source-text read target
// and fails if it does not exist, which it cannot do when the path is
// assembled from parts. A read pointing at a missing file would otherwise
// be an INVISIBLE collection error — the whole file silently not running.
const read = (p: string) =>
  readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

const MIG_0136 = read('supabase/migrations/0136_identity_correlation_signals.sql');
const MIG_0137 = read('supabase/migrations/0137_identity_signal_promotion_and_practice_links.sql');

const SCHEMA = `
  create role service_role nologin bypassrls;
  create table profiles (id uuid primary key);
  create table practices (id uuid primary key);
  create table plans (
    id uuid primary key,
    patient_id uuid references profiles(id),
    practice_id uuid references practices(id),
    status text not null default 'pending_acceptance'
  );
`;

const P1 = '00000000-0000-0000-0000-000000000001';
const P2 = '00000000-0000-0000-0000-000000000002';
const P3 = '00000000-0000-0000-0000-000000000003';
const P4 = '00000000-0000-0000-0000-000000000004';
const P5 = '00000000-0000-0000-0000-000000000005';
const PROFILES = [P1, P2, P3, P4, P5];

const PRACTICE_A = '000000aa-0000-0000-0000-0000000000aa';
const PRACTICE_B = '000000bb-0000-0000-0000-0000000000bb';

const hash = (seed: string) => seed.repeat(64).slice(0, 64);
const DEVICE = hash('a');

let db: PGlite;

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0136);
  await db.exec(MIG_0137);
  for (const id of PROFILES) await db.query('insert into profiles (id) values ($1)', [id]);
  for (const id of [PRACTICE_A, PRACTICE_B]) await db.query('insert into practices (id) values ($1)', [id]);
});
afterEach(async () => { await db.close(); });

const record = (profileId: string, identityHash: string | null, kind = 'device', signalHash = DEVICE) =>
  db.query('select record_identity_signal($1, $2, $3, $4, $5)',
    [profileId, identityHash, kind, signalHash, 'signup']);

const promote = async (profileId: string, identityHash: string) => {
  const r = await db.query<{ promote_identity_signals: number }>(
    'select promote_identity_signals($1, $2)', [profileId, identityHash]);
  return r.rows[0].promote_identity_signals;
};

const concentrationFor = async (identityHash: string) => {
  const r = await db.query<{ linked_identities: number; linked_plans: number; distinct_practices: number }>(
    'select * from linked_practice_concentration($1, $2::text[], $3::text[])',
    [identityHash, ['device'], [DEVICE]]);
  return r.rows[0];
};

const addPlan = (id: string, patient: string, practice: string, status = 'active') =>
  db.query('insert into plans (id, patient_id, practice_id, status) values ($1,$2,$3,$4)',
    [id, patient, practice, status]);

describe('promotion attaches a verified identity to earlier signals', () => {
  it('fills the null rows this profile wrote before it had an identity', async () => {
    await record(P1, null);
    await record(P1, null);
    expect(await promote(P1, 'identity-A')).toBe(2);

    // Now countable by others.
    const r = await db.query<{ kind: string; distinct_identities: number }>(
      'select * from count_identity_links($1, $2::text[], $3::text[], 24)',
      ['identity-OTHER', ['device'], [DEVICE]]);
    expect(r.rows[0].distinct_identities).toBe(1);
  });

  it('touches only the named profile', async () => {
    await record(P1, null);
    await record(P2, null);
    expect(await promote(P1, 'identity-A')).toBe(1);
  });
});

describe('promotion can never rewrite history', () => {
  it('is idempotent — a replayed webhook promotes nothing the second time', async () => {
    await record(P1, null);
    expect(await promote(P1, 'identity-A')).toBe(1);
    expect(await promote(P1, 'identity-A')).toBe(0);
  });

  it('cannot overwrite an identity already on a row', async () => {
    // The attack this closes: re-verify under a second ID and repoint every
    // signal you ever produced onto it, laundering the device history.
    await record(P1, null);
    await promote(P1, 'identity-A');
    expect(await promote(P1, 'identity-B')).toBe(0);

    const r = await db.query<{ identity_hash: string }>('select identity_hash from identity_signals');
    expect(r.rows.every((row) => row.identity_hash === 'identity-A')).toBe(true);
  });

  it('does not resurrect signals older than the retention horizon', async () => {
    await record(P1, null);
    await db.query(`update identity_signals set occurred_at = now() - interval '200 days'`);
    expect(await promote(P1, 'identity-A')).toBe(0);
  });

  it('returns zero rather than throwing on null input', async () => {
    const r = await db.query<{ promote_identity_signals: number }>(
      'select promote_identity_signals($1, $2)', [P1, null]);
    expect(r.rows[0].promote_identity_signals).toBe(0);
  });
});

describe('practice concentration', () => {
  beforeEach(async () => {
    // Four other identities, all on one device, all billed by practice A.
    const linked: Array<[string, string]> = [[P2, 'identity-B'], [P3, 'identity-C'], [P4, 'identity-D'], [P5, 'identity-E']];
    for (const [profile, identity] of linked) {
      await record(profile, null);
      await promote(profile, identity);
    }
  });

  it('counts distinct linked identities, their plans and the practices behind them', async () => {
    await addPlan('00000000-0000-0000-0000-0000000000f1', P2, PRACTICE_A);
    await addPlan('00000000-0000-0000-0000-0000000000f2', P3, PRACTICE_A);
    await addPlan('00000000-0000-0000-0000-0000000000f3', P4, PRACTICE_A);
    await addPlan('00000000-0000-0000-0000-0000000000f4', P5, PRACTICE_A);

    const c = await concentrationFor('identity-A');
    expect(c.linked_identities).toBe(4);
    expect(c.linked_plans).toBe(4);
    expect(c.distinct_practices).toBe(1);
  });

  it('sees a genuinely spread group as spread', async () => {
    await addPlan('00000000-0000-0000-0000-0000000000f1', P2, PRACTICE_A);
    await addPlan('00000000-0000-0000-0000-0000000000f2', P3, PRACTICE_B);

    const c = await concentrationFor('identity-A');
    expect(c.distinct_practices).toBe(2);
  });

  it('counts plans in ANY status — a refused ring is still a ring', async () => {
    await addPlan('00000000-0000-0000-0000-0000000000f1', P2, PRACTICE_A, 'cancelled');
    await addPlan('00000000-0000-0000-0000-0000000000f2', P3, PRACTICE_A, 'declined');

    const c = await concentrationFor('identity-A');
    expect(c.linked_plans).toBe(2);
  });

  it('excludes the applicant from their own concentration', async () => {
    await record(P1, null);
    await promote(P1, 'identity-A');
    await addPlan('00000000-0000-0000-0000-0000000000f9', P1, PRACTICE_B);

    const c = await concentrationFor('identity-A');
    expect(c.linked_identities).toBe(4);          // not 5
    expect(c.distinct_practices).toBe(0);         // their own plan is not counted
  });

  it('reports zeroes, not nothing, when no linked identity has a plan', async () => {
    const c = await concentrationFor('identity-A');
    expect(c.linked_identities).toBe(4);
    expect(c.linked_plans).toBe(0);
    expect(c.distinct_practices).toBe(0);
  });
});
