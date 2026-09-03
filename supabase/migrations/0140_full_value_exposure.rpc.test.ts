// @vitest-environment node
//
// ─── The full-value exposure model, against real Postgres ───────────────
//
// 0140 reverses 0130's declining-balance model: a plan holds its ENTIRE
// financed value for its whole life and releases the whole amount in one
// step at completion. Paying an instalment frees nothing.
//
// Exercised here rather than only in TypeScript because the authority is
// the plpgsql — `patient_credit_exposure()` under the row lock — and
// because 0140 changes both the claim function AND the deferred constraint
// trigger. The two must agree; if they did not, one would refuse writes
// the other permitted.
//
// Both models are tested: plans written before 0140 keep the arithmetic
// they were accepted under, so nobody's in-flight headroom moved when the
// rule changed.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), `supabase/migrations/${name}`), 'utf8')
    .replace(/\r\n/g, '\n');
}

const MIG_0130 = migration('0130_claim_credit_for_plan.sql');
const MIG_0139 = migration('0139_credit_assessment.sql');
const MIG_0140 = migration('0140_full_value_exposure.sql');

const PATIENT  = 'aaaaaaaa-0000-0000-0000-00000000000a';
const PLAN_1   = '00000001-0000-0000-0000-000000000001';
const PLAN_2   = '00000002-0000-0000-0000-000000000002';
const PLAN_3   = '00000003-0000-0000-0000-000000000003';
const PRACTICE = '000000f0-0000-0000-0000-0000000000f0';

// The columns 0139 and 0140 add are applied by the migrations themselves,
// so the base schema here is the pre-0139 shape.
const SCHEMA = `
  create schema if not exists auth;
  create or replace function auth.uid()  returns uuid language sql stable as $$ select null::uuid $$;
  create or replace function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;

  create table profiles (
    id uuid primary key,
    approved_credit_limit numeric(10,2),
    credit_check_completed_at timestamptz
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

let db: PGlite;

const num = (v: unknown) => Number(v);

async function exposure(excludePlan: string | null = null): Promise<number> {
  const res = await db.query<{ e: string }>(
    'select patient_credit_exposure($1::uuid, $2::uuid) as e',
    [PATIENT, excludePlan],
  );
  return num(res.rows[0].e);
}

/** Write a plan plus its schedule directly, bypassing the claim function. */
async function seedPlan(opts: {
  id: string;
  total: number;
  financed?: number;
  excess?: number;
  status?: string;
  fullValue: boolean;
  instalments: Array<{ n: number; amount: number; status: string }>;
}) {
  await db.exec(`
    insert into plans (id, patient_id, practice_id, total_amount, financed_amount,
                       excess_amount, status, full_value_exposure)
    values ('${opts.id}', '${PATIENT}', '${PRACTICE}', ${opts.total},
            ${opts.financed ?? opts.total}, ${opts.excess ?? 0},
            '${opts.status ?? 'active'}', ${opts.fullValue});
  `);
  for (const i of opts.instalments) {
    await db.exec(`
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values (gen_random_uuid(), '${opts.id}', '${PATIENT}', ${i.n}, ${i.amount},
              '2026-11-0${i.n}', '${i.status}', 'instalment');
    `);
  }
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(MIG_0130);
  await db.exec(MIG_0139);
  await db.exec(MIG_0140);
  await db.exec(`
    insert into practices (id) values ('${PRACTICE}');
    insert into profiles (id, approved_credit_limit) values ('${PATIENT}', 15000);
  `);
});

afterEach(async () => { await db?.close(); });

// ═══ The migrations apply at all ═══════════════════════════════════════

describe('0139 and 0140 apply cleanly on top of 0130', () => {
  it('creates the assessment log, the exposure function and the new columns', async () => {
    const tables = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_name = 'credit_assessments'`);
    expect(tables.rows).toHaveLength(1);

    const fn = await db.query<{ proname: string }>(
      `select proname from pg_proc where proname = 'patient_credit_exposure'`);
    expect(fn.rows).toHaveLength(1);

    const cols = await db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_name = 'plans' and column_name in ('full_value_exposure','credit_assessment_id')`);
    expect(cols.rows.map((r) => r.column_name).sort())
      .toEqual(['credit_assessment_id', 'full_value_exposure']);
  });

  it('defaults existing plans to the legacy model', async () => {
    await db.exec(`insert into plans (id, patient_id, practice_id, total_amount)
                   values ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 5000);`);
    const r = await db.query<{ full_value_exposure: boolean }>(
      `select full_value_exposure from plans where id = '${PLAN_1}'`);
    expect(r.rows[0].full_value_exposure).toBe(false);
  });
});

// ═══ The rule the model turns on ═══════════════════════════════════════

describe('a full-value plan holds its whole value for its whole life', () => {
  it('headroom does NOT change when an instalment is paid', async () => {
    await seedPlan({
      id: PLAN_1, total: 6000, fullValue: true,
      instalments: [
        { n: 1, amount: 2000, status: 'processing' },
        { n: 2, amount: 2000, status: 'scheduled' },
        { n: 3, amount: 2000, status: 'scheduled' },
      ],
    });
    expect(await exposure()).toBe(6000);

    // Collect instalment 1. Under declining balance this would drop to 4000.
    await db.exec(`update payments set status = 'collected'
                    where plan_id = '${PLAN_1}' and instalment_number = 1;`);
    expect(await exposure()).toBe(6000);

    // And instalment 2.
    await db.exec(`update payments set status = 'collected'
                    where plan_id = '${PLAN_1}' and instalment_number = 2;`);
    expect(await exposure()).toBe(6000);
  });

  it('releases the whole amount in one step on completion', async () => {
    await seedPlan({
      id: PLAN_1, total: 6000, fullValue: true,
      instalments: [{ n: 1, amount: 6000, status: 'collected' }],
    });
    expect(await exposure()).toBe(6000);

    await db.exec(`update plans set status = 'completed' where id = '${PLAN_1}';`);
    expect(await exposure()).toBe(0);
  });

  it('a cancelled plan releases in full', async () => {
    await seedPlan({
      id: PLAN_1, total: 6000, fullValue: true,
      instalments: [{ n: 1, amount: 6000, status: 'scheduled' }],
    });
    await db.exec(`update plans set status = 'cancelled' where id = '${PLAN_1}';`);
    expect(await exposure()).toBe(0);
  });

  it('a DEFAULTED plan keeps holding its value', async () => {
    await seedPlan({
      id: PLAN_1, total: 6000, fullValue: true,
      instalments: [{ n: 1, amount: 6000, status: 'defaulted' }],
    });
    await db.exec(`update plans set status = 'defaulted' where id = '${PLAN_1}';`);
    expect(await exposure()).toBe(6000);
  });

  it('counts the financed part, not the gross, when there was an excess', async () => {
    await seedPlan({
      id: PLAN_1, total: 20000, financed: 15000, excess: 5000, fullValue: true,
      instalments: [
        { n: 1, amount: 10000, status: 'scheduled' },
        { n: 2, amount: 10000, status: 'scheduled' },
      ],
    });
    expect(await exposure()).toBe(15000);
  });

  it('sums across concurrent plans', async () => {
    await seedPlan({ id: PLAN_1, total: 3000, fullValue: true,
      instalments: [{ n: 1, amount: 3000, status: 'scheduled' }] });
    await seedPlan({ id: PLAN_2, total: 2000, fullValue: true,
      instalments: [{ n: 1, amount: 2000, status: 'scheduled' }] });
    expect(await exposure()).toBe(5000);
  });

  it('excludes the plan being claimed right now', async () => {
    await seedPlan({ id: PLAN_1, total: 3000, fullValue: true,
      instalments: [{ n: 1, amount: 3000, status: 'scheduled' }] });
    expect(await exposure(PLAN_1)).toBe(0);
  });
});

// ═══ Legacy plans are untouched ════════════════════════════════════════

describe('plans written before 0140 keep declining balance', () => {
  it('a half-paid legacy plan owes less, exactly as it did under 0130', async () => {
    await seedPlan({
      id: PLAN_1, total: 5000, fullValue: false,
      instalments: [
        { n: 1, amount: 2500, status: 'collected' },
        { n: 2, amount: 2500, status: 'scheduled' },
      ],
    });
    expect(await exposure()).toBe(2500);
  });

  it('subtracts the excess while instalment 1 is outstanding', async () => {
    await seedPlan({
      id: PLAN_1, total: 5000, excess: 1000, fullValue: false,
      instalments: [
        { n: 1, amount: 3000, status: 'scheduled' },
        { n: 2, amount: 2000, status: 'scheduled' },
      ],
    });
    expect(await exposure()).toBe(4000);
  });

  it('a defaulted LEGACY plan holds nothing — the status set is unchanged', async () => {
    // Counting it would retroactively tighten a limit the patient already
    // has, which is exactly what the two-model split exists to prevent.
    await seedPlan({
      id: PLAN_1, total: 5000, fullValue: false, status: 'defaulted',
      instalments: [{ n: 1, amount: 5000, status: 'defaulted' }],
    });
    expect(await exposure()).toBe(0);
  });

  it('the two models coexist and add up', async () => {
    await seedPlan({ id: PLAN_1, total: 4000, fullValue: true,
      instalments: [{ n: 1, amount: 4000, status: 'collected' }] });   // holds 4000
    await seedPlan({ id: PLAN_2, total: 5000, fullValue: false,
      instalments: [
        { n: 1, amount: 2500, status: 'collected' },
        { n: 2, amount: 2500, status: 'scheduled' },
      ] });                                                             // holds 2500
    expect(await exposure()).toBe(6500);
  });
});

// ═══ The claim function, end to end ════════════════════════════════════

async function claim(planId: string, total: number, planType: 2 | 3, amounts: number[]) {
  const dates = ['2026-11-01', '2026-12-01', '2027-01-01'].slice(0, amounts.length);
  const res = await db.query<{ c: { ok: boolean; error?: string; available?: string } }>(
    `select claim_credit_for_plan($1::uuid,$2::uuid,$3::int,$4::numeric[],$5::numeric,
                                  $6::date[],$7,$8,$9) as c`,
    [planId, PATIENT, planType, `{${amounts.join(',')}}`, 0, `{${dates.join(',')}}`,
     'pending_acceptance', 'v1', 'v1'],
  );
  return res.rows[0].c;
}

describe('claim_credit_for_plan under the new model', () => {
  beforeEach(async () => {
    await db.exec(`
      insert into plans (id, patient_id, practice_id, total_amount, status) values
        ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 6000, 'pending_acceptance'),
        ('${PLAN_2}', '${PATIENT}', '${PRACTICE}', 6000, 'pending_acceptance'),
        ('${PLAN_3}', '${PATIENT}', '${PRACTICE}', 3000, 'pending_acceptance');
    `);
  });

  it('marks everything it writes as full-value', async () => {
    const c = await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    expect(c.ok).toBe(true);

    const r = await db.query<{ full_value_exposure: boolean }>(
      `select full_value_exposure from plans where id = '${PLAN_1}'`);
    expect(r.rows[0].full_value_exposure).toBe(true);
  });

  it('a first-timer cannot hold a second plan even with headroom to spare', async () => {
    // Limit 15,000; first plan 6,000; so 9,000 of headroom is available and
    // the SECOND plan at 6,000 fits comfortably. The concurrency rule binds
    // first, which is the whole point — for a first-timer the effective
    // exposure is one plan's value, not the limit.
    expect((await claim(PLAN_1, 6000, 3, [2000, 2000, 2000])).ok).toBe(true);

    const second = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('first_plan_in_progress');
  });

  it('paying instalments does not unlock a second plan either', async () => {
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update payments set status = 'collected' where plan_id = '${PLAN_1}';`);

    const second = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(second.error).toBe('first_plan_in_progress');
  });

  it('completing the first plan unlocks multi-plan', async () => {
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update plans set status = 'completed' where id = '${PLAN_1}';`);

    const second = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(second.ok).toBe(true);
  });

  it('a DEFAULTED first plan blocks further plans pending review', async () => {
    // Not merely "still a first-timer": the patient's only track record is
    // a default, so there is nothing to lend against.
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update plans set status = 'defaulted' where id = '${PLAN_1}';`);

    const second = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(second.ok).toBe(false);
    expect(second.error).toBe('prior_default_review');
  });

  it('a default does NOT unlock multi-plan for a patient who never completed', async () => {
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update plans set status = 'defaulted' where id = '${PLAN_1}';`);
    const r = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(r.ok).toBe(false);
  });

  it('a CANCELLED first plan allows a new plan but leaves them a first-timer', async () => {
    // A cancellation means the plan never really originated — the same
    // reasoning that releases its headroom in full. Blocking here would
    // punish patients for practice-side cancellations.
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update plans set status = 'cancelled' where id = '${PLAN_1}';`);

    const second = await claim(PLAN_2, 6000, 3, [2000, 2000, 2000]);
    expect(second.ok).toBe(true);

    // Still a first-timer: no second CONCURRENT plan.
    const third = await claim(PLAN_3, 3000, 3, [1000, 1000, 1000]);
    expect(third.ok).toBe(false);
    expect(third.error).toBe('first_plan_in_progress');
  });

  it('once unlocked, a plan exceeding remaining headroom is still refused', async () => {
    // Complete a first plan to unlock multi-plan, then overspend.
    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);
    await db.exec(`update plans set status = 'completed' where id = '${PLAN_1}';`);
    await db.exec(`update profiles set approved_credit_limit = 7000 where id = '${PATIENT}';`);

    expect((await claim(PLAN_2, 6000, 3, [2000, 2000, 2000])).ok).toBe(true);
    // 7,000 limit less 6,000 held in full = 1,000 available; a 3,000 plan
    // does not fit. Under declining balance this would depend on what had
    // been collected — under this model it never does.
    const third = await claim(PLAN_3, 3000, 3, [1000, 1000, 1000]);
    expect(third.ok).toBe(false);
    expect(['over_limit', 'below_minimum']).toContain(third.error);
  });

  it('stamps the assessment that authorised the plan', async () => {
    const a = await db.query<{ id: string }>(
      `insert into credit_assessments (patient_id, trigger, outcome, coefficient_version)
       values ('${PATIENT}', 'signup', 'approved', '2026.27-r1') returning id`);
    await db.exec(`update profiles set current_credit_assessment_id = '${a.rows[0].id}'
                    where id = '${PATIENT}';`);

    await claim(PLAN_1, 6000, 3, [2000, 2000, 2000]);

    const r = await db.query<{ credit_assessment_id: string }>(
      `select credit_assessment_id from plans where id = '${PLAN_1}'`);
    expect(r.rows[0].credit_assessment_id).toBe(a.rows[0].id);
  });
});

// ═══ The deferred invariant agrees with the claim ══════════════════════

describe('the constraint trigger uses the same derivation as the claim', () => {
  it('refuses a schedule written directly that would breach the limit', async () => {
    await db.exec(`update profiles set approved_credit_limit = 5000 where id = '${PATIENT}';`);
    await db.exec(`insert into plans (id, patient_id, practice_id, total_amount, financed_amount,
                                      status, full_value_exposure)
                   values ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 9000, 9000, 'active', true);`);

    await expect(db.exec(`
      begin;
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 9000, '2026-11-01', 'scheduled', 'instalment');
      commit;
    `)).rejects.toThrow(/exceeds the approved limit/);
  });

  it('permits a schedule that fits', async () => {
    await db.exec(`insert into plans (id, patient_id, practice_id, total_amount, financed_amount,
                                      status, full_value_exposure)
                   values ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 6000, 6000, 'active', true);`);
    await db.exec(`
      begin;
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 6000, '2026-11-01', 'scheduled', 'instalment');
      commit;
    `);
    expect(await exposure()).toBe(6000);
  });

  it('stays silent for a patient with no approved limit', async () => {
    await db.exec(`update profiles set approved_credit_limit = null where id = '${PATIENT}';`);
    await db.exec(`insert into plans (id, patient_id, practice_id, total_amount, financed_amount,
                                      status, full_value_exposure)
                   values ('${PLAN_1}', '${PATIENT}', '${PRACTICE}', 99000, 99000, 'active', true);`);
    await db.exec(`
      begin;
      insert into payments (id, plan_id, patient_id, instalment_number, amount, due_date, status, kind)
      values (gen_random_uuid(), '${PLAN_1}', '${PATIENT}', 1, 99000, '2026-11-01', 'scheduled', 'instalment');
      commit;
    `);
    expect(await exposure()).toBe(99000);
  });
});

// ═══ The log is append-only ════════════════════════════════════════════

describe('credit_assessments is append-only', () => {
  async function insertAssessment(outcome = 'approved'): Promise<string> {
    const r = await db.query<{ id: string }>(
      `insert into credit_assessments (patient_id, trigger, outcome, coefficient_version, final_limit)
       values ('${PATIENT}', 'signup', '${outcome}', '2026.27-r1', 10000) returning id`);
    return r.rows[0].id;
  }

  it('accepts inserts', async () => {
    await expect(insertAssessment()).resolves.toBeTruthy();
  });

  it('refuses UPDATE — a re-assessment writes a new row', async () => {
    const id = await insertAssessment();
    await expect(
      db.exec(`update credit_assessments set final_limit = 99999 where id = '${id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('refuses DELETE — declines are half the calibration sample', async () => {
    const id = await insertAssessment('declined');
    await expect(
      db.exec(`delete from credit_assessments where id = '${id}'`),
    ).rejects.toThrow(/append-only/);
  });

  it('records a decline with its reason and no limit', async () => {
    await db.exec(`
      insert into credit_assessments
        (patient_id, trigger, outcome, failed_gate, decline_reason, coefficient_version)
      values ('${PATIENT}', 'signup', 'declined', 'score', 'band', '2026.27-r1');
    `);
    const r = await db.query<{ outcome: string; decline_reason: string }>(
      `select outcome, decline_reason from credit_assessments`);
    expect(r.rows[0]).toMatchObject({ outcome: 'declined', decline_reason: 'band' });
  });

  it('accepts pending as a first-class outcome, distinct from declined', async () => {
    await db.exec(`
      insert into credit_assessments (patient_id, trigger, outcome, pending_reason, coefficient_version)
      values ('${PATIENT}', 'signup', 'pending', '-106: server failure', '2026.27-r1');
    `);
    const r = await db.query<{ outcome: string }>(`select outcome from credit_assessments`);
    expect(r.rows[0].outcome).toBe('pending');
  });

  it('rejects an outcome outside the three', async () => {
    await expect(db.exec(`
      insert into credit_assessments (patient_id, trigger, outcome, coefficient_version)
      values ('${PATIENT}', 'signup', 'maybe', '2026.27-r1');
    `)).rejects.toThrow();
  });
});
