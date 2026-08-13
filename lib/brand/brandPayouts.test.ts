import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { resolveBrandPayouts } from './brandPayouts';
import { resolveNextPayout } from '@/lib/practice/nextPayout';
import { payoutWindowEndingOn } from '@/lib/payments/payoutWindow';
import { payoutDateFor, openPayoutWindow } from '@/lib/payments/payoutSchedule';

// ─── Next payouts across a brand ───────────────────────────────────────────
//
// The one thing this module must never do is present a group total as though it
// were a transfer. So the assertions come in two halves:
//
//   ARITHMETIC — the total is the sum of the per-practice figures to the cent,
//   and the deposit count is the number of practices contributing to it. If
//   those two ever disagree the UI is describing a transfer that will not
//   happen.
//
//   CERTAINTY — a closed-but-unpaid batch comes out 'awaiting', never 'paid'
//   and never merged with a still-open week. That mapping is the single way this
//   feature could tell a brand their money has landed when it has not.
//
// The fake client HONOURS its filters, which is what makes the cross-practice
// test mean anything: the module's whole scoping guarantee is inherited from
// resolveNextPayout's unconditional .eq('practice_id', …), and a fake that
// returned everything regardless would pass whether that filter existed or not.
// It also throws on an unmodelled table, so a future query cannot pass silently.

const NOW = new Date('2026-08-14T07:00:00.000Z');    // Fri 14 Aug 2026, 09:00 SAST

const W_AUG_13 = payoutWindowEndingOn('2026-08-13'); // Thu 6  – Wed 12, due Fri 14
const W_AUG_06 = payoutWindowEndingOn('2026-08-06'); // Thu 30 – Wed 5,  due Fri 7
const OPEN     = openPayoutWindow(NOW);              // Thu 13 – Wed 19, due Fri 21

const A = { id: 'prac-a', name: 'Rosebank' };
const B = { id: 'prac-b', name: 'Sandton'  };
const C = { id: 'prac-c', name: 'Midrand'  };

type Row = Record<string, unknown>;

function batch(over: Row & { id: string; practice_id: string }): Row {
  return {
    window_start: W_AUG_13.windowStart.toISOString(),
    window_end:   W_AUG_13.windowEnd.toISOString(),
    total_net:    1000,
    plan_count:   1,
    status:       'pending',
    paid_at:      null,
    ...over,
  };
}

function payout(over: Row & { id: string; practice_id: string }): Row {
  return {
    plan_id:      `pl-${over.id}`,
    batch_id:     null,
    net_amount:   940,
    status:       'pending',
    created_at:   '2026-08-17T08:00:00.000Z',   // inside OPEN
    plans: {
      invoice_number: `INV-${over.id}`,
      patient: { first_name: 'Thabo', last_name: 'Mokoena' },
    },
    ...over,
  };
}

// ── The fake ────────────────────────────────────────────────────────────────

type Filter = { col: string; op: 'eq' | 'gte' | 'lt' | 'is' | 'in'; val: unknown };
type Recorder = { calls: Array<{ table: string; filters: Filter[] }> };

function makeClient(state: Record<string, Row[]>, rec: Recorder = { calls: [] }) {
  return {
    rec,
    from(table: string) {
      if (table !== 'payouts' && table !== 'payout_batches') {
        throw new Error(`fake: unmodelled table "${table}" — model it or the test is vacuous`);
      }
      const filters: Filter[] = [];
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
        limit: () => b,
        then: (onFulfilled: (v: { data: Row[]; count: number }) => unknown) => {
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
          rows = [...rows].sort((x, z) =>
            String(x[key]) < String(z[key]) ? -1 : String(x[key]) > String(z[key]) ? 1 : 0);
          if (descending) rows.reverse();
          // countStranded issues a head+count query, so both fields resolve.
          return Promise.resolve({ data: rows, count: rows.length }).then(onFulfilled);
        },
      };
      return b;
    },
  };
}

const run = (state: Record<string, Row[]>, practices = [A, B, C]) =>
  resolveBrandPayouts(makeClient(state), practices, NOW);

// ─── Arithmetic: the total IS the sum, and the deposits ARE the practices ───

describe('a group total decomposes exactly into its deposits', () => {
  // Three practices, three different certainties:
  //   A  a closed batch awaiting transfer   R1,240.50
  //   B  a still-open week, two plans       R1,880.00
  //   C  nothing at all
  const state = {
    payout_batches: [
      batch({ id: 'ba', practice_id: A.id, total_net: 1240.5, plan_count: 3 }),
    ],
    payouts: [
      payout({ id: 'pb1', practice_id: B.id }),
      payout({ id: 'pb2', practice_id: B.id }),
    ],
  };

  it('totalNet equals the sum of the per-practice figures, to the cent', async () => {
    const r = await run(state);
    const perPracticeSum = r.perPractice.reduce((s, p) => s + p.totalNet, 0);
    expect(r.totalNet).toBe(1240.5 + 940 + 940);
    expect(r.totalNet).toBe(Math.round(perPracticeSum * 100) / 100);
  });

  it('depositCount counts the practices that actually have a payout — not all of them', async () => {
    const r = await run(state);
    expect(r.perPractice).toHaveLength(3);      // every practice is listed
    expect(r.depositCount).toBe(2);             // only two produce a transfer
  });

  it('the practice with nothing scheduled is present but contributes nothing', async () => {
    const r = await run(state);
    const c = r.perPractice.find((p) => p.practiceId === C.id)!;
    expect(c.state).toBe('none');
    expect(c.totalNet).toBe(0);
    expect(c.planCount).toBe(0);
    expect(c.dates.payoutDate).toBeNull();
  });

  it('planCount is the sum over contributing practices only', async () => {
    const r = await run(state);
    expect(r.planCount).toBe(3 + 2);
  });

  it('every practice handed in comes back, even one with no rows at all', async () => {
    const r = await run({});
    expect(r.perPractice.map((p) => p.practiceId).sort()).toEqual([A.id, B.id, C.id].sort());
    expect(r.depositCount).toBe(0);
    expect(r.totalNet).toBe(0);
  });
});

// ─── Certainty: closed-unpaid is NOT paid, and mixed says so ───────────────

describe('the three certainties survive the roll-up', () => {
  it("a closed batch is 'awaiting' — never 'paid', and never merged with an open week", async () => {
    const r = await run({
      payout_batches: [batch({ id: 'ba', practice_id: A.id })],
      payouts:        [payout({ id: 'pb', practice_id: B.id })],
    });
    const a = r.perPractice.find((p) => p.practiceId === A.id)!;
    const b = r.perPractice.find((p) => p.practiceId === B.id)!;
    expect(a.state).toBe('awaiting');
    expect(b.state).toBe('open');
    expect(r.awaitingCount).toBe(1);
    expect(r.openCount).toBe(1);
  });

  it('a batch already marked paid is NOT a next payout — it lands in the 30-day figure', async () => {
    // The bug this forbids: reading status without filtering, so a settled
    // batch is re-presented as money still coming.
    const r = await run({
      payout_batches: [
        batch({
          id: 'paid', practice_id: A.id, status: 'paid',
          paid_at: '2026-08-07T11:30:00.000Z', total_net: 5000,
          window_start: W_AUG_06.windowStart.toISOString(),
          window_end:   W_AUG_06.windowEnd.toISOString(),
        }),
      ],
    });
    expect(r.depositCount).toBe(0);
    expect(r.totalNet).toBe(0);
    expect(r.paidRecentlyNet).toBe(5000);
    expect(r.paidRecentlyCount).toBe(1);
  });

  it('awaitingCount + openCount === depositCount, always', async () => {
    const r = await run({
      payout_batches: [
        batch({ id: 'ba', practice_id: A.id }),
        batch({ id: 'bc', practice_id: C.id }),
      ],
      payouts: [payout({ id: 'pb', practice_id: B.id })],
    });
    expect(r.awaitingCount + r.openCount).toBe(r.depositCount);
    expect(r.depositCount).toBe(3);
  });

  it('paidRecently sums across EVERY practice, including ones with no next payout', async () => {
    const r = await run({
      payout_batches: [
        batch({ id: 'p1', practice_id: A.id, status: 'paid', paid_at: '2026-08-07T11:30:00.000Z', total_net: 100 }),
        batch({ id: 'p2', practice_id: C.id, status: 'paid', paid_at: '2026-08-07T11:30:00.000Z', total_net: 250.25 }),
      ],
    });
    expect(r.paidRecentlyNet).toBe(350.25);
    expect(r.paidRecentlyCount).toBe(2);
  });
});

// ─── Dates: one date may be named, several may not ─────────────────────────

describe('payout dates', () => {
  it('collapses to ONE date when every deposit lands the same day', async () => {
    const r = await run({
      payout_batches: [
        batch({ id: 'ba', practice_id: A.id }),
        batch({ id: 'bc', practice_id: C.id }),
      ],
    });
    expect(r.payoutDates).toEqual([payoutDateFor(W_AUG_13)]);
  });

  it('reports SEVERAL dates when an earlier unsettled week is in play', async () => {
    // A's next payout is the week ending 6 Aug (older, so it is next);
    // C's is the week ending 13 Aug. Two different Fridays, so the hero must
    // not name one of them.
    const r = await run({
      payout_batches: [
        batch({
          id: 'ba', practice_id: A.id,
          window_start: W_AUG_06.windowStart.toISOString(),
          window_end:   W_AUG_06.windowEnd.toISOString(),
        }),
        batch({ id: 'bc', practice_id: C.id }),
      ],
    });
    expect(r.payoutDates).toEqual([payoutDateFor(W_AUG_06), payoutDateFor(W_AUG_13)]);
    expect(r.payoutDates.length).toBeGreaterThan(1);
  });

  it('dates come from the shared helpers — a closed batch keeps ITS window, an open week gets the open one', async () => {
    const r = await run({
      payout_batches: [batch({ id: 'ba', practice_id: A.id })],
      payouts:        [payout({ id: 'pb', practice_id: B.id })],
    });
    const a = r.perPractice.find((p) => p.practiceId === A.id)!;
    const b = r.perPractice.find((p) => p.practiceId === B.id)!;
    expect(a.dates.payoutDate).toBe(payoutDateFor(W_AUG_13));
    expect(b.dates.payoutDate).toBe(payoutDateFor(OPEN));
    // And the window text a UI would print is the helper's own output.
    expect(a.dates.windowFirst).toBe('2026-08-06');
    expect(a.dates.windowLast).toBe('2026-08-12');
  });

  it('a practice with nothing scheduled carries no dates at all — not today\'s', async () => {
    const r = await run({});
    for (const p of r.perPractice) {
      expect(p.dates.payoutDate).toBeNull();
      expect(p.dates.windowFirst).toBeNull();
      expect(p.dates.windowLast).toBeNull();
    }
  });
});

// ─── Extra deposits stay extra ─────────────────────────────────────────────

describe('earlier unsettled batches are extra deposits, not a bigger one', () => {
  it('an unsettled earlier week is reported separately, NOT folded into totalNet', async () => {
    const r = await run({
      payout_batches: [
        batch({
          id: 'older', practice_id: A.id, total_net: 500,
          window_start: W_AUG_06.windowStart.toISOString(),
          window_end:   W_AUG_06.windowEnd.toISOString(),
        }),
        batch({ id: 'newer', practice_id: A.id, total_net: 700 }),
      ],
    });
    // The oldest is "next" (it has waited longest) and the other is a footnote.
    expect(r.totalNet).toBe(500);
    expect(r.otherPendingCount).toBe(1);
    expect(r.otherPendingNet).toBe(700);
    // Still ONE deposit counted in the total, from one practice.
    expect(r.depositCount).toBe(1);
  });

  it('stranded plans are counted across the group', async () => {
    const r = await run({
      payouts: [
        payout({ id: 's1', practice_id: A.id, created_at: '2026-07-01T08:00:00.000Z' }),
        payout({ id: 's2', practice_id: B.id, created_at: '2026-07-01T08:00:00.000Z' }),
      ],
    });
    expect(r.strandedCount).toBe(2);
    // A pre-window pending row is NOT promised a date, so it is not a deposit.
    expect(r.depositCount).toBe(0);
  });
});

// ─── Ordering ─────────────────────────────────────────────────────────────

describe('ordering', () => {
  it('largest deposit first, practices with nothing last', async () => {
    const r = await run({
      payout_batches: [
        batch({ id: 'ba', practice_id: A.id, total_net: 100 }),
        batch({ id: 'bc', practice_id: C.id, total_net: 900 }),
      ],
    });
    expect(r.perPractice.map((p) => p.practiceId)).toEqual([C.id, A.id, B.id]);
  });

  it('ties break on name, so the order is stable across renders', async () => {
    const r = await run({
      payout_batches: [
        batch({ id: 'ba', practice_id: A.id, total_net: 100 }),
        batch({ id: 'bb', practice_id: B.id, total_net: 100 }),
      ],
      // Reversed input order — the output must not follow it.
    }, [B, A, C]);
    // Midrand (C, zero) last; Rosebank before Sandton alphabetically.
    expect(r.perPractice.map((p) => p.practiceName)).toEqual(['Rosebank', 'Sandton', 'Midrand']);
  });
});

// ─── Adversarial: one brand never sees another's money ────────────────────

describe('a brand admin never sees a practice outside the list they were given', () => {
  it('rows belonging to an unlisted practice contribute nothing', async () => {
    const state = {
      payout_batches: [
        batch({ id: 'mine',   practice_id: A.id, total_net: 100 }),
        batch({ id: 'theirs', practice_id: 'other-brand-practice', total_net: 999999 }),
      ],
      payouts: [
        payout({ id: 'theirs-p', practice_id: 'other-brand-practice', net_amount: 555555 }),
      ],
    };
    const r = await resolveBrandPayouts(makeClient(state), [A], NOW);
    expect(r.totalNet).toBe(100);
    expect(r.depositCount).toBe(1);
    expect(r.perPractice.map((p) => p.practiceId)).toEqual([A.id]);
    expect(JSON.stringify(r)).not.toContain('other-brand-practice');
    expect(JSON.stringify(r)).not.toContain('999999');
    expect(JSON.stringify(r)).not.toContain('555555');
  });

  it('EVERY query it issues is filtered by practice_id — no unscoped read exists', async () => {
    const rec: Recorder = { calls: [] };
    const client = makeClient({
      payout_batches: [batch({ id: 'ba', practice_id: A.id })],
      payouts:        [payout({ id: 'pb', practice_id: A.id })],
    }, rec);
    await resolveBrandPayouts(client, [A, B], NOW);

    expect(rec.calls.length).toBeGreaterThan(0);
    for (const call of rec.calls) {
      const scoped = call.filters.find((f) => f.col === 'practice_id' && f.op === 'eq');
      expect(scoped, `${call.table} query without an eq practice_id`).toBeTruthy();
      expect([A.id, B.id]).toContain(scoped!.val);
    }
  });

  it('passing an empty practice list reads nothing and claims nothing', async () => {
    const rec: Recorder = { calls: [] };
    const r = await resolveBrandPayouts(
      makeClient({ payout_batches: [batch({ id: 'x', practice_id: A.id })] }, rec),
      [],
      NOW,
    );
    expect(rec.calls).toHaveLength(0);
    expect(r.depositCount).toBe(0);
    expect(r.totalNet).toBe(0);
    expect(r.perPractice).toEqual([]);
  });
});

// ─── It agrees with the practice's own dashboard, by construction ─────────

describe('per-practice figures equal what that practice sees on its own hero', () => {
  // The point of delegating to resolveNextPayout rather than writing a second
  // bulk query is that a brand admin and a practice manager cannot be shown
  // different numbers for the same money. This asserts the agreement directly
  // rather than trusting the delegation.
  const state = {
    payout_batches: [batch({ id: 'ba', practice_id: A.id, total_net: 1240.5, plan_count: 3 })],
    payouts: [
      payout({ id: 'pb1', practice_id: B.id }),
      payout({ id: 'pb2', practice_id: B.id }),
    ],
  };

  it.each([[A], [B], [C]])('%o matches resolveNextPayout for that practice', async (practice) => {
    const brand = await run(state);
    const own   = await resolveNextPayout(makeClient(state), practice.id, NOW);
    const row   = brand.perPractice.find((p) => p.practiceId === practice.id)!;

    if (own.next.kind === 'none') {
      expect(row.state).toBe('none');
      expect(row.totalNet).toBe(0);
    } else {
      expect(row.totalNet).toBe(own.next.totalNet);
      expect(row.planCount).toBe(own.next.planCount);
      expect(row.state).toBe(own.next.kind === 'committed' ? 'awaiting' : 'open');
    }
    expect(row.paidRecentlyNet).toBe(own.paidRecentlyNet);
    expect(row.otherPendingNet).toBe(own.otherPendingNet);
    expect(row.strandedCount).toBe(own.strandedCount);
  });
});

// ─── Source pins ─────────────────────────────────────────────────────────

describe('source pins — no second derivation, no local formatting', () => {
  const SRC  = readFileSync(resolve(process.cwd(), 'lib/brand/brandPayouts.ts'), 'utf8');
  const code = stripComments(SRC);

  it('delegates to resolveNextPayout rather than querying payout tables itself', () => {
    expect(code).toMatch(/resolveNextPayout/);
    expect(code).not.toMatch(/from\('payout_batches'\)/);
    expect(code).not.toMatch(/from\('payouts'\)/);
  });

  it('never decides the committed/projected trichotomy for itself', () => {
    // It may only READ next.kind. Reconstructing it — from status, paid_at, or
    // a window comparison — is the second copy of a payout rule this module
    // exists to avoid.
    expect(code).not.toMatch(/status === 'pending'/);
    expect(code).not.toMatch(/paid_at/);
    expect(code).not.toMatch(/openPayoutWindow/);
  });

  it('does its date work through the shared helpers only', () => {
    expect(code).toMatch(/payoutDateFor/);
    expect(code).toMatch(/windowDates/);
    // No timezone-sensitive reading or formatting of an instant anywhere — that
    // is the bug class payoutSchedule.ts exists to prevent (a SAST midnight
    // formatted in the host timezone names the wrong DAY).
    expect(code).not.toMatch(/toISOString|getDay|getMonth|getDate|toLocaleDateString/);
    // Exactly ONE `new Date(` — the default-argument clock, `now: Date = new
    // Date()`. Not banned outright, because a function that takes `now` has to
    // default it; banned everywhere else, because a second construction would be
    // date arithmetic. Asserted as a count so a new one cannot hide behind it.
    const constructions = code.match(/new Date\(/g) ?? [];
    expect(constructions).toHaveLength(1);
    expect(code).toMatch(/now:\s+Date = new Date\(\)/);
  });

  it('formats no money — it returns numbers and lets the component format them', () => {
    expect(code).not.toMatch(/toFixed|toLocaleString|R\$\{|'R'/);
  });
});
