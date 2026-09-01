// @vitest-environment node
//
// ─── The atomic credit claim (A-04) and the allowance model (A-05) ────────
//
// `checkCreditLimit` read the limit, decided, and returned; the caller wrote
// the schedule afterwards. Nothing between them was atomic and no database
// invariant related `payments` in aggregate to `approved_credit_limit`, so
// five concurrent acceptances against a R5,000 limit all passed and R25,000
// committed (proved in lib/underwriting/creditLimit.race.adversarial.test.ts).
//
// 0130 replaces that with one function that locks, decides and writes, plus a
// DEFERRED constraint trigger as the invariant behind it.
//
// ─── What pglite can and cannot show here, stated plainly ────────────────
//
// pglite is a single connection, so this file cannot run two genuinely
// concurrent transactions. It does not need to, because the two mechanisms
// are separable and both are testable:
//
//   • THE LOCK (`SELECT … FOR UPDATE` on the profile row) turns a race into
//     a clean, ordered refusal. Its observable consequence is that a second
//     claim sees the first claim's committed schedule — asserted directly.
//
//   • THE DEFERRED TRIGGER is what actually closes the race, and it closes it
//     WITHOUT the lock. Two overlapping transactions both insert; the first
//     commits; the second's constraint trigger fires at ITS commit, runs its
//     SELECT under READ COMMITTED, sees the first transaction's committed
//     rows, and raises. That ordering — trigger fires at COMMIT, after the
//     other transaction's rows are visible — is exactly what the explicit
//     BEGIN/COMMIT pairs below reproduce.
//
// So the interleaving is not simulated; the mechanism that defeats it is
// exercised at the point where it acts.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { splitInstalmentsWithExcess, MIN_FINANCED_RANDS } from '@/lib/finance';

const MIG = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0130_claim_credit_for_plan.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const PATIENT = '0000000p-0000-0000-0000-00000000000p'.replace(/p/g, 'a');
const PLAN_1  = '00000001-0000-0000-0000-000000000001';
const PLAN_2  = '00000002-0000-0000-0000-000000000002';
const PRACTICE = '000000f0-0000-0000-0000-0000000000f0';

const SCHEMA = `
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

  create table profiles (
    id uuid primary key,
    approved_credit_limit numeric(10,2)
  );
  create table practices (id uuid primary key);
  create table plans (
    id uuid primary key,
    patient_id uuid references profiles(id),
    practice_id uuid references practices(id),
    total_amount numeric(10,2) not null,
    instalment_amount numeric(10,2),
    plan_type int,
    status text not null default 'pending_acceptance',
    terms_accepted_at timestamptz,
    terms_version text,
    privacy_version text
  );
  create table payments (
    id uuid primary key,
    plan_id uuid references plans(id),
    patient_id uuid references profiles(id),
    instalment_number int,
    amount numeric(10,2) not null,
    due_date date not null,
    status text not null default 'scheduled',
    kind text not null default 'instalment',
    collected_at timestamptz
  );
`;

type Claim = {
  ok: boolean;
  error?: string;
  financed?: number | string;
  excess?: number | string;
  available?: number | string;
  available_before?: number | string;
  minimum?: number | string;
  instalment_one_id?: string;
};

let db: PGlite;

/** Call the claim the way a server action would, splitting via lib/finance. */
async function claim(opts: {
  planId?: string;
  total: number;
  planType: 2 | 3;
  available: number;
  expectedStatus?: string;
  /** Override the computed amounts, to test the validation. */
  amounts?: number[];
  excess?: number;
}): Promise<Claim> {
  const split = splitInstalmentsWithExcess(opts.total, opts.planType, opts.available);
  const amounts = opts.amounts ?? split.instalments;
  const excess  = opts.excess  ?? split.excess;
  // Nov 2026, Dec 2026, Jan 2027 — a 3-instalment plan crosses a year, which
  // naive month arithmetic gets wrong (`2026-13-01`).
  const dates   = ['2026-11-01', '2026-12-01', '2027-01-01'].slice(0, amounts.length);

  const res = await db.query<{ claim_credit_for_plan: Claim }>(
    `select claim_credit_for_plan(
       $1::uuid, $2::uuid, $3::int, $4::numeric[], $5::numeric, $6::date[], $7, $8, $9
     ) as claim_credit_for_plan`,
    [
      opts.planId ?? PLAN_1, PATIENT, opts.planType,
      `{${amounts.join(',')}}`, excess, `{${dates.join(',')}}`,
      opts.expectedStatus ?? 'pending_acceptance', 'v1', 'v1',
    ],
  );
  return res.rows[0].claim_credit_for_plan;
}

const num = (v: unknown) => Number(v);

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG);
  await db.exec(`
    insert into practices (id) values ('${PRACTICE}');
    insert into profiles (id, approved_credit_limit) values ('${PATIENT}', 15000);
    insert into plans (id, patient_id, practice_id, total_amount) values
      ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 30000),
      ('${PLAN_2}', '${PATIENT}', '${PRACTICE}', 9000);
  `);
}, 60_000);

afterEach(async () => { await db?.close(); });

describe('0130 — the allowance model (A-05)', () => {
  it('the worked example: R30,000 bill on a R15,000 allowance', async () => {
    const c = await claim({ total: 30000, planType: 3, available: 15000 });
    expect(c.ok).toBe(true);
    expect(num(c.financed)).toBe(15000);
    expect(num(c.excess)).toBe(15000);

    const rows = await db.query<{ instalment_number: number; amount: string; status: string }>(
      `select instalment_number, amount, status from payments
        where plan_id = '${PLAN_1}' order by instalment_number;`);
    expect(rows.rows.map(r => Number(r.amount))).toEqual([20000, 5000, 5000]);
    // Instalment 1 is the one the charge fires against immediately.
    expect(rows.rows.map(r => r.status)).toEqual(['processing', 'scheduled', 'scheduled']);
  });

  it('records both halves of the split on the plan', async () => {
    await claim({ total: 30000, planType: 3, available: 15000 });
    const p = await db.query<{ financed_amount: string; excess_amount: string; status: string; plan_type: number }>(
      `select financed_amount, excess_amount, status, plan_type from plans where id = '${PLAN_1}';`);
    expect(Number(p.rows[0].financed_amount)).toBe(15000);
    expect(Number(p.rows[0].excess_amount)).toBe(15000);
    expect(p.rows[0].status).toBe('pending_first_payment');
    expect(p.rows[0].plan_type).toBe(3);
  });

  it('a bill inside the allowance has no excess and splits evenly', async () => {
    const c = await claim({ planId: PLAN_2, total: 9000, planType: 3, available: 15000 });
    expect(c.ok).toBe(true);
    expect(num(c.excess)).toBe(0);
    const rows = await db.query<{ amount: string }>(
      `select amount from payments where plan_id = '${PLAN_2}' order by instalment_number;`);
    expect(rows.rows.map(r => Number(r.amount))).toEqual([3000, 3000, 3000]);
  });

  it('the SQL minimum agrees with MIN_FINANCED_RANDS in lib/finance.ts', async () => {
    // The one constant this fix duplicates across languages. Parsed from the
    // migration rather than restated, so drift fails here.
    const m = /c_min_financed\s+CONSTANT\s+NUMERIC\s*:=\s*([0-9.]+)/.exec(MIG);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(MIN_FINANCED_RANDS);
  });

  it('refuses when there is nothing worth financing', async () => {
    await db.exec(`update profiles set approved_credit_limit = 100 where id = '${PATIENT}';`);
    const c = await claim({ total: 30000, planType: 3, available: 100 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('below_minimum');
    expect(num(c.minimum)).toBe(MIN_FINANCED_RANDS);
  });
});

describe('0130 — the claim is atomic (A-04)', () => {
  it('a second claim sees the first claim\'s exposure and is refused', async () => {
    // The observable consequence of the lock: sequential ordering, and the
    // loser is told why rather than silently doubling the exposure.
    const first = await claim({ planId: PLAN_2, total: 9000, planType: 3, available: 15000 });
    expect(first.ok).toBe(true);

    const second = await claim({ planId: PLAN_1, total: 30000, planType: 3, available: 15000 });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('over_limit');
    // 15,000 limit − 9,000 already committed.
    expect(num(second.available)).toBe(6000);
  });

  it('and the same plan cannot be claimed twice', async () => {
    await claim({ total: 30000, planType: 3, available: 15000 });
    // The plan is no longer at pending_acceptance, so the status precondition
    // refuses — this is the idempotency guard, not the limit.
    const again = await claim({ total: 30000, planType: 3, available: 15000 });
    expect(again.ok).toBe(false);
    expect(again.error).toBe('plan_not_found');
  });

  it('exposure counts the FINANCED part, not the uncollected total', async () => {
    // PLAN_1: 30,000 bill, 15,000 financed, 15,000 excess on instalment 1.
    // Uncollected instalments total 30,000 — but HNPL is only carrying
    // 15,000, and only that should consume the allowance.
    await claim({ total: 30000, planType: 3, available: 15000 });
    await db.exec(`update plans set status = 'active' where id = '${PLAN_1}';`);
    await db.exec(`update profiles set approved_credit_limit = 20000 where id = '${PATIENT}';`);

    // 20,000 limit − 15,000 financed exposure = 5,000 of headroom. A 4,500
    // bill must fit. If the excess were being counted, exposure would read
    // 30,000 and this would be refused.
    await db.exec(`update plans set total_amount = 4500 where id = '${PLAN_2}';`);
    const c = await claim({ planId: PLAN_2, total: 4500, planType: 3, available: 5000 });
    expect(c.ok).toBe(true);
  });

  it('a collected instalment stops consuming the allowance', async () => {
    await claim({ planId: PLAN_2, total: 9000, planType: 3, available: 15000 });
    await db.exec(`
      update plans set status = 'active' where id = '${PLAN_2}';
      update payments set status = 'collected', collected_at = now()
        where plan_id = '${PLAN_2}' and instalment_number = 1;
    `);
    // 9,000 financed, 3,000 collected → 6,000 outstanding → 9,000 headroom.
    await db.exec(`update plans set total_amount = 9000 where id = '${PLAN_1}';`);
    const c = await claim({ planId: PLAN_1, total: 9000, planType: 3, available: 9000 });
    expect(c.ok).toBe(true);
  });

  it('refuses a patient with no approved allowance', async () => {
    await db.exec(`update profiles set approved_credit_limit = null where id = '${PATIENT}';`);
    const c = await claim({ total: 30000, planType: 3, available: 0 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('no_limit');
  });
});

describe('0130 — the caller\'s split is validated, not trusted', () => {
  it('refuses amounts that do not sum to the bill total', async () => {
    // Understating the bill to fit the allowance.
    const c = await claim({ total: 30000, planType: 3, available: 15000, amounts: [5000, 5000, 5000], excess: 0 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('amounts_mismatch');
  });

  it('refuses an excess spread across later instalments', async () => {
    // Sums to 30,000, but the excess is not wholly on instalment 1 — which
    // would leave HNPL carrying it for two more months.
    const c = await claim({ total: 30000, planType: 3, available: 15000, amounts: [10000, 10000, 10000], excess: 15000 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('excess_misplaced');
  });

  it('refuses an understated excess — the financed part is what is checked', async () => {
    // Claims only 1,000 is excess, so financed reads 29,000 against a
    // 15,000 allowance.
    const c = await claim({ total: 30000, planType: 3, available: 15000, amounts: [20000, 5000, 5000], excess: 1000 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('over_limit');
  });

  it('refuses a negative instalment', async () => {
    const c = await claim({ total: 30000, planType: 3, available: 15000, amounts: [40000, -5000, -5000], excess: 15000 });
    expect(c.ok).toBe(false);
    expect(['amounts_mismatch', 'excess_misplaced']).toContain(c.error);
  });

  it('refuses a wrong-length amounts array', async () => {
    const c = await claim({ total: 30000, planType: 3, available: 15000, amounts: [30000], excess: 15000 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('amounts_mismatch');
  });

  it('refuses a plan that belongs to somebody else', async () => {
    await db.exec(`
      insert into profiles (id, approved_credit_limit) values ('0000000b-0000-0000-0000-00000000000b', 15000);
      update plans set patient_id = '0000000b-0000-0000-0000-00000000000b' where id = '${PLAN_1}';
    `);
    const c = await claim({ total: 30000, planType: 3, available: 15000 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('plan_not_found');
  });

  it('refuses to overwrite a schedule with a collected row in it', async () => {
    // The F-06 lesson: a plan whose charge landed must not be rewritten.
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
        values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 20000, '2026-11-01', 'collected', 'instalment');
    `);
    const c = await claim({ total: 30000, planType: 3, available: 15000 });
    expect(c.ok).toBe(false);
    expect(c.error).toBe('schedule_survived');
  });

  it('but DOES clear an abandoned scheduled/processing/failed schedule', async () => {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind) values
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 1, '2026-11-01', 'processing', 'instalment'),
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 2, 1, '2026-12-01', 'failed',     'instalment');
    `);
    const c = await claim({ total: 30000, planType: 3, available: 15000 });
    expect(c.ok).toBe(true);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from payments where plan_id = '${PLAN_1}';`);
    expect(rows.rows[0].n).toBe(3);
  });
});

describe('0130 — the deferred trigger is the invariant behind the claim', () => {
  // This is the layer that closes the race even without the lock: the trigger
  // fires at COMMIT, so the second transaction to commit sees the first one's
  // rows and raises.

  it('a direct over-limit schedule is refused at COMMIT, not at INSERT', async () => {
    await db.exec('begin;');
    // Each INSERT individually succeeds — a per-row trigger would have fired
    // on the first one and seen a half-written plan.
    await db.exec(`
      update plans set status = 'pending_first_payment' where id = '${PLAN_1}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind) values
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 20000, '2026-11-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 2, 20000, '2026-12-01', 'scheduled', 'instalment');
    `);
    await expect(db.exec('commit;')).rejects.toThrow(/exceeds the approved limit/i);
  });

  it('a schedule within the limit commits', async () => {
    await db.exec('begin;');
    await db.exec(`
      update plans set status = 'pending_first_payment' where id = '${PLAN_2}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind) values
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 1, 3000, '2026-11-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 2, 3000, '2026-12-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 3, 3000, '2027-01-01', 'scheduled', 'instalment');
    `);
    await db.exec('commit;');
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from payments;`);
    expect(rows.rows[0].n).toBe(3);
  });

  it('THE RACE: a second transaction committing after the first is refused', async () => {
    // T1 claims 9,000 of a 15,000 allowance and commits.
    await db.exec('begin;');
    await db.exec(`
      update plans set status = 'pending_first_payment' where id = '${PLAN_2}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind) values
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 1, 3000, '2026-11-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 2, 3000, '2026-12-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_2}', '${PATIENT}', 3, 3000, '2027-01-01', 'scheduled', 'instalment');
    `);
    await db.exec('commit;');

    // T2 was written against the SAME pre-T1 view of the world — it believes
    // 15,000 is available — and commits second. Its trigger runs at COMMIT
    // under READ COMMITTED, sees T1's rows, and refuses. This is the exact
    // interleaving A-04 exploited; without the trigger both would land.
    await db.exec('begin;');
    await db.exec(`
      update plans set status = 'pending_first_payment', excess_amount = 0 where id = '${PLAN_1}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind) values
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 5000, '2026-11-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 2, 5000, '2026-12-01', 'scheduled', 'instalment'),
        (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 3, 5000, '2027-01-01', 'scheduled', 'instalment');
    `);
    await expect(db.exec('commit;')).rejects.toThrow(/exceeds the approved limit/i);

    // And the ledger is left holding only T1's schedule.
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from payments;`);
    expect(rows.rows[0].n).toBe(3);
  });

  it('is silent for a patient with no approved limit', async () => {
    // Not this trigger's decision to make — claim_credit_for_plan returns
    // 'no_limit'. A constraint blocking every write for such a patient would
    // break the webhook marking an old instalment collected.
    await db.exec(`update profiles set approved_credit_limit = null where id = '${PATIENT}';`);
    await db.exec('begin;');
    await db.exec(`
      update plans set status = 'active' where id = '${PLAN_1}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
        values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 99999, '2026-11-01', 'scheduled', 'instalment');
    `);
    await db.exec('commit;');
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from payments;`);
    expect(rows.rows[0].n).toBe(1);
  });

  it('ignores plans that are not live', async () => {
    // A cancelled or completed plan is not exposure.
    await db.exec('begin;');
    await db.exec(`
      update plans set status = 'cancelled' where id = '${PLAN_1}';
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
        values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 99999, '2026-11-01', 'scheduled', 'instalment');
    `);
    await db.exec('commit;');
    const rows = await db.query<{ n: number }>(`select count(*)::int as n from payments;`);
    expect(rows.rows[0].n).toBe(1);
  });
});

describe('0130 — the claim is server-side only', () => {
  it('is revoked from PUBLIC', async () => {
    // 0125's contract: a new function is private, and anything a browser must
    // reach needs an explicit grant. This one must never get one.
    const sig = 'claim_credit_for_plan(uuid,uuid,integer,numeric[],numeric,date[],text,text,text)';
    const r = await db.query<{ ok: boolean }>(
      `select has_function_privilege('public', $1, 'EXECUTE') as ok`, [sig]);
    expect(r.rows[0].ok).toBe(false);
  });
});
