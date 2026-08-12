// @vitest-environment node
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { resolveNextPayout } from './nextPayout';
import { SAST_OFFSET, sastMidnight } from '@/lib/payments/payoutWindow';
import { openPayoutWindow, payoutDateFor, windowDates } from '@/lib/payments/payoutSchedule';

// ─── "Next payout" against REAL Postgres ────────────────────────────────
//
// What is being proven here is SQL, not application branching: that the
// practice scope is actually in every WHERE clause, that the 30-day paid
// range is a real timestamp comparison, that batch membership is a join and
// not an assumption, and that the open-window filter uses the same instants
// the runner does. A mocked client would confirm whatever the code believes
// about its own queries — which is exactly the thing in doubt.
//
// Migration 0090 is executed VERBATIM, so the columns queried here are the
// ones that actually exist in production.
//
// THE CLIENT SHIM
// ───────────────
// resolveNextPayout talks PostgREST, so the shim below translates the exact
// query shapes it issues into SQL — including the embedded
// payouts→plans→profiles select, which becomes a LEFT JOIN returning the same
// nested object PostgREST would. It is deliberately NARROW: an unmodelled
// table or an unmodelled embed THROWS rather than returning empty, so a
// future query change cannot make these tests silently vacuous.

const MIG_0090 = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0090_payout_batches.sql'),
  'utf8',
).replace(/\r\n/g, '\n');

const STUB_SCHEMA = `
  create table practices (
    id uuid primary key default gen_random_uuid(),
    name text,
    fee_percent numeric(5,2) default 6
  );
  create table profiles (
    id uuid primary key default gen_random_uuid(),
    first_name text,
    last_name  text
  );
  create table plans (
    id             uuid primary key default gen_random_uuid(),
    practice_id    uuid references practices(id),
    patient_id     uuid references profiles(id),
    status         text,
    total_amount   numeric(10,2),
    invoice_number text
  );
  create table payouts (
    id           uuid primary key default gen_random_uuid(),
    practice_id  uuid references practices(id),
    plan_id      uuid references plans(id) unique,
    gross_amount numeric(10,2) not null,
    fee_amount   numeric(10,2) not null,
    net_amount   numeric(10,2) not null,
    status       text default 'pending',
    paid_at      timestamptz,
    created_at   timestamptz default now()
  );
  create or replace function is_platform_admin() returns boolean
    language sql stable as $$ select true $$;
  create or replace function is_practice_member(p uuid) returns boolean
    language sql stable as $$ select true $$;
  create or replace function is_brand_admin_of_practice(p uuid) returns boolean
    language sql stable as $$ select true $$;
`;

let db: PGlite;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  db.query<T>(sql, params);

// ── The shim ────────────────────────────────────────────────────────────

type Filter = { col: string; op: 'eq' | 'gte' | 'lt' | 'is'; val: unknown };

/** The one embedded select this module issues, as a SQL projection. */
const PAYOUT_EMBED_SQL = `
  p.id, p.plan_id, p.net_amount, p.created_at,
  case when pl.id is null then null else json_build_object(
    'invoice_number', pl.invoice_number,
    'patient', case when pr.id is null then null else
      json_build_object('first_name', pr.first_name, 'last_name', pr.last_name) end
  ) end as plans`;

const PAYOUT_EMBED_FROM = `
  from payouts p
  left join plans    pl on pl.id = p.plan_id
  left join profiles pr on pr.id = pl.patient_id`;

function makeSqlClient() {
  return {
    from(table: string) {
      if (table !== 'payouts' && table !== 'payout_batches') {
        throw new Error(`shim: unmodelled table "${table}" — add it or the test is vacuous`);
      }
      const filters: Filter[] = [];
      let cols = '*';
      let orderBy = '';
      let headOnly = false;
      let embedded = false;

      function where(alias: string) {
        const params: unknown[] = [];
        const parts = filters.map((f) => {
          const col = `${alias}${f.col}`;
          if (f.op === 'is') return `${col} is null`;
          params.push(f.val);
          const op = f.op === 'eq' ? '=' : f.op === 'gte' ? '>=' : '<';
          return `${col} ${op} $${params.length}`;
        });
        return { sql: parts.length ? parts.join(' and ') : 'true', params };
      }

      async function run() {
        if (headOnly) {
          const w = where('');
          const { rows } = await q<{ n: number }>(
            `select count(*)::int as n from ${table} where ${w.sql}`, w.params);
          return { data: null, error: null, count: Number(rows[0]?.n ?? 0) };
        }
        if (embedded) {
          const w = where('p.');
          const { rows } = await q(
            `select ${PAYOUT_EMBED_SQL} ${PAYOUT_EMBED_FROM} where ${w.sql} ${orderBy}`,
            w.params);
          return { data: rows, error: null, count: null };
        }
        const w = where('');
        const { rows } = await q(
          `select ${cols} from ${table} where ${w.sql} ${orderBy}`, w.params);
        return { data: rows, error: null, count: null };
      }

      const b: Record<string, unknown> = {};
      b.select = (c?: string, opts?: { count?: string; head?: boolean }) => {
        if (c) {
          if (/\bplans\s*\(/.test(c)) {
            embedded = true;
            // Assert the embed is the shape the shim models, so a changed
            // select cannot quietly fall through to the wrong SQL.
            if (!/patient:profiles!plans_patient_id_fkey\(first_name, last_name\)/.test(c)) {
              throw new Error('shim: payouts embed changed — update PAYOUT_EMBED_SQL');
            }
          } else {
            cols = c.replace(/\s+/g, ' ').trim();
          }
        }
        if (opts?.head) headOnly = true;
        return b;
      };
      b.eq  = (col: string, val: unknown) => { filters.push({ col, op: 'eq',  val }); return b; };
      b.gte = (col: string, val: unknown) => { filters.push({ col, op: 'gte', val }); return b; };
      b.lt  = (col: string, val: unknown) => { filters.push({ col, op: 'lt',  val }); return b; };
      b.is  = (col: string) => { filters.push({ col, op: 'is', val: null }); return b; };
      b.order = (col: string, opts?: { ascending?: boolean }) => {
        const alias = embedded ? 'p.' : '';
        orderBy = `order by ${alias}${col} ${opts?.ascending === false ? 'desc' : 'asc'}`;
        return b;
      };
      b.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) =>
        run().then(ok, err);
      return b;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────────
//
// Real 2026 calendar: Thursdays 6/13/20 Aug. "Now" is Friday 14 Aug 09:00
// SAST, so the CLOSED window is Thu 6 – Wed 12 and the OPEN one is Thu 13 –
// Wed 19.
const THU_06 = '2026-08-06';
const THU_13 = '2026-08-13';
const THU_20 = '2026-08-20';
const sast = (dt: string) => new Date(`${dt}${SAST_OFFSET}`);
const NOW   = sast('2026-08-14T09:00:00');

let practiceA: string;
let practiceB: string;

async function seedPractices() {
  practiceA = (await q<{ id: string }>(
    `insert into practices (name) values ('Practice A') returning id`)).rows[0].id;
  practiceB = (await q<{ id: string }>(
    `insert into practices (name) values ('Practice B') returning id`)).rows[0].id;
}

async function seedPayout(opts: {
  practiceId: string;
  activatedAt: Date;
  net: number;
  status?: 'pending' | 'paid';
  batchId?: string | null;
  patient?: [string, string];
  invoice?: string;
}): Promise<string> {
  const [first, last] = opts.patient ?? ['Thabo', 'Mokoena'];
  const patientId = (await q<{ id: string }>(
    `insert into profiles (first_name, last_name) values ($1, $2) returning id`,
    [first, last])).rows[0].id;
  const planId = (await q<{ id: string }>(
    `insert into plans (practice_id, patient_id, status, total_amount, invoice_number)
     values ($1, $2, 'active', $3, $4) returning id`,
    [opts.practiceId, patientId, opts.net * 2, opts.invoice ?? 'INV-001'])).rows[0].id;
  const { rows } = await q<{ id: string }>(
    `insert into payouts
       (practice_id, plan_id, gross_amount, fee_amount, net_amount, status, batch_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
    [opts.practiceId, planId, opts.net * 2, opts.net, opts.net,
     opts.status ?? 'pending', opts.batchId ?? null, opts.activatedAt.toISOString()]);
  return rows[0].id;
}

async function seedBatch(opts: {
  practiceId: string;
  windowEndDate: string;
  totalNet: number;
  planCount: number;
  status?: 'pending' | 'paid';
  paidAt?: Date | null;
}): Promise<string> {
  const end   = sastMidnight(opts.windowEndDate);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const { rows } = await q<{ id: string }>(
    `insert into payout_batches
       (practice_id, window_start, window_end, total_net, plan_count, status, paid_at)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [opts.practiceId, start.toISOString(), end.toISOString(),
     opts.totalNet, opts.planCount, opts.status ?? 'pending',
     opts.paidAt ? opts.paidAt.toISOString() : null]);
  return rows[0].id;
}

const forA = () => resolveNextPayout(makeSqlClient(), practiceA, NOW);
const forB = () => resolveNextPayout(makeSqlClient(), practiceB, NOW);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(STUB_SCHEMA);
  await db.exec(MIG_0090);
});

beforeEach(async () => {
  await db.exec('truncate payout_batches, payouts, plans, profiles, practices cascade');
  await seedPractices();
});

afterAll(async () => { await db?.close(); });

// ─── State (a): a closed batch is a COMMITMENT ──────────────────────────

describe('committed — a closed batch exists', () => {
  it('reports the batch\'s own total_net, plan_count and window', async () => {
    const batchId = await seedBatch({
      practiceId: practiceA, windowEndDate: THU_13, totalNet: 15240.50, planCount: 3 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 5000, batchId });
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-08-10T10:00:00'), net: 5000, batchId });
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-08-12T10:00:00'), net: 5240.50, batchId });

    const r = await forA();

    expect(r.next.kind).toBe('committed');
    if (r.next.kind !== 'committed') return;
    expect(r.next.totalNet).toBe(15240.50);
    expect(r.next.planCount).toBe(3);
    expect(r.next.batchId).toBe(batchId);
    expect(r.next.plansHidden).toBe(false);

    // Cross-checked against the table directly, not against the sum of the
    // rows the resolver happened to load.
    const raw = await q<{ total_net: string; plan_count: number }>(
      `select total_net, plan_count from payout_batches where id = $1`, [batchId]);
    expect(Number(raw.rows[0].total_net)).toBe(r.next.totalNet);
    expect(raw.rows[0].plan_count).toBe(r.next.planCount);

    // And the window is the one the batch STORES, so the derived copy is right.
    expect(windowDates(r.next.window)).toEqual({
      firstDate: THU_06, lastDate: '2026-08-12' });
    expect(payoutDateFor(r.next.window)).toBe('2026-08-14');
  });

  it('the total is the BATCH\'s figure even if member rows disagree', async () => {
    // A settled figure must never be silently recomputed: the practice was
    // told a number and their statement will show that number.
    const batchId = await seedBatch({
      practiceId: practiceA, windowEndDate: THU_13, totalNet: 100, planCount: 1 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`), net: 999, batchId });

    const r = await forA();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.totalNet).toBe(100);
  });

  it('the plan list is exactly the batch\'s members, with patient label and net', async () => {
    const batchId = await seedBatch({
      practiceId: practiceA, windowEndDate: THU_13, totalNet: 300, planCount: 2 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_06}T10:00:00`),
      net: 100, batchId, patient: ['Thabo', 'Mokoena'], invoice: 'INV-A1' });
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-08-11T10:00:00'),
      net: 200, batchId, patient: ['Sarah', 'Naidoo'], invoice: 'INV-A2' });
    // Same practice, NOT in the batch — must not appear.
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T10:00:00`),
      net: 777, patient: ['Excluded', 'Person'] });

    const r = await forA();
    if (r.next.kind !== 'committed') throw new Error('expected committed');

    expect(r.next.plans.map((p) => [p.patientLabel, p.invoiceNumber, p.netAmount])).toEqual([
      ['Thabo M.',  'INV-A1', 100],
      ['Sarah N.',  'INV-A2', 200],
    ]);
    // Surname is an initial only — a money surface carries the minimum.
    expect(JSON.stringify(r.next.plans)).not.toMatch(/Mokoena|Naidoo/);
  });

  it('plansHidden is set when the batch has plans but the rows are unreadable', async () => {
    // The RLS asymmetry made visible: payout_batches is readable by any
    // active practice member (0090), payouts only by is_practice_manager —
    // can_manage_practice = true, per 0035 replacing 0002's role='admin'
    // check. A member without it gets the count from the batch and nothing
    // else, so the UI must be able to SAY so rather than render "3 plans"
    // above an empty list.
    const batchId = await seedBatch({
      practiceId: practiceA, windowEndDate: THU_13, totalNet: 900, planCount: 3 });
    void batchId;   // no payouts rows inserted — stands in for RLS filtering them out

    const r = await forA();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    expect(r.next.planCount).toBe(3);
    expect(r.next.plans).toEqual([]);
    expect(r.next.plansHidden).toBe(true);
  });

  it('an unsettled EARLIER batch is reported separately, not folded into the total', async () => {
    // Two pending batches = two deposits. Summing them would produce a figure
    // that matches neither bank line.
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_06, totalNet: 500, planCount: 1 });
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_13, totalNet: 800, planCount: 2 });

    const r = await forA();
    if (r.next.kind !== 'committed') throw new Error('expected committed');
    // Oldest first: the next transfer out is the one waiting longest.
    expect(r.next.totalNet).toBe(500);
    expect(r.otherPendingCount).toBe(1);
    expect(r.otherPendingNet).toBe(800);
  });

  it('a PAID batch is not treated as the next payout', async () => {
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_13, totalNet: 800,
      planCount: 2, status: 'paid', paidAt: NOW });
    const r = await forA();
    expect(r.next.kind).toBe('none');
  });
});

// ─── State (b): a PROJECTION, and it must not look committed ────────────

describe('projected — no closed batch, unbatched payouts in the open window', () => {
  it('sums the open window\'s rows and marks itself as a projection', async () => {
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`), net: 400 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-08-14T08:00:00'), net: 250 });

    const r = await forA();

    expect(r.next.kind).toBe('projected');
    if (r.next.kind !== 'projected') return;
    expect(r.next.totalNet).toBe(650);
    expect(r.next.planCount).toBe(2);
    expect(r.next.plansHidden).toBe(false);

    // The window is the OPEN one, computed by the shared function.
    const open = openPayoutWindow(NOW);
    expect(r.next.window.windowStart.toISOString()).toBe(open.windowStart.toISOString());
    expect(windowDates(r.next.window)).toEqual({ firstDate: THU_13, lastDate: '2026-08-19' });
    expect(payoutDateFor(r.next.window)).toBe('2026-08-21');
  });

  it('EXCLUDES rows from before the open window — they will not be in that payout', async () => {
    // The runner's window is strict, so a row activated in a previous week is
    // NOT swept into the next close. Counting it here would promise money on a
    // date it will not arrive.
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`), net: 400 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_06}T08:00:00`), net: 9999 });

    const r = await forA();
    if (r.next.kind !== 'projected') throw new Error('expected projected');
    expect(r.next.totalNet).toBe(400);
    expect(r.next.planCount).toBe(1);
    // Surfaced instead of hidden — with no date attached.
    expect(r.strandedCount).toBe(1);
  });

  it('EXCLUDES an already-PAID row in the open window', async () => {
    // A settled payout is money received, not money coming. Sweeping it into
    // the projection would show it to the practice twice.
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`), net: 400 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T09:00:00`),
      net: 5000, status: 'paid' });

    const r = await forA();
    if (r.next.kind !== 'projected') throw new Error('expected projected');
    expect(r.next.totalNet).toBe(400);
    expect(r.next.planCount).toBe(1);
  });

  it('BOUNDARY: Wed 19 23:59:59 is in the projection; Thu 20 00:00:00 is not', async () => {
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-08-19T23:59:59'), net: 111 });
    await seedPayout({ practiceId: practiceA, activatedAt: sastMidnight(THU_20), net: 222 });

    const r = await forA();
    if (r.next.kind !== 'projected') throw new Error('expected projected');
    expect(r.next.totalNet).toBe(111);
    expect(r.next.planCount).toBe(1);
  });

  it('a closed batch WINS over a projection — the commitment is what lands next', async () => {
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_13, totalNet: 800, planCount: 1 });
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`), net: 400 });

    const r = await forA();
    expect(r.next.kind).toBe('committed');
  });
});

// ─── State (c): nothing ─────────────────────────────────────────────────

describe('none — nothing owed', () => {
  it('a practice with no batches and no payouts returns none, not zero', async () => {
    const r = await forA();
    expect(r.next).toEqual({ kind: 'none' });
    // No amount field exists on this variant at all — the type makes
    // rendering "R0.00" as a figure impossible rather than merely discouraged.
    expect('totalNet' in r.next).toBe(false);
  });

  it('a practice whose only payouts are paid returns none', async () => {
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`),
      net: 400, status: 'paid' });
    const r = await forA();
    expect(r.next.kind).toBe('none');
  });

  it('stranded rows alone do not fabricate a next payout', async () => {
    await seedPayout({ practiceId: practiceA, activatedAt: sast('2026-07-20T08:00:00'), net: 400 });
    const r = await forA();
    expect(r.next.kind).toBe('none');
    expect(r.strandedCount).toBe(1);
  });
});

// ─── "Paid out" — last 30 days, paid batches only ───────────────────────

describe('paid out in the last 30 days', () => {
  it('sums only status=paid batches inside the window', async () => {
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_06, totalNet: 1000,
      planCount: 2, status: 'paid', paidAt: sast('2026-08-07T10:00:00') });
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_13, totalNet: 2000,
      planCount: 3, status: 'paid', paidAt: sast('2026-07-25T10:00:00') });

    const r = await forA();
    expect(r.paidRecentlyNet).toBe(3000);
    expect(r.paidRecentlyCount).toBe(2);
  });

  it('EXCLUDES a batch paid 31 days ago, includes one paid 29 days ago', async () => {
    const day = 24 * 60 * 60 * 1000;
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_06, totalNet: 111,
      planCount: 1, status: 'paid', paidAt: new Date(NOW.getTime() - 29 * day) });
    await seedBatch({ practiceId: practiceA, windowEndDate: '2026-07-30', totalNet: 999,
      planCount: 1, status: 'paid', paidAt: new Date(NOW.getTime() - 31 * day) });

    const r = await forA();
    expect(r.paidRecentlyNet).toBe(111);
    expect(r.paidRecentlyCount).toBe(1);
  });

  it('EXCLUDES pending batches — a closed batch is not money received', async () => {
    await seedBatch({ practiceId: practiceA, windowEndDate: THU_13, totalNet: 5000, planCount: 1 });
    const r = await forA();
    expect(r.paidRecentlyNet).toBe(0);
    expect(r.paidRecentlyCount).toBe(0);
  });

  it('is 0 with a clean empty state rather than absent', async () => {
    const r = await forA();
    expect(r.paidRecentlyNet).toBe(0);
    expect(r.next.kind).toBe('none');
  });
});

// ─── ADVERSARIAL: practice scoping ──────────────────────────────────────

describe('ADVERSARIAL — another practice\'s money never appears', () => {
  it('B\'s closed batch does not leak into A\'s hero', async () => {
    await seedBatch({ practiceId: practiceB, windowEndDate: THU_13, totalNet: 99999, planCount: 9 });
    const r = await forA();
    expect(r.next.kind).toBe('none');
    expect(JSON.stringify(r)).not.toMatch(/99999/);
  });

  it('B\'s unbatched payouts do not leak into A\'s projection', async () => {
    // The bug this catches is real and was in the first draft of this module:
    // the plan-list query applied the batch/window predicates but NOT
    // practice_id, so under the brand path's service-role client (which
    // bypasses RLS entirely) it would have read every practice's rows.
    await seedPayout({ practiceId: practiceB, activatedAt: sast(`${THU_13}T08:00:00`), net: 77777 });
    const r = await forA();
    expect(r.next.kind).toBe('none');
    expect(JSON.stringify(r)).not.toMatch(/77777/);
  });

  it('with BOTH practices active, each sees only its own figures', async () => {
    await seedPayout({ practiceId: practiceA, activatedAt: sast(`${THU_13}T08:00:00`), net: 100 });
    await seedPayout({ practiceId: practiceB, activatedAt: sast(`${THU_13}T08:00:00`), net: 200 });
    await seedBatch({ practiceId: practiceB, windowEndDate: THU_06, totalNet: 3000,
      planCount: 1, status: 'paid', paidAt: sast('2026-08-07T10:00:00') });

    const a = await forA();
    const b = await forB();

    if (a.next.kind !== 'projected') throw new Error('expected A projected');
    expect(a.next.totalNet).toBe(100);
    expect(a.paidRecentlyNet).toBe(0);

    if (b.next.kind !== 'projected') throw new Error('expected B projected');
    expect(b.next.totalNet).toBe(200);
    expect(b.paidRecentlyNet).toBe(3000);
  });

  it('B\'s batch id cannot be used to read A\'s plan list, or vice versa', async () => {
    const bBatch = await seedBatch({
      practiceId: practiceB, windowEndDate: THU_13, totalNet: 500, planCount: 1 });
    // A payout belonging to B, in B's batch.
    await seedPayout({ practiceId: practiceB, activatedAt: sast(`${THU_06}T10:00:00`),
      net: 500, batchId: bBatch, patient: ['Leak', 'Target'] });

    const a = await forA();
    expect(a.next.kind).toBe('none');

    const b = await forB();
    if (b.next.kind !== 'committed') throw new Error('expected B committed');
    expect(b.next.plans).toHaveLength(1);
    expect(b.next.plans[0].patientLabel).toBe('Leak T.');
  });

  it('stranded counts are per-practice too', async () => {
    await seedPayout({ practiceId: practiceB, activatedAt: sast('2026-07-20T08:00:00'), net: 400 });
    const a = await forA();
    const b = await forB();
    expect(a.strandedCount).toBe(0);
    expect(b.strandedCount).toBe(1);
  });
});
