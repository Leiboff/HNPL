import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  resolvePayoutHistory,
  PAYOUT_HISTORY_WEEKS,
} from './payoutHistory';
import { payoutWindowEndingOn } from '@/lib/payments/payoutWindow';
import { payoutDateFor, windowDates, openPayoutWindow } from '@/lib/payments/payoutSchedule';

// ─── The payouts tab's data ────────────────────────────────────────────────
//
// What matters here is not that the queries run — it is that the three
// certainties come out DISTINCT and correctly assigned, because the component
// renders completely different copy for each and the worst outcome of this
// whole feature is a closed-but-unpaid batch reported as paid.
//
// The fake client below HONOURS its filters rather than returning everything,
// which is what makes the cross-practice test mean something: if the module
// dropped .eq('practice_id', …) the other practice's rows would come back and
// the assertions would fail. It also throws on an unmodelled table, so a future
// query against something the fake does not know about cannot pass silently.

const NOW = new Date('2026-08-14T07:00:00.000Z');   // Fri 14 Aug 2026, 09:00 SAST

const W_AUG_13 = payoutWindowEndingOn('2026-08-13'); // Thu 6  – Wed 12, due Fri 14
const W_AUG_06 = payoutWindowEndingOn('2026-08-06'); // Thu 30 – Wed 5,  due Fri 7
const W_JUL_30 = payoutWindowEndingOn('2026-07-30'); // Thu 23 – Wed 29, due Fri 31
const OPEN     = openPayoutWindow(NOW);              // Thu 13 – Wed 19, due Fri 21

const PRACTICE = 'prac-1';
const OTHER    = 'prac-2';

type Row = Record<string, unknown>;

function batch(over: Row & { id: string }): Row {
  return {
    practice_id:  PRACTICE,
    window_start: W_AUG_13.windowStart.toISOString(),
    window_end:   W_AUG_13.windowEnd.toISOString(),
    total_net:    1000,
    plan_count:   1,
    status:       'pending',
    paid_at:      null,
    ...over,
  };
}

function payout(over: Row & { id: string }): Row {
  return {
    practice_id:  PRACTICE,
    plan_id:      `pl-${over.id}`,
    batch_id:     null,
    gross_amount: 1000,
    fee_amount:   60,
    net_amount:   940,
    status:       'pending',
    created_at:   '2026-08-10T08:00:00.000Z',
    plans: {
      invoice_number:     `INV-${over.id}`,
      practice_reference: `REF-${over.id}`,
      patient: { first_name: 'Thabo', last_name: 'Mokoena' },
    },
    ...over,
  };
}

// ── The fake ────────────────────────────────────────────────────────────

type Filter = { col: string; op: 'eq' | 'gte' | 'lt' | 'is' | 'in'; val: unknown };

/** Every filter every query applied, so the scoping can be asserted directly. */
type Recorder = { calls: Array<{ table: string; filters: Filter[] }> };

function makeClient(state: Record<string, Row[]>, rec: Recorder = { calls: [] }) {
  return {
    rec,
    from(table: string) {
      if (table !== 'payouts' && table !== 'payout_batches') {
        throw new Error(`fake: unmodelled table "${table}" — model it or the test is vacuous`);
      }
      const filters: Filter[] = [];
      let limit: number | null = null;
      let descending = false;

      const push = (col: string, op: Filter['op'], val: unknown) => {
        filters.push({ col, op, val });
        return b;
      };

      const b: Record<string, unknown> = {
        select: () => b,
        eq:  (c: string, v: unknown) => push(c, 'eq',  v),
        gte: (c: string, v: unknown) => push(c, 'gte', v),
        lt:  (c: string, v: unknown) => push(c, 'lt',  v),
        is:  (c: string, v: unknown) => push(c, 'is',  v),
        in:  (c: string, v: unknown) => push(c, 'in',  v),
        order: (_c: string, o?: { ascending?: boolean }) => {
          descending = o?.ascending === false;
          return b;
        },
        limit: (n: number) => { limit = n; return b; },
        then: (onFulfilled: (v: { data: Row[] }) => unknown) => {
          rec.calls.push({ table, filters });
          let rows = (state[table] ?? []).filter((r) =>
            filters.every((f) => {
              const v = r[f.col];
              switch (f.op) {
                case 'eq':  return v === f.val;
                case 'is':  return v === null || v === undefined;
                case 'in':  return (f.val as unknown[]).includes(v);
                case 'gte': return String(v) >= String(f.val);
                case 'lt':  return String(v) <  String(f.val);
              }
            }),
          );
          const key = table === 'payout_batches' ? 'window_start' : 'created_at';
          rows = [...rows].sort((a, z) =>
            String(a[key]) < String(z[key]) ? -1 : String(a[key]) > String(z[key]) ? 1 : 0);
          if (descending) rows.reverse();
          if (limit !== null) rows = rows.slice(0, limit);
          return Promise.resolve({ data: rows }).then(onFulfilled);
        },
      };
      return b;
    },
  };
}

const run = (state: Record<string, Row[]>, weeks?: number) =>
  resolvePayoutHistory(makeClient(state), PRACTICE, NOW, weeks);

// ─── The three certainties ────────────────────────────────────────────────

describe('a paid batch and a closed-unpaid batch come out DISTINCT', () => {
  const state = {
    payout_batches: [
      batch({
        id: 'b-unpaid', status: 'pending', paid_at: null,
        total_net: 940, plan_count: 1,
      }),
      batch({
        id: 'b-paid', status: 'paid', paid_at: '2026-08-07T11:30:00.000Z',
        window_start: W_AUG_06.windowStart.toISOString(),
        window_end:   W_AUG_06.windowEnd.toISOString(),
        total_net: 1880, plan_count: 2,
      }),
    ],
    payouts: [
      payout({ id: 'p1', batch_id: 'b-unpaid' }),
      payout({ id: 'p2', batch_id: 'b-paid' }),
      payout({ id: 'p3', batch_id: 'b-paid' }),
    ],
  };

  it('assigns the kind from status, not from paid_at being truthy by accident', async () => {
    const { entries } = await run(state);
    const byId = new Map(entries.map((e) => [e.batchId, e]));
    expect(byId.get('b-unpaid')!.kind).toBe('awaiting');
    expect(byId.get('b-paid')!.kind).toBe('paid');
  });

  it('only the paid one carries a transfer date', async () => {
    const { entries } = await run(state);
    const byId = new Map(entries.map((e) => [e.batchId, e]));
    // 11:30 UTC on the 7th is 13:30 SAST the same day.
    expect(byId.get('b-paid')!.dates.paidDate).toBe('2026-08-07');
    expect(byId.get('b-unpaid')!.dates.paidDate).toBeNull();
  });

  it('lists most recent first', async () => {
    const { entries } = await run(state);
    expect(entries.map((e) => e.batchId)).toEqual(['b-unpaid', 'b-paid']);
  });

  it('reports the STORED total, never a recomputed one', async () => {
    // 0090: total_net is "never recomputed from fee_percent — the fee was
    // captured per plan at activation". Here the stored total is deliberately
    // set to a value the rows do not produce, and the entry still reports it.
    const { entries } = await run({
      ...state,
      payout_batches: [batch({ id: 'b-x', total_net: 7777.77, plan_count: 1 })],
      payouts: [payout({ id: 'p1', batch_id: 'b-x', net_amount: 940 })],
    });
    expect(entries[0].totalNet).toBe(7777.77);
    expect(entries[0].plansNetSum).toBe(940);
    expect(entries[0].sumMatchesTotal).toBe(false);
  });
});

// ─── Overdue ──────────────────────────────────────────────────────────────

describe('a closed batch whose transfer day has passed', () => {
  it('is flagged overdue, so the copy can stop naming a past date as "due"', async () => {
    // Due Fri 7 Aug; today is Fri 14 Aug.
    const { entries } = await run({
      payout_batches: [batch({
        id: 'b-late',
        window_start: W_AUG_06.windowStart.toISOString(),
        window_end:   W_AUG_06.windowEnd.toISOString(),
      })],
      payouts: [],
    });
    expect(entries[0].dates.payoutDate).toBe('2026-08-07');
    expect(entries[0].overdue).toBe(true);
  });

  it('is NOT overdue on the day it is due', async () => {
    // Due Fri 14 Aug, which is today. Due today is not late.
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-today' })],
      payouts: [],
    });
    expect(entries[0].dates.payoutDate).toBe('2026-08-14');
    expect(entries[0].overdue).toBe(false);
  });

  it('a PAID batch is never overdue, however old', async () => {
    const { entries } = await run({
      payout_batches: [batch({
        id: 'b-old-paid', status: 'paid', paid_at: '2026-07-31T09:00:00.000Z',
        window_start: W_JUL_30.windowStart.toISOString(),
        window_end:   W_JUL_30.windowEnd.toISOString(),
      })],
      payouts: [],
    });
    expect(entries[0].overdue).toBe(false);
  });
});

// ─── The open week ────────────────────────────────────────────────────────

describe('the in-progress window', () => {
  const inWindow = payout({
    id: 'p-open', batch_id: null, status: 'pending',
    created_at: '2026-08-13T10:00:00.000Z',   // inside Thu 13 – Wed 19
  });

  it('leads the list as an estimate, with no batch id', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1' })],
      payouts: [inWindow, payout({ id: 'p-b', batch_id: 'b-1' })],
    });
    expect(entries[0].kind).toBe('open');
    expect(entries[0].batchId).toBeNull();
    expect(entries[0].key).toBe('open');
    expect(entries[1].batchId).toBe('b-1');
  });

  it('uses the OPEN window and its expected pay date', async () => {
    const { entries } = await run({ payout_batches: [], payouts: [inWindow] });
    expect(entries[0].dates.payoutDate).toBe(payoutDateFor(OPEN));
    expect(entries[0].dates.windowFirst).toBe(windowDates(OPEN).firstDate);
    expect(entries[0].dates.windowLast).toBe(windowDates(OPEN).lastDate);
  });

  it('sums the rows it actually holds — the total IS the breakdown', async () => {
    const { entries } = await run({
      payout_batches: [],
      payouts: [
        payout({ id: 'a', created_at: '2026-08-13T10:00:00.000Z', net_amount: 400 }),
        payout({ id: 'b', created_at: '2026-08-14T06:00:00.000Z', net_amount: 250 }),
      ],
    });
    expect(entries[0].totalNet).toBe(650);
    expect(entries[0].plansNetSum).toBe(650);
    expect(entries[0].sumMatchesTotal).toBe(true);
    expect(entries[0].planCount).toBe(2);
  });

  it('excludes a pending row that activated BEFORE the window opened', async () => {
    // The runner's window is strict, so a stranded row will not be swept into
    // the next close. Counting it here would promise money on a date it will
    // not arrive — it is the hero's strandedCount, and stays there.
    const { entries } = await run({
      payout_batches: [],
      payouts: [payout({ id: 'p-old', batch_id: null, created_at: '2026-08-01T10:00:00.000Z' })],
    });
    expect(entries).toEqual([]);
  });

  it('excludes an already-batched row, and a non-pending one', async () => {
    const { entries } = await run({
      payout_batches: [],
      payouts: [
        payout({ id: 'p-batched', batch_id: 'b-9', created_at: '2026-08-13T10:00:00.000Z' }),
        payout({ id: 'p-paid', batch_id: null, status: 'paid', created_at: '2026-08-13T10:00:00.000Z' }),
      ],
    });
    expect(entries).toEqual([]);
  });

  it('synthesises NOTHING for an empty open week — no fabricated R0 row', async () => {
    const { entries } = await run({ payout_batches: [], payouts: [] });
    expect(entries).toEqual([]);
  });
});

// ─── Grouping and the breakdown ───────────────────────────────────────────

describe('each batch gets its OWN plans', () => {
  const state = {
    payout_batches: [
      batch({ id: 'b-A', total_net: 1880, plan_count: 2 }),
      batch({
        id: 'b-B', total_net: 940, plan_count: 1,
        window_start: W_AUG_06.windowStart.toISOString(),
        window_end:   W_AUG_06.windowEnd.toISOString(),
      }),
    ],
    payouts: [
      payout({ id: 'a1', batch_id: 'b-A', net_amount: 940 }),
      payout({ id: 'a2', batch_id: 'b-A', net_amount: 940 }),
      payout({ id: 'b1', batch_id: 'b-B', net_amount: 940 }),
    ],
  };

  it('does not spill one batch\'s plans into another', async () => {
    const { entries } = await run(state);
    const byId = new Map(entries.map((e) => [e.batchId, e]));
    expect(byId.get('b-A')!.plans.map((p) => p.payoutId)).toEqual(['a1', 'a2']);
    expect(byId.get('b-B')!.plans.map((p) => p.payoutId)).toEqual(['b1']);
  });

  it('the nets sum EXACTLY to the stored batch total', async () => {
    // The promise of the whole screen: 940 + 940 = 1880.
    const { entries } = await run(state);
    const a = entries.find((e) => e.batchId === 'b-A')!;
    expect(a.plansNetSum).toBe(a.totalNet);
    expect(a.sumMatchesTotal).toBe(true);
  });

  it('carries gross, fee and net per plan — all three read, none derived', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1', total_net: 940 })],
      payouts: [payout({ id: 'p1', batch_id: 'b-1', gross_amount: 1000, fee_amount: 60, net_amount: 940 })],
    });
    const [line] = entries[0].plans;
    expect(line.grossAmount).toBe(1000);
    expect(line.feeAmount).toBe(60);
    expect(line.netAmount).toBe(940);
  });

  it('keeps a fee that does NOT match today\'s commission', async () => {
    // The case that makes reading the column mandatory: this row was activated
    // under a 20% fee. Recomputing from practices.fee_percent would silently
    // restate a settled deposit and stop matching the invoice it was taken
    // against. 200 is not 6% of 1000, and it must survive.
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1', total_net: 800 })],
      payouts: [payout({ id: 'p1', batch_id: 'b-1', gross_amount: 1000, fee_amount: 200, net_amount: 800 })],
    });
    expect(entries[0].plans[0].feeAmount).toBe(200);
    expect(entries[0].plansNetSum).toBe(800);
    expect(entries[0].sumMatchesTotal).toBe(true);
  });

  it('names the patient with an initial only', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1' })],
      payouts: [payout({ id: 'p1', batch_id: 'b-1' })],
    });
    expect(entries[0].plans[0].patientLabel).toBe('Thabo M.');
  });

  it('carries the practice\'s OWN reference alongside the invoice number', async () => {
    // The string the practice typed on their side — what they reconcile by.
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1' })],
      payouts: [payout({ id: 'p1', batch_id: 'b-1' })],
    });
    expect(entries[0].plans[0].invoiceNumber).toBe('INV-p1');
    expect(entries[0].plans[0].practiceReference).toBe('REF-p1');
  });

  it('flags a batch that claims plans but returns none, rather than showing a count over nothing', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1', plan_count: 3, total_net: 900 })],
      payouts: [],
    });
    expect(entries[0].plansHidden).toBe(true);
    expect(entries[0].totalNet).toBe(900);
    // Not ALSO reported as a sum mismatch — there is no sum to be wrong.
    expect(entries[0].sumMatchesTotal).toBe(true);
  });

  it('a genuinely empty batch is not "hidden"', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1', plan_count: 0, total_net: 0 })],
      payouts: [],
    });
    expect(entries[0].plansHidden).toBe(false);
  });
});

// ─── The window each batch describes ──────────────────────────────────────

describe('window dates come from the batch\'s own stored boundaries', () => {
  it('matches the shared helpers exactly, and never the exclusive Thursday', async () => {
    const { entries } = await run({
      payout_batches: [batch({ id: 'b-1' })],
      payouts: [],
    });
    const { firstDate, lastDate } = windowDates(W_AUG_13);
    expect(entries[0].dates.windowFirst).toBe(firstDate);
    expect(entries[0].dates.windowLast).toBe(lastDate);
    expect(entries[0].dates.payoutDate).toBe(payoutDateFor(W_AUG_13));
    // Thu 6 through Wed 12 — the INCLUSIVE last day, not the boundary.
    expect(entries[0].dates.windowFirst).toBe('2026-08-06');
    expect(entries[0].dates.windowLast).toBe('2026-08-12');
    expect(entries[0].dates.payoutDate).toBe('2026-08-14');
  });

  it('an old batch keeps describing the week it actually covered', async () => {
    // Not a window recomputed from today: a batch from July stays a July batch.
    const { entries } = await run({
      payout_batches: [batch({
        id: 'b-old',
        window_start: W_JUL_30.windowStart.toISOString(),
        window_end:   W_JUL_30.windowEnd.toISOString(),
      })],
      payouts: [],
    });
    expect(entries[0].dates.windowFirst).toBe(windowDates(W_JUL_30).firstDate);
    expect(entries[0].dates.windowFirst).toBe('2026-07-23');
  });
});

// ─── The cap is stated, not silent ────────────────────────────────────────

describe('the history is bounded and says so', () => {
  it('reads at most PAYOUT_HISTORY_WEEKS batches', async () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      batch({
        id: `b-${i}`,
        // 40 distinct descending windows — the exact instants do not matter to
        // the cap, only that they order.
        window_start: new Date(Date.UTC(2026, 0, 1) - i * 7 * 864e5).toISOString(),
        window_end:   new Date(Date.UTC(2026, 0, 8) - i * 7 * 864e5).toISOString(),
      }),
    );
    const { entries, truncated, batchCount } = await run({ payout_batches: many, payouts: [] });
    expect(entries.length).toBe(PAYOUT_HISTORY_WEEKS);
    expect(batchCount).toBe(PAYOUT_HISTORY_WEEKS);
    expect(truncated).toBe(true);
  });

  it('is not marked truncated when everything fits', async () => {
    const { truncated } = await run({
      payout_batches: [batch({ id: 'b-1' })],
      payouts: [],
    });
    expect(truncated).toBe(false);
  });
});

// ─── ADVERSARIAL: another practice's money ────────────────────────────────

describe('ADVERSARIAL — another practice never appears', () => {
  const state = {
    payout_batches: [
      batch({ id: 'mine',   practice_id: PRACTICE, total_net: 940 }),
      batch({ id: 'theirs', practice_id: OTHER,    total_net: 99999 }),
    ],
    payouts: [
      payout({ id: 'p-mine',   practice_id: PRACTICE, batch_id: 'mine' }),
      payout({ id: 'p-theirs', practice_id: OTHER,    batch_id: 'theirs' }),
      // The nastiest shape: their row carrying MY batch id. Scoping by
      // practice_id is what keeps it out — batch membership alone would not.
      payout({ id: 'p-crossed', practice_id: OTHER, batch_id: 'mine' }),
      // And an open-window row belonging to them.
      payout({
        id: 'p-theirs-open', practice_id: OTHER, batch_id: null,
        created_at: '2026-08-13T10:00:00.000Z',
      }),
    ],
  };

  it('returns only this practice\'s batches', async () => {
    const { entries } = await run(state);
    expect(entries.map((e) => e.batchId)).toEqual(['mine']);
  });

  it('returns only this practice\'s plan lines, even inside my own batch', async () => {
    const { entries } = await run(state);
    expect(entries[0].plans.map((p) => p.payoutId)).toEqual(['p-mine']);
  });

  it('does not build an open-window estimate out of their rows', async () => {
    const { entries } = await run(state);
    expect(entries.some((e) => e.kind === 'open')).toBe(false);
  });

  it('EVERY query carries the practice scope — structurally, not by luck', async () => {
    const rec: Recorder = { calls: [] };
    await resolvePayoutHistory(makeClient(state, rec), PRACTICE, NOW);
    expect(rec.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of rec.calls) {
      expect(
        call.filters.some((f) => f.col === 'practice_id' && f.op === 'eq' && f.val === PRACTICE),
        `${call.table} query is missing its practice scope`,
      ).toBe(true);
    }
  });
});

// ─── ADVERSARIAL: no money or date logic of its own ───────────────────────

describe('ADVERSARIAL — the loader computes no fee and no calendar date', () => {
  const SRC = readFileSync(resolve(process.cwd(), 'lib/practice/payoutHistory.ts'), 'utf8')
    .replace(/\r\n/g, '\n');
  const code = stripComments(SRC);

  it('imports no fee helper — gross, fee and net are stored columns', () => {
    // Recomputing would restate settled history the moment a practice's
    // commission changed.
    expect(code).not.toMatch(/calculateFee/);
    expect(code).not.toMatch(/@\/lib\/finance/);
    expect(code).not.toMatch(/fee_percent/);
    expect(code).not.toMatch(/feePercent/);
  });

  it('derives the fee from nothing — it selects all three amounts', () => {
    expect(code).toMatch(/gross_amount/);
    expect(code).toMatch(/fee_amount/);
    expect(code).toMatch(/net_amount/);
    // No subtraction standing in for the stored fee.
    expect(code).not.toMatch(/grossAmount\s*-\s*netAmount/);
  });

  it('does every calendar conversion through the shared helpers', () => {
    expect(SRC).toMatch(/from '@\/lib\/payments\/payoutSchedule'/);
    expect(SRC).toMatch(/from '@\/lib\/payments\/payoutWindow'/);
    expect(code).toMatch(/payoutDateFor\(/);
    expect(code).toMatch(/windowDates\(/);
    expect(code).toMatch(/sastDateString\(/);
  });

  it('does no date arithmetic and hardcodes no weekday or month', () => {
    for (const forbidden of [
      /toISOString\(\)\.slice/, /getUTCDay/, /getDay\b/, /getMonth/, /getFullYear/,
      /setHours/, /toLocaleDateString/, /86_?400_?000/, /24 \* 60 \* 60/,
    ]) {
      expect(code, `must not contain ${forbidden}`).not.toMatch(forbidden);
    }
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) {
      expect(code, `must not hardcode "${day}"`).not.toMatch(new RegExp(`['"\`][^'"\`]*${day}`));
    }
  });

  it('formats nothing — that is the component\'s job, through shared formatters', () => {
    expect(code).not.toMatch(/formatRand/);
    expect(code).not.toMatch(/toFixed/);
    expect(code).not.toMatch(/formatWeekdayDayMonth/);
  });

  it('never says MDR — the practice-facing name is the BetterNow fee', () => {
    // Comments may NAME the forbidden term in order to forbid it (this file's
    // own docstring does); code must not carry it. Same distinction the
    // pending_acceptance pin in monthly-revenue-chart.test.ts draws.
    expect(code).not.toMatch(/\bMDR\b/);
  });
});
