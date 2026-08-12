// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// ─── Roster providers, against REAL Postgres ────────────────────────────
//
// The claim this feature rests on is a DATABASE claim: a practice_members row
// with no user_id is legal, is identifiable, and authorises nothing. The last
// part is the one worth proving with the engine rather than by reading code —
// every permission helper resolves through `user_id = auth.uid()`, so the
// question "can a roster row ever satisfy one" is answerable in SQL.
//
// Migration 0091 is executed VERBATIM, so this also proves it applies.

const MIG_0091 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0091_roster_providers_without_login.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// practice_members as it stands before 0091: user_id nullable since 0001,
// role check from 0026, can_manage_practice from 0034, clinical fields from
// 0021. Plus the three authority helpers, defined with their REAL bodies
// (0002 / 0034) rather than stubs — they are the thing under test here.
const STUB_SCHEMA = `
  create table profiles (
    id uuid primary key default gen_random_uuid(),
    first_name text not null,
    last_name  text not null,
    email      text unique not null
  );
  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text
  );
  create table practice_members (
    id                  uuid primary key default gen_random_uuid(),
    practice_id         uuid references practices(id),
    user_id             uuid references profiles(id),
    role                text check (role in ('admin','staff','provider')),
    active              boolean default true,
    can_create_bills    boolean default false,
    can_manage_practice boolean not null default false,
    specialty           text,
    hpcsa_number        text,
    sa_id_number        text,
    payout_destination  text default 'practice'
      check (payout_destination in ('practice','provider')),
    created_at          timestamptz default now(),
    unique (practice_id, user_id)
  );

  -- A settable stand-in for auth.uid(), so the helpers below can be
  -- exercised as different callers.
  create table _current_user (id uuid);
  create or replace function auth_uid() returns uuid
    language sql stable as $$ select id from _current_user limit 1 $$;

  -- Real bodies from 0002 / 0034, with auth.uid() -> auth_uid().
  create or replace function is_practice_member(p_practice_id uuid) returns boolean
    language sql stable as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth_uid() and active = true) $$;
  create or replace function is_practice_admin(p_practice_id uuid) returns boolean
    language sql stable as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth_uid()
          and role = 'admin' and active = true) $$;
  create or replace function is_practice_manager(p_practice_id uuid) returns boolean
    language sql stable as $$
      select exists (select 1 from practice_members
        where practice_id = p_practice_id and user_id = auth_uid()
          and can_manage_practice = true and active = true) $$;
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

let practiceA: string;
let practiceB: string;

const asUser = (id: string | null) =>
  q('delete from _current_user').then(() =>
    id ? q('insert into _current_user (id) values ($1)', [id]) : Promise.resolve(null));

async function seedLoginMember(opts: {
  practiceId: string; email: string; role: 'admin' | 'provider' | 'staff';
  canManage?: boolean; active?: boolean;
}) {
  const profile = await q<{ id: string }>(
    `insert into profiles (first_name, last_name, email) values ('Login','User',$1) returning id`,
    [opts.email]);
  const member = await q<{ id: string }>(
    `insert into practice_members (practice_id, user_id, role, active, can_manage_practice)
     values ($1,$2,$3,$4,$5) returning id`,
    [opts.practiceId, profile.rows[0].id, opts.role, opts.active ?? true, opts.canManage ?? false]);
  return { userId: profile.rows[0].id, memberId: member.rows[0].id };
}

const insertRoster = (practiceId: string, first: string, last: string) =>
  q<{ id: string }>(
    `insert into practice_members
       (practice_id, user_id, provider_first_name, provider_last_name, role, active,
        specialty, hpcsa_number)
     values ($1, null, $2, $3, 'provider', true, 'Dentistry', 'MP0123456') returning id`,
    [practiceId, first, last]);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(MIG_0091);
});

beforeEach(async () => {
  await db.exec('truncate practice_members, practices, profiles, _current_user cascade');
  practiceA = (await q<{ id: string }>(
    `insert into practices (name) values ('A') returning id`)).rows[0].id;
  practiceB = (await q<{ id: string }>(
    `insert into practices (name) values ('B') returning id`)).rows[0].id;
});

afterAll(async () => { await db?.close(); });

// ─── The row is legal ───────────────────────────────────────────────────

describe('a roster row with no login', () => {
  it('inserts with user_id NULL, name, specialty and HPCSA', async () => {
    const { rows } = await insertRoster(practiceA, 'Naledi', 'Khumalo');
    expect(rows).toHaveLength(1);

    const read = await q<{
      user_id: string | null; provider_first_name: string;
      provider_last_name: string; role: string; specialty: string; hpcsa_number: string;
    }>(`select user_id, provider_first_name, provider_last_name, role, specialty, hpcsa_number
        from practice_members where id = $1`, [rows[0].id]);

    expect(read.rows[0].user_id).toBeNull();
    expect(read.rows[0].provider_first_name).toBe('Naledi');
    expect(read.rows[0].role).toBe('provider');
    expect(read.rows[0].hpcsa_number).toBe('MP0123456');
  });

  it('MANY roster rows per practice are allowed — UNIQUE(practice_id, user_id) is NULLS DISTINCT', async () => {
    // The premise of the whole feature. If this were NULLS NOT DISTINCT a
    // practice could have exactly one login-less practitioner.
    await insertRoster(practiceA, 'Naledi', 'Khumalo');
    await insertRoster(practiceA, 'Sipho',  'Dlamini');
    await insertRoster(practiceA, 'Anita',  'Pillay');
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from practice_members where practice_id = $1 and user_id is null`,
      [practiceA]);
    expect(rows[0].n).toBe(3);
  });

  it('satisfies the trading gate — one active provider, no login required', async () => {
    // checkTradingGate: practice_members, active = true, role = 'provider'.
    await insertRoster(practiceA, 'Naledi', 'Khumalo');
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from practice_members
        where practice_id = $1 and active = true and role = 'provider'`, [practiceA]);
    expect(rows[0].n).toBe(1);
  });
});

// ─── 0091's identifiable constraint ─────────────────────────────────────

describe('every row is identifiable — 0091 constraint', () => {
  it('REJECTS a row with neither a login nor a name', async () => {
    await expect(q(
      `insert into practice_members (practice_id, user_id, role, active)
       values ($1, null, 'provider', true)`, [practiceA],
    )).rejects.toThrow(/practice_members_identifiable/);
  });

  it('REJECTS a login-less row with only a first name', async () => {
    await expect(q(
      `insert into practice_members (practice_id, user_id, provider_first_name, role)
       values ($1, null, 'Naledi', 'provider')`, [practiceA],
    )).rejects.toThrow(/practice_members_identifiable/);
  });

  it('REJECTS blank-string names — whitespace is not a name', async () => {
    await expect(q(
      `insert into practice_members
         (practice_id, user_id, provider_first_name, provider_last_name, role)
       values ($1, null, '   ', 'Khumalo', 'provider')`, [practiceA],
    )).rejects.toThrow(/practice_members_identifiable/);
  });

  it('REJECTS local names on a row that HAS a login — one home for a name', async () => {
    // Otherwise the membership row becomes a second, staler copy of the name
    // of someone who already has a profile.
    const profile = await q<{ id: string }>(
      `insert into profiles (first_name, last_name, email)
       values ('Real','Person','real@example.test') returning id`);
    await expect(q(
      `insert into practice_members
         (practice_id, user_id, provider_first_name, provider_last_name, role)
       values ($1, $2, 'Fake', 'Name', 'provider')`,
      [practiceA, profile.rows[0].id],
    )).rejects.toThrow(/practice_members_identifiable/);
  });

  it('ACCEPTS an ordinary member with a login and no local names', async () => {
    // The existing shape. Proves 0091 validates against current data.
    const m = await seedLoginMember({ practiceId: practiceA, email: 'a@example.test', role: 'admin' });
    expect(m.memberId).toBeTruthy();
  });

  it('linking a roster row must clear the local names, or be rejected', async () => {
    const roster  = await insertRoster(practiceA, 'Naledi', 'Khumalo');
    const profile = await q<{ id: string }>(
      `insert into profiles (first_name, last_name, email)
       values ('Naledi','Khumalo','naledi@example.test') returning id`);

    // Setting user_id while leaving the names behind violates the invariant…
    await expect(q(
      `update practice_members set user_id = $1 where id = $2`,
      [profile.rows[0].id, roster.rows[0].id],
    )).rejects.toThrow(/practice_members_identifiable/);

    // …which is exactly what inviteLoginForRosterMember does in one statement.
    const ok = await q(
      `update practice_members
          set user_id = $1, provider_first_name = null, provider_last_name = null
        where id = $2 and user_id is null returning id`,
      [profile.rows[0].id, roster.rows[0].id]);
    expect(ok.rows).toHaveLength(1);
  });
});

// ─── ADVERSARIAL: the row must authorise nothing ────────────────────────

describe('ADVERSARIAL — a roster row grants no access', () => {
  it('a roster row does not make ANY caller a member, admin or manager', async () => {
    await insertRoster(practiceA, 'Naledi', 'Khumalo');

    // No caller at all.
    await asUser(null);
    let r = await q<{ m: boolean; a: boolean; g: boolean }>(
      `select is_practice_member($1) as m, is_practice_admin($1) as a,
              is_practice_manager($1) as g`, [practiceA]);
    expect([r.rows[0].m, r.rows[0].a, r.rows[0].g]).toEqual([false, false, false]);

    // A signed-in stranger.
    const outsider = await seedLoginMember({
      practiceId: practiceB, email: 'outsider@example.test', role: 'admin', canManage: true });
    await asUser(outsider.userId);
    r = await q<{ m: boolean; a: boolean; g: boolean }>(
      `select is_practice_member($1) as m, is_practice_admin($1) as a,
              is_practice_manager($1) as g`, [practiceA]);
    expect([r.rows[0].m, r.rows[0].a, r.rows[0].g]).toEqual([false, false, false]);
  });

  it('a roster row cannot be granted capabilities into existence', async () => {
    // Even with both flags forced true by raw SQL — bypassing the app, which
    // writes false — the helpers still refuse, because they resolve through
    // user_id. This is why "a NULL user_id authorises nothing" is a property
    // of the existing predicates rather than a rule the app has to police.
    const roster = await insertRoster(practiceA, 'Naledi', 'Khumalo');
    await q(`update practice_members
               set can_manage_practice = true, can_create_bills = true, role = 'admin'
             where id = $1`, [roster.rows[0].id]);

    await asUser(null);
    const r = await q<{ m: boolean; a: boolean; g: boolean }>(
      `select is_practice_member($1) as m, is_practice_admin($1) as a,
              is_practice_manager($1) as g`, [practiceA]);
    expect([r.rows[0].m, r.rows[0].a, r.rows[0].g]).toEqual([false, false, false]);
  });

  it('the roster is READABLE by the practice\'s manager — 0035\'s policy is practice-scoped', async () => {
    // The other half: a user_id-scoped SELECT policy would have made the
    // roster invisible to the very person who created it. Confirmed by
    // exercising the predicate the policy uses.
    const manager = await seedLoginMember({
      practiceId: practiceA, email: 'mgr@example.test', role: 'admin', canManage: true });
    await insertRoster(practiceA, 'Naledi', 'Khumalo');

    await asUser(manager.userId);
    const r = await q<{ g: boolean }>(`select is_practice_manager($1) as g`, [practiceA]);
    expect(r.rows[0].g).toBe(true);
  });

  it('a DISABLED login-holder loses membership — the /provider active check has teeth', async () => {
    const provider = await seedLoginMember({
      practiceId: practiceA, email: 'doc@example.test', role: 'provider', active: false });
    await asUser(provider.userId);
    const r = await q<{ m: boolean }>(`select is_practice_member($1) as m`, [practiceA]);
    expect(r.rows[0].m).toBe(false);
  });
});

// ─── Roster rows are per-practice ───────────────────────────────────────

describe('roster rows are scoped to their practice', () => {
  it('practice B\'s roster does not appear on practice A', async () => {
    await insertRoster(practiceA, 'Naledi', 'Khumalo');
    await insertRoster(practiceB, 'Other',  'Practice');

    const a = await q<{ provider_first_name: string }>(
      `select provider_first_name from practice_members where practice_id = $1 and user_id is null`,
      [practiceA]);
    expect(a.rows.map((r) => r.provider_first_name)).toEqual(['Naledi']);
  });

  it('the same practitioner name may exist on two different practices', async () => {
    await insertRoster(practiceA, 'Naledi', 'Khumalo');
    const b = await insertRoster(practiceB, 'Naledi', 'Khumalo');
    expect(b.rows).toHaveLength(1);
  });
});
