// @vitest-environment node
//
// ─── 0148: credit information, and the money control ────────────────────
//
// Two classes of claim, both of the kind that quietly stop being true:
//
//   1. NOBODY BUT THE SERVICE ROLE CAN REACH THIS TABLE. Every row is credit
//      information about a natural person. RLS is enabled with no policies AND
//      the default anon/authenticated grants are revoked — two independent
//      gates, because Supabase grants table privileges by default and a future
//      migration that adds a policy "for the admin page", or disables RLS while
//      debugging, must not immediately publish everyone's credit file.
//
//   2. THE IN-FLIGHT UNIQUE INDEX HOLDS UNDER CONCURRENCY. It is the half of
//      the double-billing guard that actually works across serverless
//      invocations — the in-process map in lib/experian/assessAtSignup.ts
//      cannot span two lambdas. Two tabs, one billable call.
//
// Plus the CHECK constraints, each of which encodes a decision that is
// invisible in the column list: a negative value is a WARNING CODE and not a
// score, bands run 1–5, and the outcome and decision vocabularies are closed.
//
// Runs as a real non-superuser role. pglite's default role bypasses RLS and
// ignores grants, so a test that forgot `set role authenticated` would pass
// every one of these while proving nothing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0148_bureau_enquiries.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const ALICE = '0000a1ce-0000-0000-0000-00000000a1ce';
const BOB   = '0000b0b0-0000-0000-0000-00000000b0b0';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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

  grant usage  on schema auth, public to anon, authenticated, service_role;
  grant select on _ctx                to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.role()
                                      to anon, authenticated, service_role;
  grant select, insert, update, delete on all tables in schema public
                                      to anon, authenticated, service_role;
`;

const SEED = `
  insert into profiles (id, role, email) values
    ('${ALICE}', 'patient', 'alice@example.com'),
    ('${BOB}',   'patient', 'bob@example.com');
`;

let db: PGlite;

/** A real authenticated session: RLS on, and only the privileges it was granted. */
async function as<T>(sql: string): Promise<T[]> {
  await db.exec(`update _ctx set uid = '${ALICE}', role = 'authenticated';`);
  await db.exec('set role authenticated;');
  try {
    return (await db.query(sql)).rows as T[];
  } finally {
    await db.exec('reset role;');
  }
}

/** service_role — what lib/experian/enquiryStore.ts holds. */
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

/** Open an attempt row, as the application does before the billable call. */
const openAttempt = (hash: string, profile: string = ALICE) => asService(`
  insert into bureau_enquiries (profile_id, id_number_hash, p_version)
    values ('${profile}', '${hash}', '4.0') returning id;
`);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(SEED);
  await db.exec(MIG);

  // Granting to ALL THREE roles and then RE-APPLYING proves three things at
  // once: the migration is idempotent as its header claims, the REVOKE
  // actually bites rather than being decoration, and it is TARGETED — it
  // strips anon and authenticated and leaves service_role, which is what the
  // application runs as.
  //
  // Without this the assertions below would pass trivially. The blanket grant
  // in SCHEMA ran before this table existed, so no role held a privilege to
  // lose, and "anon cannot select" would be proving the absence of a grant
  // nobody ever made rather than the presence of a REVOKE.
  //
  // Note bypassrls on service_role bypasses ROW SECURITY, not table
  // PRIVILEGES — real Supabase grants those separately, and so must this.
  await db.exec(`
    grant select, insert, update, delete on bureau_enquiries
      to anon, authenticated, service_role;
  `);
  await db.exec(MIG);
}, 60_000);

afterAll(async () => { await db?.close(); });

// ─────────────────────────────────────────────────────────────────────────

describe('the migration applies, is idempotent, and the table carries RLS', () => {
  it('bureau_enquiries exists with row security enabled', async () => {
    const rows = await asService<{ relname: string; relrowsecurity: boolean }>(`
      select relname, relrowsecurity from pg_class where relname = 'bureau_enquiries';
    `);
    expect(rows).toEqual([{ relname: 'bureau_enquiries', relrowsecurity: true }]);
  });

  it('has NO policies at all — deny by default, not deny by omission', async () => {
    // Zero, not "no write policies". There is no legitimate reader here: a
    // patient never sees their own bureau enquiry, and practice staff never
    // see anyone's. A SELECT policy added later for an admin page fails
    // here, which is the moment to have the argument.
    const rows = await asService<{ policyname: string }>(`
      select policyname from pg_policies
       where schemaname = 'public' and tablename = 'bureau_enquiries';
    `);
    expect(rows).toEqual([]);
  });
});

describe('anon and authenticated cannot reach it at all', () => {
  it('neither role holds any table privilege after the migration re-applies', async () => {
    const rows = await asService<{ role: string; priv: string; has: boolean }>(`
      select r.rolname as role, p.priv, has_table_privilege(r.rolname, 'bureau_enquiries', p.priv) as has
        from (values ('anon'), ('authenticated')) as r(rolname),
             (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv)
       order by r.rolname, p.priv;
    `);
    expect(rows.every((r) => r.has === false), JSON.stringify(rows)).toBe(true);
  });

  it('but service_role keeps its privileges — the REVOKE is targeted, not blanket', async () => {
    // Both roles held all four privileges before the migration re-applied
    // (see beforeAll). If the REVOKE were widened to service_role, the
    // application would lose the table entirely and every enquiry would fail
    // closed — safe, but silently and totally broken.
    const rows = await asService<{ priv: string; has: boolean }>(`
      select p.priv, has_table_privilege('service_role', 'bureau_enquiries', p.priv) as has
        from (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(priv);
    `);
    expect(rows.every((r) => r.has === true), JSON.stringify(rows)).toBe(true);
  });

  it('a real authenticated session is refused on SELECT', async () => {
    await expect(as('select id from bureau_enquiries;')).rejects.toThrow(/permission denied/i);
  });

  it('a real authenticated session is refused on INSERT', async () => {
    // The shape that matters: a patient forging an enquiry row to fake a
    // decision, or to occupy the in-flight slot and deny their own check.
    await expect(as(`
      insert into bureau_enquiries (profile_id, id_number_hash, p_version)
        values ('${ALICE}', '${HASH_A}', '4.0');
    `)).rejects.toThrow(/permission denied/i);
  });

  it('and cannot update or delete an existing row', async () => {
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A);
    await expect(as("update bureau_enquiries set decision = 'approved';"))
      .rejects.toThrow(/permission denied/i);
    await expect(as('delete from bureau_enquiries;'))
      .rejects.toThrow(/permission denied/i);
    await asService('delete from bureau_enquiries;');
  });
});

describe('the in-flight unique index — the money control', () => {
  beforeAll(async () => { await asService('delete from bureau_enquiries;'); });

  it('a second open attempt for the same ID hash is refused', async () => {
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A);
    // Two tabs, two serverless invocations, one billable call. The second
    // insert failing is the guard working — enquiryStore.openAttempt catches
    // 23505 and returns null rather than calling Experian.
    await expect(openAttempt(HASH_A)).rejects.toThrow(/bureau_enquiries_one_in_flight|duplicate key/i);
  });

  it('closing the attempt releases the slot', async () => {
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A);
    await asService(`update bureau_enquiries set completed_at = now() where id_number_hash = '${HASH_A}';`);
    // A later enquiry for the same person is allowed again — the index guards
    // CONCURRENCY, not history. The 45-day cache is what stops the re-pull.
    await expect(openAttempt(HASH_A)).resolves.toBeDefined();
  });

  it('many COMPLETED enquiries for one ID coexist, so history is kept', async () => {
    await asService('delete from bureau_enquiries;');
    for (let i = 0; i < 3; i++) {
      await openAttempt(HASH_A);
      await asService(`update bureau_enquiries set completed_at = now() where completed_at is null;`);
    }
    const rows = await asService<{ n: string }>(`
      select count(*)::text as n from bureau_enquiries where id_number_hash = '${HASH_A}';
    `);
    expect(rows[0].n).toBe('3');
  });

  it('different IDs are in flight independently', async () => {
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A);
    await expect(openAttempt(HASH_B)).resolves.toBeDefined();
  });
});

describe('the CHECK constraints encode the decisions', () => {
  beforeAll(async () => { await asService('delete from bureau_enquiries;'); });

  it('a NEGATIVE score is refused — a warning code is not a score', async () => {
    // -2 is deceased. Filing it as a score is how "deceased" becomes
    // "declined for risk": the wrong decision AND the wrong §71 reason.
    await asService('delete from bureau_enquiries;');
    const [row] = await openAttempt(HASH_A) as Array<{ id: string }>;
    await expect(asService(`
      update bureau_enquiries set score = -2 where id = '${row.id}';
    `)).rejects.toThrow(/bureau_enquiries_score_non_negative/);
  });

  it('a zero score is allowed, so the constraint is not just "truthy"', async () => {
    const rows = await asService<{ id: string }>(
      `select id from bureau_enquiries where id_number_hash = '${HASH_A}' limit 1;`,
    );
    await expect(asService(`update bureau_enquiries set score = 0 where id = '${rows[0].id}';`))
      .resolves.toBeDefined();
  });

  it('a band outside 1–5 is refused at both ends', async () => {
    const rows = await asService<{ id: string }>(
      `select id from bureau_enquiries where id_number_hash = '${HASH_A}' limit 1;`,
    );
    for (const band of [0, 6, -1]) {
      await expect(
        asService(`update bureau_enquiries set risk_band = ${band} where id = '${rows[0].id}';`),
        `band ${band}`,
      ).rejects.toThrow(/bureau_enquiries_band_range/);
    }
  });

  it('a negative exposure is refused', async () => {
    const rows = await asService<{ id: string }>(
      `select id from bureau_enquiries where id_number_hash = '${HASH_A}' limit 1;`,
    );
    await expect(asService(`
      update bureau_enquiries set risk_exposure_cents = -1 where id = '${rows[0].id}';
    `)).rejects.toThrow(/bureau_enquiries_exposure_non_negative/);
  });

  it('the outcome vocabulary is closed', async () => {
    const rows = await asService<{ id: string }>(
      `select id from bureau_enquiries where id_number_hash = '${HASH_A}' limit 1;`,
    );
    // Every kind ExperianOutcome can produce is accepted...
    for (const ok of ['ok', 'thin_file', 'input_error', 'config_error', 'provider_error', 'transport_error']) {
      await expect(
        asService(`update bureau_enquiries set outcome = '${ok}' where id = '${rows[0].id}';`),
        ok,
      ).resolves.toBeDefined();
    }
    // ...and anything else means the application and the table have drifted.
    await expect(asService(`
      update bureau_enquiries set outcome = 'success' where id = '${rows[0].id}';
    `)).rejects.toThrow(/bureau_enquiries_outcome_chk/);
  });

  it('the decision vocabulary is closed', async () => {
    const rows = await asService<{ id: string }>(
      `select id from bureau_enquiries where id_number_hash = '${HASH_A}' limit 1;`,
    );
    for (const ok of ['approved', 'declined', 'referred', 'error']) {
      await expect(
        asService(`update bureau_enquiries set decision = '${ok}' where id = '${rows[0].id}';`),
        ok,
      ).resolves.toBeDefined();
    }
    await expect(asService(`
      update bureau_enquiries set decision = 'passed' where id = '${rows[0].id}';
    `)).rejects.toThrow(/bureau_enquiries_decision_chk/);
  });

  it('id_number_hash is mandatory — an unattributable enquiry is not an audit record', async () => {
    await expect(asService(`
      insert into bureau_enquiries (profile_id, p_version) values ('${ALICE}', '4.0');
    `)).rejects.toThrow(/id_number_hash/);
  });

  it('p_version is mandatory, so a scorecard shift can always be attributed', async () => {
    await expect(asService(`
      insert into bureau_enquiries (profile_id, id_number_hash) values ('${ALICE}', '${HASH_B}');
    `)).rejects.toThrow(/p_version/);
  });
});

describe('the audit record outlives the account', () => {
  it('deleting a profile nulls the reference and KEEPS the row', async () => {
    // ON DELETE SET NULL, not CASCADE. A closed account does not erase the
    // fact that we made a billable enquiry against a credit bureau — that is
    // the audit fact, and it is also what Experian will invoice for.
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A, BOB);
    await asService(`delete from profiles where id = '${BOB}';`);

    const rows = await asService<{ profile_id: string | null; id_number_hash: string }>(`
      select profile_id, id_number_hash from bureau_enquiries;
    `);
    expect(rows.length).toBe(1);
    expect(rows[0].profile_id).toBeNull();
    expect(rows[0].id_number_hash).toBe(HASH_A);
  });
});

describe('defaults match what the application assumes', () => {
  it('a fresh attempt row is unbilled, uncompleted and carries no reason codes', async () => {
    await asService('delete from bureau_enquiries;');
    await openAttempt(HASH_A);
    const rows = await asService<{
      billed: boolean; completed_at: string | null; reason_codes: string[];
      provider: string; product: string;
    }>(`
      select billed, completed_at, reason_codes, provider, product from bureau_enquiries;
    `);
    expect(rows[0].billed).toBe(false);
    expect(rows[0].completed_at).toBeNull();
    expect(rows[0].reason_codes).toEqual([]);
    expect(rows[0].provider).toBe('experian');
    expect(rows[0].product).toBe('person_get_score');
  });
});
