// @vitest-environment node
//
// ─── 0145: what a patient may see, and what nobody may write ─────────────
//
// The migration's own header states two claims that are worth more than
// prose, because both are the kind that quietly stop being true:
//
//   1. Writes are SERVICE ROLE ONLY. There is no INSERT, UPDATE or DELETE
//      policy on either table, so an authenticated session — a real patient,
//      holding a real JWT, hitting PostgREST directly — can read its own rows
//      and change nothing. This is R3-01's shape (a patient forging a payouts
//      row) refused before it exists rather than after an audit finds it.
//
//   2. Attribution is WRITE-ONCE. One account is referred by one person, and
//      the index says so under concurrency rather than the application saying
//      so between two statements.
//
// Plus the shape constraints, each of which encodes a decision that is
// invisible in the column list: a link referral has no invitee, a practice
// referral has no plan, nobody refers themselves, and a converted referral
// cannot walk backwards into pending.
//
// Runs as a real non-superuser role. pglite's default role bypasses RLS, so a
// test that forgot `set role authenticated` would pass every one of these
// while proving nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0145_referrals_foundation.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ALICE    = '0000a1ce-0000-0000-0000-00000000a1ce';  // the referrer
const BOB      = '0000b0b0-0000-0000-0000-00000000b0b0';  // the referred friend
const CAROL    = '0000ca01-0000-0000-0000-00000000ca01';  // an unrelated patient
const ADMIN    = '0000ad00-0000-0000-0000-00000000ad00';
const GROUP    = '0000c000-0000-0000-0000-00000000c000';
const PRACTICE = '0000dddd-0000-0000-0000-00000000dddd';
const PLAN     = '0000eeee-0000-0000-0000-00000000eeee';

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

  create table profiles (
    id uuid primary key, role text, email text,
    created_at timestamptz not null default now()
  );
  create table practice_groups (id uuid primary key, name text);
  create table practices (
    id uuid primary key, owner_id uuid, name text, group_id uuid, status text
  );
  create table plans (
    id uuid primary key, patient_id uuid, practice_id uuid,
    total_amount numeric, status text
  );
  -- Only the columns 0145's FK needs; the real table is 0069's.
  create table crm_leads (
    id uuid primary key default gen_random_uuid(),
    practice_name text not null,
    source text not null default 'other',
    stage  text not null default 'new'
  );

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;

  create or replace function is_platform_admin() returns boolean
    language sql stable security definer set search_path = public as $$
      select exists (select 1 from profiles where id = auth.uid() and role = 'admin');
    $$;
`;

const SEED = `
  insert into profiles (id, role, email) values
    ('${ALICE}', 'patient', 'alice@example.com'),
    ('${BOB}',   'patient', 'bob@example.com'),
    ('${CAROL}', 'patient', 'carol@example.com'),
    ('${ADMIN}', 'admin',   'admin@example.com');
  insert into practice_groups (id, name) values ('${GROUP}', 'Group');
  insert into practices (id, owner_id, name, group_id, status)
    values ('${PRACTICE}', null, 'Practice', '${GROUP}', 'approved');
  insert into plans (id, patient_id, practice_id, total_amount, status)
    values ('${PLAN}', '${BOB}', '${PRACTICE}', 10000, 'active');
  insert into crm_leads (id, practice_name, source)
    values ('00001ead-0000-0000-0000-0000000001ea', 'Referred Practice', 'referral');
`;

let db: PGlite;

/** A real authenticated session, RLS on. */
async function as<T>(uid: string, sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = '${uid}', role = 'authenticated';`);
  await db.exec('set role authenticated;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
  }
}

/** service_role — what every write in app/patient/refer/actions.ts holds. */
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

const CODE = 'A2C4K9PT';

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);
  // The blanket grant in SCHEMA ran before these tables existed. Table
  // PRIVILEGES and row-level POLICIES are different gates and both have to be
  // open for RLS to be the thing under test — without this every assertion
  // below would fail on "permission denied" and prove nothing about policies.
  await db.exec(`
    grant select, insert, update, delete on referral_codes, referrals
      to anon, authenticated, service_role;
  `);
  await asService(`
    insert into referral_codes (id, owner_id, code)
      values ('0000c0de-0000-0000-0000-00000000c0de', '${ALICE}', '${CODE}');
  `);
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────

describe('the migration applies and both tables carry RLS', () => {
  it('referral_codes and referrals exist with row security enabled', async () => {
    const rows = await asService<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class
       where relname in ('referral_codes', 'referrals')
       order by relname;
    `);
    expect(rows).toEqual([
      { relname: 'referral_codes', relrowsecurity: true },
      { relname: 'referrals',      relrowsecurity: true },
    ]);
  });

  it('neither table has a write policy of any kind', async () => {
    // THE structural claim. A policy added later for convenience —
    // "let the patient insert their own referral" — fails here, which is the
    // moment to have the argument rather than after an audit.
    const rows = await asService<{ tablename: string; cmd: string }>(`
      select tablename, cmd from pg_policies
       where schemaname = 'public'
         and tablename in ('referral_codes', 'referrals')
         and cmd <> 'SELECT';
    `);
    expect(rows).toEqual([]);
  });
});

describe('reads are scoped to the referrer and the platform admin', () => {
  beforeAll(async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, invitee_email, expires_at)
      values ('0000f001-0000-0000-0000-00000000f001', '${ALICE}', 'patient', 'invite',
              'pending', 'bob@example.com', now() + interval '30 days');
    `);
  });

  it('the referrer sees their own referral and their own code', async () => {
    const refs  = await as(ALICE, 'select id from referrals');
    const codes = await as(ALICE, 'select id from referral_codes');
    expect(refs).toHaveLength(1);
    expect(codes).toHaveLength(1);
  });

  it('an unrelated patient sees neither', async () => {
    expect(await as(CAROL, 'select id from referrals')).toEqual([]);
    expect(await as(CAROL, 'select id from referral_codes')).toEqual([]);
  });

  it('the REFERRED person cannot see the row that names them', async () => {
    // Deliberate: "who referred you" is the referrer's record. A policy on
    // referred_profile_id would hand every new customer the email address a
    // friend typed for them.
    await asService(`
      update referrals set referred_profile_id = '${BOB}', status = 'signed_up'
       where id = '0000f001-0000-0000-0000-00000000f001';
    `);
    expect(await as(BOB, 'select id from referrals')).toEqual([]);
  });

  it('a platform admin sees everything', async () => {
    expect(await as(ADMIN, 'select id from referrals')).toHaveLength(1);
    expect(await as(ADMIN, 'select id from referral_codes')).toHaveLength(1);
  });
});

describe('an authenticated session cannot write, whatever it claims', () => {
  it('a patient cannot insert a referral naming themselves as referrer', async () => {
    await expect(as(CAROL, `
      insert into referrals (referrer_id, kind, status)
      values ('${CAROL}', 'patient', 'converted');
    `)).rejects.toThrow(/row-level security/i);
  });

  it('a patient cannot insert one naming somebody ELSE as referrer', async () => {
    await expect(as(CAROL, `
      insert into referrals (referrer_id, kind, status)
      values ('${ALICE}', 'patient', 'converted');
    `)).rejects.toThrow(/row-level security/i);
  });

  it('a patient cannot mint themselves a code', async () => {
    await expect(as(CAROL, `
      insert into referral_codes (owner_id, code) values ('${CAROL}', 'BBBBBBBB');
    `)).rejects.toThrow(/row-level security/i);
  });

  it('the referrer cannot promote their own referral to converted', async () => {
    // No UPDATE policy, so this matches zero rows rather than raising. The
    // read-back is the assertion: a status a customer could set is a payment
    // a customer could authorise.
    await as(ALICE, `update referrals set status = 'converted' where referrer_id = '${ALICE}';`);
    const [row] = await asService<{ status: string }>('select status from referrals limit 1');
    expect(row.status).toBe('signed_up');
  });

  it('and cannot delete one either', async () => {
    await as(ALICE, `delete from referrals where referrer_id = '${ALICE}';`);
    expect(await asService('select id from referrals')).toHaveLength(1);
  });
});

describe('attribution is write-once', () => {
  it('a second referral for the same referred account is refused', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, referred_profile_id)
      values ('${CAROL}', 'patient', 'link', 'signed_up', '${BOB}');
    `)).rejects.toThrow(/referrals_referred_profile_key|duplicate key/i);
  });

  it('but two referrals with no referred account yet are fine', async () => {
    await asService(`
      insert into referrals (referrer_id, kind, channel, status, practice_name)
      values ('${ALICE}', 'practice', 'invite', 'pending', 'Rosebank Dental'),
             ('${ALICE}', 'practice', 'invite', 'pending', 'Sandton Physio');
    `);
    const rows = await asService('select id from referrals where kind = \'practice\'');
    expect(rows).toHaveLength(2);
  });

  it('one open invitation per referrer per address', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, invitee_email)
      values ('${ALICE}', 'patient', 'invite', 'pending', 'dup@example.com'),
             ('${ALICE}', 'patient', 'invite', 'pending', 'dup@example.com');
    `)).rejects.toThrow(/referrals_open_invite_key|duplicate key/i);
  });
});

describe('the shape constraints', () => {
  it('nobody refers themselves', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, referred_profile_id)
      values ('${CAROL}', 'patient', 'link', 'signed_up', '${CAROL}');
    `)).rejects.toThrow(/referrals_not_self/);
  });

  it('a practice referral must name the practice', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status)
      values ('${ALICE}', 'practice', 'invite', 'pending');
    `)).rejects.toThrow(/referrals_practice_named/);
  });

  it('a link referral carries no invitee details', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, invitee_email)
      values ('${ALICE}', 'patient', 'link', 'pending', 'someone@example.com');
    `)).rejects.toThrow(/referrals_link_has_no_invitee/);
  });

  it('a practice is never referred by a link', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, practice_name)
      values ('${ALICE}', 'practice', 'link', 'pending', 'Linked Practice');
    `)).rejects.toThrow(/referrals_link_is_patient_only/);
  });

  it('a patient referral cannot carry a CRM lead', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, crm_lead_id)
      values ('${ALICE}', 'patient', 'invite', 'pending',
              (select id from crm_leads limit 1));
    `)).rejects.toThrow(/referrals_patient_has_no_lead|null value/);
  });

  it('an invitee address must already be lower case', async () => {
    await expect(asService(`
      insert into referrals (referrer_id, kind, channel, status, invitee_email)
      values ('${ALICE}', 'patient', 'invite', 'pending', 'Shouty@Example.com');
    `)).rejects.toThrow(/referrals_invitee_email_normalised/);
  });

  it('the code alphabet is enforced in the database, not only in TypeScript', async () => {
    for (const bad of ['A2C4K9P', 'A2C4K9PTX', 'a2c4k9pt', 'A2C4K9P0', 'A2C4K9PI']) {
      await expect(asService(`
        insert into referral_codes (owner_id, code) values ('${CAROL}', '${bad}');
      `), `'${bad}' should be refused`).rejects.toThrow(/referral_codes_code_check|violates check/);
    }
  });

  it('a revoked code is never re-issued to somebody else', async () => {
    await asService(`
      insert into referral_codes (owner_id, code, revoked_at)
        values ('${CAROL}', 'RVKD2345', now());
    `);
    await expect(asService(`
      insert into referral_codes (owner_id, code) values ('${ADMIN}', 'RVKD2345');
    `)).rejects.toThrow(/referral_codes_code_key|duplicate key/i);
  });

  it('but one live code per person', async () => {
    await asService(`insert into referral_codes (owner_id, code) values ('${CAROL}', 'HVE23456');`);
    await expect(asService(`
      insert into referral_codes (owner_id, code) values ('${CAROL}', 'HVE23457');
    `)).rejects.toThrow(/referral_codes_owner_live_key|duplicate key/i);
  });
});

describe('the status guard', () => {
  const ROW = '0000f002-0000-0000-0000-00000000f002';

  beforeAll(async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, practice_name)
      values ('${ROW}', '${ALICE}', 'practice', 'invite', 'pending', 'Guarded Practice');
    `);
  });

  it('stamps signed_up_at when the status moves, without the caller doing it', async () => {
    await asService(`update referrals set status = 'signed_up' where id = '${ROW}';`);
    const [row] = await asService<{ signed_up_at: Date | null; updated_at: Date }>(
      `select signed_up_at, updated_at from referrals where id = '${ROW}'`);
    expect(row.signed_up_at).not.toBeNull();
  });

  it('stamps converted_at, and backfills signed_up_at if the row skipped it', async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, practice_name)
      values ('0000f003-0000-0000-0000-00000000f003', '${ALICE}', 'practice', 'invite',
              'pending', 'Skipped Practice');
    `);
    await asService(`
      update referrals set status = 'converted'
       where id = '0000f003-0000-0000-0000-00000000f003';
    `);
    const [row] = await asService<{ signed_up_at: Date | null; converted_at: Date | null }>(
      `select signed_up_at, converted_at from referrals
        where id = '0000f003-0000-0000-0000-00000000f003'`);
    expect(row.signed_up_at).not.toBeNull();
    expect(row.converted_at).not.toBeNull();
  });

  it('a converted referral cannot walk back to pending', async () => {
    await expect(asService(`
      update referrals set status = 'pending'
       where id = '0000f003-0000-0000-0000-00000000f003';
    `)).rejects.toThrow(/already converted/);
  });

  it('but it can always be voided — that is how fraud is closed', async () => {
    await asService(`
      update referrals set status = 'void'
       where id = '0000f003-0000-0000-0000-00000000f003';
    `);
    const [row] = await asService<{ status: string }>(
      `select status from referrals where id = '0000f003-0000-0000-0000-00000000f003'`);
    expect(row.status).toBe('void');
  });

  it('nothing writes qualified_at — the incentive seam stays empty', async () => {
    // The one claim docs/REFERRALS.md makes that a reader would otherwise
    // have to take on trust. If a future programme starts stamping it, this
    // test is where that decision becomes visible.
    const rows = await asService<{ n: number }>(
      'select count(*)::int as n from referrals where qualified_at is not null');
    expect(rows[0].n).toBe(0);
  });
});

describe('prune_referral_invites — expiry and the POPIA scrub', () => {
  it('expires a lapsed invitation and leaves a live one alone', async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, invitee_email, expires_at)
      values ('0000f004-0000-0000-0000-00000000f004', '${ALICE}', 'patient', 'invite',
              'pending', 'lapsed@example.com', now() - interval '1 day'),
             ('0000f005-0000-0000-0000-00000000f005', '${ALICE}', 'patient', 'invite',
              'pending', 'live@example.com',   now() + interval '10 days');
    `);
    await asService('select * from prune_referral_invites()');
    const rows = await asService<{ id: string; status: string }>(`
      select id, status from referrals
       where id in ('0000f004-0000-0000-0000-00000000f004',
                    '0000f005-0000-0000-0000-00000000f005')
       order by id;
    `);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'pending']);
  });

  it('scrubs the invitee off a dead invitation past retention, keeping the row', async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, invitee_name,
                             invitee_email, invitee_phone, note, updated_at)
      values ('0000f006-0000-0000-0000-00000000f006', '${ALICE}', 'patient', 'invite',
              'expired', 'Old Friend', 'old@example.com', '+27821234567', 'a note',
              now() - interval '200 days');
    `);
    const [{ scrubbed_count }] = await asService<{ scrubbed_count: number }>(
      'select scrubbed_count from prune_referral_invites()');
    expect(scrubbed_count).toBeGreaterThan(0);

    const [row] = await asService<Record<string, unknown>>(`
      select invitee_name, invitee_email, invitee_phone, note, referrer_id
        from referrals where id = '0000f006-0000-0000-0000-00000000f006';
    `);
    // The personal information is gone; the record that Alice made a referral
    // is not. That distinction is the whole design of the scrub.
    expect(row.invitee_name).toBeNull();
    expect(row.invitee_email).toBeNull();
    expect(row.invitee_phone).toBeNull();
    expect(row.note).toBeNull();
    expect(row.referrer_id).toBe(ALICE);
  });

  it('never scrubs a recently-dead invitation', async () => {
    await asService(`
      insert into referrals (id, referrer_id, kind, channel, status, invitee_email, updated_at)
      values ('0000f007-0000-0000-0000-00000000f007', '${ALICE}', 'patient', 'invite',
              'expired', 'recent@example.com', now() - interval '2 days');
    `);
    await asService('select * from prune_referral_invites()');
    const [row] = await asService<{ invitee_email: string | null }>(
      `select invitee_email from referrals where id = '0000f007-0000-0000-0000-00000000f007'`);
    expect(row.invitee_email).toBe('recent@example.com');
  });

  it('clamps an absurd retention argument rather than throwing', async () => {
    // Same posture as consume_rate_limit (0134): a housekeeping job that
    // raises on a bad argument is a job that silently stops running. The
    // floor is the invitation window itself, so a caller cannot ask this to
    // scrub invitations that are still live.
    await expect(asService('select * from prune_referral_invites(-5)')).resolves.toBeDefined();
    await expect(asService('select * from prune_referral_invites(null)')).resolves.toBeDefined();
    const [row] = await asService<{ invitee_email: string | null }>(
      `select invitee_email from referrals where id = '0000f005-0000-0000-0000-00000000f005'`);
    expect(row.invitee_email).toBe('live@example.com');
  });

  it('is not callable by a browser session', async () => {
    await expect(as(ALICE, 'select * from prune_referral_invites()'))
      .rejects.toThrow(/permission denied/i);
  });
});
