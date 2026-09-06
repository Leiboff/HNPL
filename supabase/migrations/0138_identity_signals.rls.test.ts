// @vitest-environment node
//
// ─── 0138: the signal store is server-only, and the guards mean it ────────
//
// This table is a fraud control, which makes it a target in an unusual way:
// the interesting attack is not READING it, it is WRITING it. An attacker who
// can plant signals onto somebody else's account can manufacture a link graph
// that gets that account blocked — turning a fraud defence into a
// denial-of-service weapon aimed at a competitor's customers, or at a
// customer who annoyed them. So the write posture is what most of this file
// is about.
//
// The other half is `record_identity_signals` behaving exactly as the
// reviewer's tooling assumes: first_seen_at pinned, hits advancing, malformed
// entries skipped rather than raised. "This card appeared on a second account
// three months later" and "…within the same hour" must stay distinguishable,
// and that distinction lives entirely in whether the upsert touches
// first_seen_at.
//
// Runs as real non-superuser roles — pglite's default role bypasses RLS.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0138_identity_signals.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ALICE  = '0000aaaa-0000-0000-0000-00000000aaaa';
const BOB    = '0000bbbb-0000-0000-0000-00000000bbbb';
const CAROL  = '0000cccc-0000-0000-0000-00000000cccc';
const DAN    = '0000dddd-0000-0000-0000-00000000dddd';
const ADMIN  = '0000ad00-0000-0000-0000-00000000ad00';

/** 64 hex chars — the only shape value_hash accepts.
 *  Every one contains letters on purpose: with an all-digit hash the
 *  "uppercase hex is rejected" assertion below would pass vacuously, because
 *  toUpperCase() of '333…' is '333…'. */
const h = (seed: string) => `${seed}f`.repeat(64).slice(0, 64);
const DEVICE_A = h('a1');
const CARD_A   = h('b2');
const IP_A     = h('c3');
const PHONE_A  = h('d4');

const SCHEMA = `
  create role anon          nologin;
  create role authenticated nologin;
  create role service_role  nologin bypassrls;

  create table _ctx (uid uuid, role text);
  insert into _ctx values (null, 'authenticated');
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid
    language sql stable as $$ select uid  from _ctx limit 1 $$;
  create or replace function auth.role() returns text
    language sql stable as $$ select role from _ctx limit 1 $$;

  create table profiles (id uuid primary key, role text);

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select, update on _ctx         to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                       to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                       to anon, authenticated, service_role;

  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
    $$;

  create or replace function hnpl_write_is_privileged() returns boolean
    language sql stable set search_path = public as $$
      select coalesce(auth.role() = 'service_role', false)
          or coalesce(current_setting('app.privileged_write', true) = 'on', false);
    $$;

  alter table profiles enable row level security;
  create policy "users_select_own_profile" on profiles for select using (id = auth.uid());
  create policy "admins_select_all_profiles" on profiles for select using (is_platform_admin());
`;

const SEED = `
  insert into profiles (id, role) values
    ('${ALICE}', 'patient'), ('${BOB}', 'patient'),
    ('${CAROL}', 'patient'), ('${DAN}', 'patient'),
    ('${ADMIN}', 'admin');
`;

/** Table-level grants for the two tables 0138 creates — the ON ALL TABLES
 *  grant above ran before they existed. RLS, not the grant, is the control
 *  under test, so these are deliberately generous. */
const POST = `
  grant select, insert, update, delete on identity_signals, fraud_decisions
    to anon, authenticated, service_role;
`;

let db: PGlite;

async function as<T>(uid: string, sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = '${uid}', role = 'authenticated';`);
  await db.exec('set role authenticated;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
  }
}

async function asAnon<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = null, role = 'anon';`);
  await db.exec('set role anon;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
    await db.exec(`update _ctx set role = 'authenticated';`);
  }
}

async function asService<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = null, role = 'service_role';`);
  await db.exec('set role service_role;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
    await db.exec(`update _ctx set role = 'authenticated';`);
  }
}

/** The server's own call shape: a JSONB array of {kind, value_hash}. */
const record = (user: string, signals: Array<{ kind: string; value_hash: string }>) =>
  asService<{ record_identity_signals: number }>(
    `select record_identity_signals('${user}'::uuid, '${JSON.stringify(signals)}'::jsonb);`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);
  await db.exec(POST);
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────
// Recording
// ─────────────────────────────────────────────────────────────────────────

describe('record_identity_signals', () => {
  it('writes one row per signal and returns the count', async () => {
    const rows = await record(ALICE, [
      { kind: 'device', value_hash: DEVICE_A },
      { kind: 'card',   value_hash: CARD_A },
    ]);
    expect(rows[0].record_identity_signals).toBe(2);

    const stored = await asService<{ kind: string; hits: number }>(
      `select kind, hits from identity_signals where user_id = '${ALICE}' order by kind;`);
    expect(stored.map((r) => r.kind)).toEqual(['card', 'device']);
    expect(stored.every((r) => r.hits === 1)).toBe(true);
  });

  it('a returning signal advances hits and last_seen_at but NOT first_seen_at', async () => {
    // The whole reviewer workflow rests on this. If first_seen_at moved on
    // every sighting, "a card that turned up on a second account three months
    // later" would be indistinguishable from "…within the same hour", and the
    // second is fraud while the first is usually a family.
    const before = await asService<{ first_seen_at: string; last_seen_at: string }>(
      `select first_seen_at, last_seen_at from identity_signals
        where user_id = '${ALICE}' and kind = 'device';`);

    await db.exec(`select pg_sleep(0.01);`);
    await record(ALICE, [{ kind: 'device', value_hash: DEVICE_A }]);

    const after = await asService<{ hits: number; first_seen_at: string; last_seen_at: string }>(
      `select hits, first_seen_at, last_seen_at from identity_signals
        where user_id = '${ALICE}' and kind = 'device';`);

    expect(after[0].hits).toBe(2);
    expect(new Date(after[0].first_seen_at).getTime())
      .toBe(new Date(before[0].first_seen_at).getTime());
    expect(new Date(after[0].last_seen_at).getTime())
      .toBeGreaterThanOrEqual(new Date(before[0].last_seen_at).getTime());
  });

  it('skips a malformed entry instead of failing the whole batch', async () => {
    // A signup must not fail because one of four optional signals was bad.
    const rows = await record(BOB, [
      { kind: 'device',  value_hash: DEVICE_A },
      { kind: 'browser', value_hash: CARD_A },        // not one of the four kinds
      { kind: 'card',    value_hash: 'not-a-hash' },  // wrong shape
      { kind: 'ip',      value_hash: IP_A.toUpperCase() }, // uppercase hex is not our shape
    ]);
    expect(rows[0].record_identity_signals).toBe(1);

    const kinds = await asService<{ kind: string }>(
      `select kind from identity_signals where user_id = '${BOB}';`);
    expect(kinds.map((r) => r.kind)).toEqual(['device']);
  });

  it('de-duplicates within a single batch', async () => {
    // ON CONFLICT cannot see a row twice in the same statement — it errors
    // with "cannot affect row a second time" unless the input is DISTINCT.
    const rows = await record(CAROL, [
      { kind: 'ip', value_hash: IP_A },
      { kind: 'ip', value_hash: IP_A },
    ]);
    expect(rows[0].record_identity_signals).toBe(1);
  });

  it('tolerates null and non-array input rather than raising', async () => {
    const a = await asService<{ record_identity_signals: number }>(
      `select record_identity_signals('${DAN}'::uuid, null::jsonb);`);
    expect(a[0].record_identity_signals).toBe(0);
    const b = await asService<{ record_identity_signals: number }>(
      `select record_identity_signals('${DAN}'::uuid, '{"kind":"ip"}'::jsonb);`);
    expect(b[0].record_identity_signals).toBe(0);
  });

  it('does not leave app.privileged_write switched on for the caller', async () => {
    // The function opts into the 0121 bypass to get past its own guard
    // trigger. If it left that setting on, every subsequent statement in the
    // same transaction would bypass EVERY column-lock trigger in the schema.
    const rows = await asService<{ setting: string }>(`
      select coalesce(current_setting('app.privileged_write', true), 'unset') as setting
        from (select record_identity_signals('${DAN}'::uuid,
                '[{"kind":"phone","value_hash":"${PHONE_A}"}]'::jsonb)) _;`);
    expect(rows[0].setting).not.toBe('on');
  });

  it('is not callable by an ordinary logged-in user', async () => {
    await expect(as(ALICE,
      `select record_identity_signals('${BOB}'::uuid,
         '[{"kind":"device","value_hash":"${DEVICE_A}"}]'::jsonb);`))
      .rejects.toThrow(/permission denied/i);
  });

  it('is not callable anonymously', async () => {
    await expect(asAnon(
      `select record_identity_signals('${BOB}'::uuid,
         '[{"kind":"device","value_hash":"${DEVICE_A}"}]'::jsonb);`))
      .rejects.toThrow(/permission denied/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Correlation
// ─────────────────────────────────────────────────────────────────────────

describe('identity_link_counts', () => {
  it('counts OTHER accounts sharing a value, per kind', async () => {
    // ALICE and BOB share DEVICE_A (seeded above); nobody shares ALICE's card.
    const rows = await asService<{ kind: string; shared_accounts: number }>(
      `select * from identity_link_counts('${ALICE}'::uuid) order by kind;`);
    const byKind = Object.fromEntries(rows.map((r) => [r.kind, r.shared_accounts]));
    expect(byKind.device).toBe(1);
    expect(byKind.card).toBeUndefined();   // no row at all, rather than 0
  });

  it('counts distinct accounts, not distinct rows', async () => {
    await record(CAROL, [{ kind: 'device', value_hash: DEVICE_A }]);
    await record(CAROL, [{ kind: 'device', value_hash: DEVICE_A }]); // second sighting
    const rows = await asService<{ kind: string; shared_accounts: number }>(
      `select * from identity_link_counts('${ALICE}'::uuid) where kind = 'device';`);
    expect(rows[0].shared_accounts).toBe(2); // BOB and CAROL, not three sightings
  });

  it('never counts the subject as sharing with itself', async () => {
    const rows = await asService<{ kind: string; shared_accounts: number }>(
      `select * from identity_link_counts('${DAN}'::uuid);`);
    expect(rows).toHaveLength(0); // DAN's phone is his alone
  });

  it('is not callable by a logged-in user — the link graph is reconnaissance', async () => {
    // Knowing the counts is exactly what an attacker probing for the
    // threshold would want: it turns a blind guess into a binary search.
    await expect(as(ALICE, `select * from identity_link_counts('${ALICE}'::uuid);`))
      .rejects.toThrow(/permission denied/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// The write guard — the denial-of-service surface
// ─────────────────────────────────────────────────────────────────────────

describe('identity_signals is not user-writable', () => {
  it('has no INSERT policy for any user role', async () => {
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_policies
        where tablename = 'identity_signals' and cmd in ('INSERT', 'ALL');`);
    expect(rows.rows[0].n).toBe(0);
  });

  it('a user cannot plant a signal onto somebody else to get them blocked', async () => {
    await expect(as(ALICE, `
      insert into identity_signals (user_id, kind, value_hash)
      values ('${BOB}', 'card', '${CARD_A}');`))
      .rejects.toThrow(/row-level security|written only by the server/i);
  });

  it('a user cannot plant a signal onto their OWN account either', async () => {
    // Self-writes look harmless and are not: the attacker controls both ends,
    // so they could seed a hash they know an innocent account will later
    // present, and link the two on their own terms.
    await expect(as(ALICE, `
      insert into identity_signals (user_id, kind, value_hash)
      values ('${ALICE}', 'ip', '${IP_A}');`))
      .rejects.toThrow(/row-level security|written only by the server/i);
  });

  it('a user cannot delete the signals that link them', async () => {
    const before = await asService<{ n: number }>(
      `select count(*)::int as n from identity_signals;`);
    await as(ALICE, `delete from identity_signals;`);
    const after = await asService<{ n: number }>(
      `select count(*)::int as n from identity_signals;`);
    expect(after[0].n).toBe(before[0].n);
  });

  it('a user cannot read anybody’s signals, including their own', async () => {
    // Deliberate: seeing your own row tells you the mechanism exists and what
    // it keys on, and there is no product reason to show it.
    const rows = await as(ALICE, `select * from identity_signals;`);
    expect(rows).toHaveLength(0);
  });

  it('an admin can read them, for review', async () => {
    const rows = await as(ADMIN, `select * from identity_signals;`);
    expect(rows.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// fraud_decisions — created by the server, released only by an admin
// ─────────────────────────────────────────────────────────────────────────

describe('fraud_decisions', () => {
  const DECISION = '0000f000-0000-0000-0000-00000000f000';

  beforeAll(async () => {
    await asService(`
      insert into fraud_decisions (id, user_id, surface, decision, rule)
      values ('${DECISION}', '${ALICE}', 'signup', 'block', 'device_shared_by_6_accounts');`);
  });

  it('a user cannot create a decision', async () => {
    await expect(as(ALICE, `
      insert into fraud_decisions (user_id, surface, decision)
      values ('${BOB}', 'signup', 'block');`))
      .rejects.toThrow(/row-level security|created and removed only by the server/i);
  });

  it('a user cannot see, and so cannot learn, that they were blocked', async () => {
    const rows = await as(ALICE, `select * from fraud_decisions;`);
    expect(rows).toHaveLength(0);
  });

  it('a user cannot release their own block', async () => {
    await as(ALICE, `
      update fraud_decisions set released_at = now(), released_by = '${ALICE}',
             release_note = 'nothing to see here' where id = '${DECISION}';`);
    const rows = await asService<{ released_at: string | null }>(
      `select released_at from fraud_decisions where id = '${DECISION}';`);
    expect(rows[0].released_at).toBeNull();
  });

  it('an admin releases it, and that is recorded with a real actor', async () => {
    await as(ADMIN, `
      update fraud_decisions
         set released_at = now(), released_by = '${ADMIN}', release_note = 'known family'
       where id = '${DECISION}';`);
    const rows = await asService<{ released_by: string; release_note: string }>(
      `select released_by, release_note from fraud_decisions where id = '${DECISION}';`);
    expect(rows[0].released_by).toBe(ADMIN);
    expect(rows[0].release_note).toBe('known family');
  });

  it('an admin cannot release in somebody else’s name', async () => {
    const OTHER = '0000f001-0000-0000-0000-00000000f001';
    await asService(`
      insert into fraud_decisions (id, user_id, surface, decision)
      values ('${OTHER}', '${BOB}', 'signup', 'block');`);
    await expect(as(ADMIN, `
      update fraud_decisions set released_at = now(), released_by = '${ALICE}',
             release_note = 'x' where id = '${OTHER}';`))
      .rejects.toThrow(/released_by must be the admin/i);
  });

  it('a release cannot smuggle in a change to the decision itself', async () => {
    const OTHER = '0000f001-0000-0000-0000-00000000f001';
    await expect(as(ADMIN, `
      update fraud_decisions
         set released_at = now(), released_by = '${ADMIN}', release_note = 'x',
             decision = 'flag', rule = 'rewritten'
       where id = '${OTHER}';`))
      .rejects.toThrow(/may change only released_at/i);
  });

  it('a decision cannot be released twice', async () => {
    await expect(as(ADMIN, `
      update fraud_decisions set released_at = now(), released_by = '${ADMIN}',
             release_note = 'again' where id = '${DECISION}';`))
      .rejects.toThrow(/already been released/i);
  });

  it('an admin cannot delete a decision to make the history disappear', async () => {
    // There is no DELETE policy, so RLS filters the statement to zero rows.
    // PostgreSQL calls that a successful no-op, not an error — the guard
    // trigger is never even reached. Assert the row survived rather than
    // that the statement threw, or this passes for the wrong reason.
    await as(ADMIN, `delete from fraud_decisions where id = '${DECISION}';`);
    const rows = await asService<{ n: number }>(
      `select count(*)::int as n from fraud_decisions where id = '${DECISION}';`);
    expect(rows[0].n).toBe(1);
  });

  it('an admin cannot hand-write a block against somebody they dislike', async () => {
    // Admins get exactly one verb on this table: release. Creating a block by
    // hand would put a refusal in the record with no rule and no counts
    // behind it, which is the one thing the decision log exists to prevent.
    await expect(as(ADMIN, `
      insert into fraud_decisions (user_id, surface, decision, rule)
      values ('${BOB}', 'signup', 'block', 'because i said so');`))
      .rejects.toThrow(/row-level security|created and removed only by the server/i);
  });
});
