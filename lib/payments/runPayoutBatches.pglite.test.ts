// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { runPayoutBatches } from './runPayoutBatches';
import { SAST_OFFSET, sastMidnight } from './payoutWindow';

// ─── Weekly payout batching, against REAL Postgres ──────────────────────
//
// The guarantees this feature rests on are DATABASE guarantees, so they are
// tested against a real Postgres rather than a mocked client:
//
//   • UNIQUE (practice_id, window_start)  → one batch per practice per week
//   • payouts.batch_id single column      → a payout is in at most one batch
//   • `batch_id IS NULL` in the claim     → concurrent claims can't overlap
//
// 0087 exists because an app-level check-then-insert guard lost a race. A
// mocked client would happily confirm whatever the app code believes; only
// the engine can confirm what it actually enforces. Several tests below
// therefore BYPASS the runner entirely and hit the constraints with raw SQL.
//
// Migration 0090 is executed VERBATIM (not a hand-copied DDL block), so this
// also proves the migration applies cleanly.

const MIG_0090 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0090_payout_batches.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

// Minimal stand-ins for the tables 0090 references, with the columns the
// runner touches. payouts mirrors 0001 + 0021 + 0087 — including the UNIQUE
// on plan_id, because "one payout row per plan" is a premise of batching.
const STUB_SCHEMA = `
  create table practices (
    id          uuid primary key default gen_random_uuid(),
    name        text,
    fee_percent numeric(5,2) default 6
  );
  create table plans (
    id           uuid primary key default gen_random_uuid(),
    practice_id  uuid references practices(id),
    status       text,
    total_amount numeric(10,2)
  );
  create table payouts (
    id                  uuid primary key default gen_random_uuid(),
    practice_id         uuid references practices(id),
    plan_id             uuid references plans(id) unique,
    provider_id         uuid,
    gross_amount        numeric(10,2) not null,
    fee_amount          numeric(10,2) not null,
    net_amount          numeric(10,2) not null,
    status              text default 'pending',
    payout_destination  text default 'practice',
    paid_at             timestamptz,
    created_at          timestamptz default now()
  );
  -- Referenced by 0090's CREATE POLICY statements. Every query here runs as
  -- the pglite superuser, which bypasses RLS unconditionally, so these only
  -- need to exist for the policies to parse.
  create or replace function is_platform_admin() returns boolean
    language sql stable as $$ select true $$;
  create or replace function is_practice_member(p uuid) returns boolean
    language sql stable as $$ select true $$;
  create or replace function is_brand_admin_of_practice(p uuid) returns boolean
    language sql stable as $$ select true $$;
`;

let db: PGlite;

function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  return db.query<T>(sql, params);
}

// ─── A PostgREST-shaped client backed by real SQL ────────────────────────
//
// Covers exactly the surface runPayoutBatches uses — select/is/eq/gte/lt/in,
// maybeSingle, upsert with onConflict+ignoreDuplicates, update…returning, and
// head+count. Thenable, because the runner awaits builders directly.

type Filter = { col: string; op: 'eq' | 'gte' | 'lt' | 'is' | 'in'; val: unknown };

function makeSqlClient() {
  return {
    from(table: string) {
      const filters: Filter[] = [];
      let mode: 'select' | 'update' | 'upsert' = 'select';
      let patch: Record<string, unknown> = {};
      let upsertRow: Record<string, unknown> = {};
      let conflictCols = '';
      let returning = '*';
      let wantCount = false;
      let headOnly = false;

      function where(startIndex: number): { sql: string; params: unknown[] } {
        const params: unknown[] = [];
        const parts: string[] = [];
        for (const f of filters) {
          if (f.op === 'is') { parts.push(`${f.col} is null`); continue; }
          if (f.op === 'in') {
            const list = f.val as unknown[];
            if (list.length === 0) { parts.push('false'); continue; }
            const ph = list.map((v) => { params.push(v); return `$${startIndex + params.length - 1}`; });
            parts.push(`${f.col} in (${ph.join(', ')})`);
            continue;
          }
          params.push(f.val);
          const op = f.op === 'eq' ? '=' : f.op === 'gte' ? '>=' : '<';
          parts.push(`${f.col} ${op} $${startIndex + params.length - 1}`);
        }
        return { sql: parts.length ? parts.join(' and ') : 'true', params };
      }

      async function run() {
        if (mode === 'upsert') {
          const cols = Object.keys(upsertRow);
          const ph   = cols.map((_, i) => `$${i + 1}`);
          const { rows } = await q(
            `insert into ${table} (${cols.join(', ')}) values (${ph.join(', ')})
             on conflict (${conflictCols}) do nothing
             returning ${returning}`,
            cols.map((c) => upsertRow[c]),
          );
          return { data: rows, error: null, count: rows.length };
        }
        if (mode === 'update') {
          const cols = Object.keys(patch);
          const setClause = cols.map((c, i) => `${c} = $${i + 1}`).join(', ');
          const w = where(cols.length + 1);
          const { rows } = await q(
            `update ${table} set ${setClause} where ${w.sql} returning ${returning}`,
            [...cols.map((c) => patch[c]), ...w.params],
          );
          return { data: rows, error: null, count: rows.length };
        }
        const w = where(1);
        if (headOnly) {
          const { rows } = await q<{ n: string }>(
            `select count(*)::int as n from ${table} where ${w.sql}`, w.params,
          );
          return { data: null, error: null, count: Number(rows[0]?.n ?? 0) };
        }
        const { rows } = await q(`select ${returning} from ${table} where ${w.sql}`, w.params);
        return { data: rows, error: null, count: wantCount ? rows.length : null };
      }

      const b: Record<string, unknown> = {};
      b.select = (cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (cols && mode === 'select') returning = cols;
        if (cols && mode !== 'select') returning = cols;
        if (opts?.count) wantCount = true;
        if (opts?.head)  headOnly  = true;
        return b;
      };
      b.eq    = (col: string, val: unknown) => { filters.push({ col, op: 'eq',  val }); return b; };
      b.gte   = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return b; };
      b.lt    = (col: string, val: unknown) => { filters.push({ col, op: 'lt',  val }); return b; };
      b.is    = (col: string) => { filters.push({ col, op: 'is', val: null }); return b; };
      b.in    = (col: string, val: unknown[]) => { filters.push({ col, op: 'in', val }); return b; };
      b.update = (p: Record<string, unknown>) => { mode = 'update'; patch = p; returning = '*'; return b; };
      b.upsert = (row: Record<string, unknown>, opts: { onConflict: string }) => {
        mode = 'upsert'; upsertRow = row; conflictCols = opts.onConflict; returning = '*'; return b;
      };
      b.maybeSingle = async () => {
        const r = await run();
        const rows = (r.data ?? []) as unknown[];
        return { data: rows[0] ?? null, error: null };
      };
      b.then = (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        run().then(onFulfilled, onRejected);
      return b;
    },
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────
//
// Real 2026 calendar: Thursdays 6/13/20 Aug, Fridays 7/14/21 Aug.
const THU_06 = '2026-08-06';
const THU_13 = '2026-08-13';
const FRI_14 = '2026-08-14';

const sast = (dt: string) => new Date(`${dt}${SAST_OFFSET}`);
const RUN_FRIDAY = sast(`${FRI_14}T06:00:00`);
/** The actual scheduled instant: Thursday 00:00 UTC = 02:00 SAST (vercel.json). */
const RUN_THURSDAY = sast(`${THU_13}T02:00:00`);

let practiceA: string;
let practiceB: string;

async function seedPractices() {
  const a = await q<{ id: string }>(
    `insert into practices (name, fee_percent) values ('Practice A', 10) returning id`);
  const b = await q<{ id: string }>(
    `insert into practices (name, fee_percent) values ('Practice B', 6) returning id`);
  practiceA = a.rows[0].id;
  practiceB = b.rows[0].id;
}

/**
 * A plan that activated at `activatedAt`, with its payout row — the shape
 * activateFirstInstalment produces. created_at is set EXPLICITLY here because
 * it is the activation timestamp the runner batches on.
 */
async function seedActivatedPlan(opts: {
  practiceId: string;
  activatedAt: Date;
  net: number;
  status?: string;
  destination?: string;
}): Promise<{ planId: string; payoutId: string }> {
  const gross = opts.net * 2;
  const plan = await q<{ id: string }>(
    `insert into plans (practice_id, status, total_amount) values ($1, 'active', $2) returning id`,
    [opts.practiceId, gross],
  );
  const payout = await q<{ id: string }>(
    `insert into payouts
       (practice_id, plan_id, gross_amount, fee_amount, net_amount, status, payout_destination, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [
      opts.practiceId, plan.rows[0].id, gross, gross - opts.net, opts.net,
      opts.status ?? 'pending', opts.destination ?? 'practice',
      opts.activatedAt.toISOString(),
    ],
  );
  return { planId: plan.rows[0].id, payoutId: payout.rows[0].id };
}

const run = () => runPayoutBatches(makeSqlClient(), { now: RUN_FRIDAY });

// ONE Postgres for the file, truncated between tests, rather than a fresh
// PGlite per test: a boot costs ~3s and ~200MB, and 20 boots is two minutes
// of suite time plus a lot of leaked memory for no extra isolation. Truncate
// gives each test an empty schema anyway, and executing the migration once
// still proves it applies cleanly. db.close() in afterAll releases the
// instance instead of leaving it to the process teardown.
beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(MIG_0090);
});

beforeEach(async () => {
  await db.exec('truncate payout_batches, payouts, plans, practices cascade');
  await seedPractices();
});

afterAll(async () => {
  await db?.close();
});

// ─── The window, end to end through the runner ───────────────────────────

describe('window membership', () => {
  it('a Thursday activation and the following Wednesday land in the SAME batch', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T00:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-12T23:00:00'), net: 250 });

    const summary = await run();

    expect(summary.batches_created).toBe(1);
    expect(summary.payouts_claimed).toBe(2);

    const { rows } = await q<{ plan_count: number; total_net: string }>(
      `select plan_count, total_net from payout_batches where practice_id = $1`, [practiceA]);
    expect(rows).toHaveLength(1);
    expect(rows[0].plan_count).toBe(2);
    expect(Number(rows[0].total_net)).toBe(350);
  });

  it('BOUNDARY: Wednesday 23:59:59 SAST is IN; Thursday 00:00:01 is in the NEXT batch', async () => {
    const lastIn  = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast('2026-08-12T23:59:59'), net: 111 });
    const firstOut = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast(`${THU_13}T00:00:01`), net: 222 });

    await run();

    const { rows } = await q<{ id: string; batch_id: string | null }>(
      `select id, batch_id from payouts order by created_at`);
    const byId = new Map(rows.map((r) => [r.id, r.batch_id]));
    expect(byId.get(lastIn.payoutId)).not.toBeNull();
    expect(byId.get(firstOut.payoutId)).toBeNull();

    // And the one left out is picked up by the FOLLOWING week's run — not
    // stranded forever.
    const next = await runPayoutBatches(makeSqlClient(), { now: sast('2026-08-21T06:00:00') });
    expect(next.payouts_claimed).toBe(1);
    const after = await q<{ batch_id: string | null }>(
      `select batch_id from payouts where id = $1`, [firstOut.payoutId]);
    expect(after.rows[0].batch_id).not.toBeNull();
  });

  it('the batch records the exact window it covers', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T09:00:00`), net: 50 });
    await run();
    const { rows } = await q<{ window_start: string; window_end: string }>(
      `select window_start, window_end from payout_batches`);
    expect(new Date(rows[0].window_start).toISOString()).toBe(sastMidnight(THU_06).toISOString());
    expect(new Date(rows[0].window_end).toISOString()).toBe(sastMidnight(THU_13).toISOString());
  });

  it('an activation from a PREVIOUS week is not swept in — it is reported as stranded', async () => {
    // A missed Friday must not silently inflate this week's batch: a batch
    // labelled "Thu 6 – Wed 12" has to contain exactly that.
    const old = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast('2026-07-20T10:00:00'), net: 900 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });

    const summary = await run();

    expect(summary.payouts_claimed).toBe(1);
    expect(summary.stranded_payouts).toBe(1);
    const { rows } = await q<{ batch_id: string | null }>(
      `select batch_id from payouts where id = $1`, [old.payoutId]);
    expect(rows[0].batch_id).toBeNull();
  });

  it('a backfill run settles the stranded week without touching the current one', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-07-30T10:00:00'), net: 900 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });

    await run();
    const backfill = await runPayoutBatches(makeSqlClient(), {
      now: RUN_FRIDAY, weekEnding: '2026-08-06',
    });

    expect(backfill.payouts_claimed).toBe(1);
    const { rows } = await q<{ n: string }>(`select count(*)::int as n from payout_batches`);
    expect(Number(rows[0].n)).toBe(2);
  });
});

// ─── The batch closes Thursday morning, and closing needs nobody ─────────
//
// The schedule moved from Friday 06:00 SAST to Thursday 02:00 SAST. Practices
// are still PAID on Friday; what moved is when the figure is FINAL. These
// tests pin the three things that decision rests on: the scheduled instant
// settles the intended week, a closed batch is immediately actionable, and
// closing is independent of anyone having settled the previous batch.

describe('closing on Thursday morning', () => {
  it('the scheduled Thursday 02:00 SAST run settles the SAME week the Friday run did', async () => {
    // Regression in the strongest available form: identical window and
    // identical membership at the new instant. If the boundary arithmetic had
    // any Friday assumption in it, this is where it would show.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T00:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-12T23:59:59'), net: 250 });

    const summary = await runPayoutBatches(makeSqlClient(), { now: RUN_THURSDAY });

    expect(summary.window_start).toBe(sastMidnight(THU_06).toISOString());
    expect(summary.window_end).toBe(sastMidnight(THU_13).toISOString());
    expect(summary.window_label).toBe(`${THU_06} to 2026-08-12`);
    expect(summary.batches_created).toBe(1);
    expect(summary.payouts_claimed).toBe(2);
    expect(summary.total_net).toBe(350);
    expect(summary.stranded_payouts).toBe(0);
  });

  it('two hours after the boundary is on the RIGHT side of it — 23:58 the night before is not', async () => {
    // Why the schedule is 02:00 and not 00:00 SAST. A cron that fires early
    // resolves to the PREVIOUS week's window: it claims nothing, creates no
    // batch, and — the part that makes it dangerous — does not even register
    // the just-closed week as stranded, because those rows are AFTER that
    // window's start. The miss would be silent for seven days.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });

    const early = await runPayoutBatches(makeSqlClient(), { now: sast('2026-08-12T23:58:00') });
    expect(early.window_end).toBe(sastMidnight(THU_06).toISOString());   // a week too early
    expect(early.payouts_claimed).toBe(0);
    expect(early.batches_created).toBe(0);
    expect(early.stranded_payouts).toBe(0);                             // invisible, hence the buffer

    // The scheduled time gets it right.
    const onTime = await runPayoutBatches(makeSqlClient(), { now: RUN_THURSDAY });
    expect(onTime.window_end).toBe(sastMidnight(THU_13).toISOString());
    expect(onTime.payouts_claimed).toBe(1);
  });

  it('a batch closed Thursday is IMMEDIATELY settleable — nothing gates it on a date', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-11T10:00:00'), net: 200 });

    await runPayoutBatches(makeSqlClient(), { now: RUN_THURSDAY });

    // What /admin/payouts lists in "awaiting transfer": pending, unpaid, with
    // its total already final. An operator sees this on the Thursday.
    const { rows: batch } = await q<{ id: string; status: string; paid_at: string | null; total_net: string }>(
      `select id, status, paid_at, total_net from payout_batches`);
    expect(batch).toHaveLength(1);
    expect(batch[0].status).toBe('pending');
    expect(batch[0].paid_at).toBeNull();
    expect(Number(batch[0].total_net)).toBe(300);

    // markBatchPaid's exact SQL, in its exact order — members first, then the
    // batch — run the same day the batch closed. No clause anywhere waits for
    // Friday, and this is the assertion that would fail if one were added.
    const paidAt = sast(`${THU_13}T09:00:00`).toISOString();
    const flipped = await q(
      `update payouts set status = 'paid', paid_at = $1
        where batch_id = $2 and status = 'pending' returning id`,
      [paidAt, batch[0].id],
    );
    expect(flipped.rows).toHaveLength(2);
    const flippedBatch = await q(
      `update payout_batches set status = 'paid', paid_at = $1
        where id = $2 and status = 'pending' returning id`,
      [paidAt, batch[0].id],
    );
    expect(flippedBatch.rows).toHaveLength(1);
  });

  it('next week CLOSES even if last week was never marked paid', async () => {
    // The two steps are uncoupled on purpose. An admin who forgets to settle
    // delays money; they must never be able to stop the batching that tells a
    // practice what they are owed. Candidates come from payouts on
    // `batch_id IS NULL`, and last week's rows already carry a batch_id —
    // settled or not — so the previous batch is never even read.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    const week1 = await runPayoutBatches(makeSqlClient(), { now: RUN_THURSDAY });
    expect(week1.batches_created).toBe(1);

    // Deliberately NOT marked paid.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_13}T10:00:00`), net: 400 });
    const week2 = await runPayoutBatches(makeSqlClient(), { now: sast('2026-08-20T02:00:00') });

    expect(week2.batches_created).toBe(1);
    expect(week2.payouts_claimed).toBe(1);
    expect(week2.total_net).toBe(400);

    const { rows } = await q<{ window_start: string; status: string; total_net: string }>(
      `select window_start, status, total_net from payout_batches order by window_start`);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(['pending', 'pending']);
    expect(Number(rows[0].total_net)).toBe(100);   // last week's figure untouched
    expect(Number(rows[1].total_net)).toBe(400);
  });
});

// ─── Idempotency, proven at the DB level ─────────────────────────────────

describe('idempotency', () => {
  it('re-running the same Friday claims nothing new and creates no duplicate batch', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-11T10:00:00'), net: 200 });

    const first  = await run();
    const second = await run();
    const third  = await run();

    expect(first.payouts_claimed).toBe(2);
    expect(second.payouts_claimed).toBe(0);
    expect(third.payouts_claimed).toBe(0);
    expect(second.batches_created).toBe(0);
    // batches_reused is 0 here, not 1: with every row already claimed the
    // candidate query returns nothing, so the second run never even looks at
    // the batch. Reuse is exercised by the next test, which gives it a
    // genuine candidate.
    expect(second.batches_reused).toBe(0);

    const { rows } = await q<{ n: string }>(`select count(*)::int as n from payout_batches`);
    expect(Number(rows[0].n)).toBe(1);

    // Totals stayed correct rather than doubling.
    const b = await q<{ plan_count: number; total_net: string }>(
      `select plan_count, total_net from payout_batches`);
    expect(b.rows[0].plan_count).toBe(2);
    expect(Number(b.rows[0].total_net)).toBe(300);
  });

  it('a late arrival inside an open window joins the EXISTING batch, not a second one', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    const first = await run();
    expect(first.batches_created).toBe(1);

    // e.g. a webhook that landed after the Friday run, back-dated into the
    // window it belongs to.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-11T10:00:00'), net: 200 });
    const second = await run();

    expect(second.batches_created).toBe(0);
    expect(second.batches_reused).toBe(1);
    expect(second.payouts_claimed).toBe(1);

    const { rows } = await q<{ n: string }>(`select count(*)::int as n from payout_batches`);
    expect(Number(rows[0].n)).toBe(1);

    // The total picked up BOTH rows — recomputed from the batch's members,
    // not incremented by what this invocation happened to claim.
    const b = await q<{ plan_count: number; total_net: string }>(
      `select plan_count, total_net from payout_batches`);
    expect(b.rows[0].plan_count).toBe(2);
    expect(Number(b.rows[0].total_net)).toBe(300);
  });

  it('DB-LEVEL, app guard bypassed: a second batch row for the same practice+window is REJECTED', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await run();

    // Raw INSERT — no upsert, no ON CONFLICT, nothing the runner does.
    let failed = false;
    let message = '';
    try {
      await q(
        `insert into payout_batches (practice_id, window_start, window_end)
         values ($1, $2, $3)`,
        [practiceA, sastMidnight(THU_06).toISOString(), sastMidnight(THU_13).toISOString()],
      );
    } catch (e) {
      failed = true;
      message = e instanceof Error ? e.message : String(e);
    }
    expect(failed).toBe(true);
    expect(message.toLowerCase()).toMatch(/unique|duplicate/);
  });

  it('DB-LEVEL, app guard bypassed: an already-claimed payout cannot be claimed again', async () => {
    const { payoutId } = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await run();

    // A second, competing batch for a DIFFERENT window — a legal row.
    const other = await q<{ id: string }>(
      `insert into payout_batches (practice_id, window_start, window_end)
       values ($1, $2, $3) returning id`,
      [practiceA, sastMidnight(THU_13).toISOString(), sastMidnight('2026-08-20').toISOString()],
    );

    // The claim predicate is the whole guarantee. Raw SQL, same predicate.
    const stolen = await q(
      `update payouts set batch_id = $1 where id = $2 and batch_id is null returning id`,
      [other.rows[0].id, payoutId],
    );
    expect(stolen.rows).toHaveLength(0);

    // And the column being single-valued means it still points at exactly one.
    const { rows } = await q<{ batch_id: string }>(
      `select batch_id from payouts where id = $1`, [payoutId]);
    expect(rows[0].batch_id).not.toBe(other.rows[0].id);
  });

  it('a payout can never appear in two batches — one column, one value', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await run();
    await runPayoutBatches(makeSqlClient(), { now: sast('2026-08-21T06:00:00') });

    // Every payout has at most one batch by construction; assert the
    // aggregate anyway so a future join-table refactor has to face this.
    const { rows } = await q<{ n: string }>(
      `select count(*)::int as n from payouts where batch_id is not null`);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('ADVERSARIAL: two concurrent invocations produce exactly ONE batch per practice', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast('2026-08-10T10:00:00'), net: 200 });
    await seedActivatedPlan({ practiceId: practiceB, activatedAt: sast('2026-08-11T10:00:00'), net: 300 });

    // Started together. NOTE: pglite is a single connection, so these
    // interleave at await points rather than executing in true parallel —
    // the DB-level tests above are what cover a genuine race. What this
    // proves is that two overlapping invocations converge: no duplicate
    // batches, no double-claim, and correct totals whichever finishes last.
    const [a, b, c] = await Promise.all([run(), run(), run()]);

    const { rows: counts } = await q<{ practice_id: string; n: string }>(
      `select practice_id, count(*)::int as n from payout_batches group by practice_id`);
    for (const r of counts) expect(Number(r.n)).toBe(1);
    expect(counts).toHaveLength(2);

    // Each payout claimed exactly once across all three invocations.
    expect(a.payouts_claimed + b.payouts_claimed + c.payouts_claimed).toBe(3);

    const { rows: totals } = await q<{ practice_id: string; total_net: string; plan_count: number }>(
      `select practice_id, total_net, plan_count from payout_batches`);
    const byPractice = new Map(totals.map((t) => [t.practice_id, t]));
    expect(Number(byPractice.get(practiceA)!.total_net)).toBe(300);
    expect(byPractice.get(practiceA)!.plan_count).toBe(2);
    expect(Number(byPractice.get(practiceB)!.total_net)).toBe(300);
    expect(byPractice.get(practiceB)!.plan_count).toBe(1);
  });
});

// ─── Per-practice separation ─────────────────────────────────────────────

describe('one batch per practice — one practice, one bank account, one deposit', () => {
  it('two practices activating in the same window produce TWO separate batches', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await seedActivatedPlan({ practiceId: practiceB, activatedAt: sast(`${THU_06}T11:00:00`), net: 400 });

    const summary = await run();

    expect(summary.batches_created).toBe(2);
    expect(summary.practices).toHaveLength(2);

    const { rows } = await q<{ practice_id: string; total_net: string }>(
      `select practice_id, total_net from payout_batches order by total_net`);
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].total_net)).toBe(100);
    expect(Number(rows[1].total_net)).toBe(400);
  });

  it('a practice with nothing activated gets NO batch — an empty deposit never happens', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await run();
    const { rows } = await q<{ practice_id: string }>(`select practice_id from payout_batches`);
    expect(rows.map((r) => r.practice_id)).toEqual([practiceA]);
  });
});

// ─── What must NOT be swept in ───────────────────────────────────────────

describe('exclusions', () => {
  it('an ALREADY PAID payout is not batched — that would invite paying twice', async () => {
    const paid = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 500, status: 'paid' });
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T11:00:00`), net: 100 });

    const summary = await run();

    expect(summary.payouts_claimed).toBe(1);
    const { rows } = await q<{ batch_id: string | null }>(
      `select batch_id from payouts where id = $1`, [paid.payoutId]);
    expect(rows[0].batch_id).toBeNull();
    const b = await q<{ total_net: string }>(`select total_net from payout_batches`);
    expect(Number(b.rows[0].total_net)).toBe(100);
  });

  it('the total is the SUM of stored net_amount — never recomputed from fee_percent', async () => {
    // Practice A's fee_percent is 10, but these payouts were written with a
    // deliberately inconsistent fee. The batch must reflect what was
    // captured at activation, so a later commission change cannot move it.
    await q(
      `insert into payouts (practice_id, plan_id, gross_amount, fee_amount, net_amount, created_at)
       values ($1, $2, 1000, 400, 600, $3)`,
      [
        practiceA,
        (await q<{ id: string }>(
          `insert into plans (practice_id, status, total_amount) values ($1,'active',1000) returning id`,
          [practiceA])).rows[0].id,
        sast(`${THU_06}T10:00:00`).toISOString(),
      ],
    );

    await run();

    const { rows } = await q<{ total_net: string }>(`select total_net from payout_batches`);
    expect(Number(rows[0].total_net)).toBe(600);   // not 900 (= 1000 less 10%)
  });

  it('settled batch totals are never rewritten by a later run', async () => {
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await run();
    await q(`update payout_batches set status = 'paid', paid_at = now()`);

    // A stray payout back-dated into the settled window, then a re-run.
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T12:00:00`), net: 999 });
    await run();

    const { rows } = await q<{ total_net: string; plan_count: number; status: string }>(
      `select total_net, plan_count, status from payout_batches`);
    // The figure the admin paid against is preserved.
    expect(Number(rows[0].total_net)).toBe(100);
    expect(rows[0].plan_count).toBe(1);
    expect(rows[0].status).toBe('paid');
  });
});

// ─── Orphans: a plan with no payouts row ─────────────────────────────────

describe('a plan with no payouts row', () => {
  it('is not batched, does not crash, and is COUNTED so it is visible', async () => {
    // Should be impossible — activateFirstInstalment always inserts a payout.
    // Chosen behaviour: report it, do NOT create the missing payout, because
    // that would make the runner a second creator and break the single-writer
    // invariant payouts.plan_id UNIQUE (0087) protects.
    await q(`insert into plans (practice_id, status, total_amount) values ($1, 'active', 800)`,
      [practiceA]);
    await seedActivatedPlan({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });

    const summary = await run();

    expect(summary.errors).toEqual([]);
    expect(summary.orphan_active_plans).toBe(1);
    expect(summary.payouts_claimed).toBe(1);

    // No payout was invented for it.
    const { rows } = await q<{ n: string }>(`select count(*)::int as n from payouts`);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('a run with nothing to do at all succeeds and reports zeroes', async () => {
    const summary = await run();
    expect(summary.errors).toEqual([]);
    expect(summary.batches_created).toBe(0);
    expect(summary.payouts_claimed).toBe(0);
    expect(summary.total_net).toBe(0);
    const { rows } = await q<{ n: string }>(`select count(*)::int as n from payout_batches`);
    expect(Number(rows[0].n)).toBe(0);
  });
});

// ─── Schema-level invariants the migration must enforce ──────────────────

describe('migration 0090 constraints', () => {
  it('a paid batch must carry paid_at, and a pending one must not', async () => {
    const insert = (status: string, paidAt: string | null) => q(
      `insert into payout_batches (practice_id, window_start, window_end, status, paid_at)
       values ($1, $2, $3, $4, $5)`,
      [practiceA, sastMidnight(THU_06).toISOString(), sastMidnight(THU_13).toISOString(), status, paidAt],
    );
    await expect(insert('paid', null)).rejects.toThrow();
    await expect(insert('pending', new Date().toISOString())).rejects.toThrow();
  });

  it('rejects a window whose end is not after its start', async () => {
    await expect(q(
      `insert into payout_batches (practice_id, window_start, window_end)
       values ($1, $2, $3)`,
      [practiceA, sastMidnight(THU_13).toISOString(), sastMidnight(THU_06).toISOString()],
    )).rejects.toThrow();
  });

  it('rejects a status outside pending/paid', async () => {
    await expect(q(
      `insert into payout_batches (practice_id, window_start, window_end, status)
       values ($1, $2, $3, 'processing')`,
      [practiceA, sastMidnight(THU_06).toISOString(), sastMidnight(THU_13).toISOString()],
    )).rejects.toThrow();
  });

  it('payouts.plan_id is still UNIQUE — 0087 is not reversed', async () => {
    const { planId } = await seedActivatedPlan({
      practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 100 });
    await expect(q(
      `insert into payouts (practice_id, plan_id, gross_amount, fee_amount, net_amount)
       values ($1, $2, 10, 1, 9)`,
      [practiceA, planId],
    )).rejects.toThrow();
  });
});
