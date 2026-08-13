import { resolveNextPayout, type NextPayoutSupabase } from '@/lib/practice/nextPayout';
import { payoutDateFor, windowDates } from '@/lib/payments/payoutSchedule';

// ─── Next payouts across a brand's practices ────────────────────────────────
//
// WHAT THIS IS, AND WHAT IT REFUSES TO BE
// ───────────────────────────────────────
// Payouts are PER PRACTICE. A brand with three practices receives three
// separate EFTs into three accounts, each reconcilable against that practice's
// own plans. There is no group-level payout row anywhere in the schema and this
// module does not invent one: it resolves each practice's own next payout and
// reports the collection PLUS a sum, keeping the parts alongside the whole so a
// caller physically cannot render the total without the deposit count.
//
// That is why `perPractice` is not optional and why `depositCount` is a field
// rather than something the UI derives — a total presented as one figure is
// unreconcilable against a bank feed, and the shape of this return value is the
// first line of defence against presenting one.
//
// WHY IT DELEGATES TO resolveNextPayout PER PRACTICE
// ─────────────────────────────────────────────────
// It would be cheaper to read payout_batches once with .in('practice_id', ids)
// and group in memory — two queries regardless of N instead of roughly four per
// practice. It deliberately does not, and the reason is the committed /
// projected / none trichotomy.
//
// That trichotomy is the most honesty-critical logic in the payout stack: it
// decides whether a figure is a promise or a running total, whether the open
// window or a batch's own stored boundaries describe it, and which pending rows
// are in-window rather than stranded. lib/practice/nextPayout.ts holds it, with
// its reasoning, and its own header records what happened the last time an app
// surface kept a second copy of a payout rule (the RLS comments in it were wrong
// within a day of the policy changing). A second derivation here would be that
// mistake again, one scope up, with a brand admin's bank reconciliation
// downstream of it.
//
// So the cost is paid on purpose, and it is smaller than it looks:
//   • LATENCY does not scale with N. The practices fan out concurrently, so wall
//     clock is roughly one resolveNextPayout, not N of them.
//   • QUERY COUNT does scale with N — about 4N. For the brand sizes this product
//     has (2 to a few dozen practices) that is tens of queries on a
//     force-dynamic page, not thousands.
//   • Some of that work is wasted: resolveNextPayout also loads the per-plan
//     breakdown behind each figure, which the group hero does not show. Kept
//     rather than trimmed, because trimming it means a second, narrower loader —
//     the very split this module exists to avoid. The per-practice PLAN detail
//     lives one level down, on that practice's own /practice/payouts tab, which
//     is where the brief puts reconciliation anyway.
//
// NO SCOPING DECISION IS MADE HERE. The caller passes the practices it has
// already proven the viewer administers, and every read inherits
// resolveNextPayout's own unconditional .eq('practice_id', …).

/** One practice's next payout, flattened for a list row. */
export type BrandPracticePayout = {
  practiceId:   string;
  practiceName: string;
  /**
   * 'awaiting' — a batch is CLOSED and final; the EFT has not been run.
   * 'open'     — the week is still accumulating; the figure is an estimate.
   * 'none'     — nothing scheduled. NOT "owed zero".
   *
   * Already in ../../app/practice/payoutCopy's vocabulary rather than
   * nextPayout's committed/projected, so no component maps it a second time.
   */
  state:     'awaiting' | 'open' | 'none';
  totalNet:  number;
  planCount: number;
  /** Pre-resolved SAST calendar dates. Null in the 'none' state. */
  dates: {
    payoutDate:  string | null;
    windowFirst: string | null;
    windowLast:  string | null;
  };
  paidRecentlyNet:   number;
  paidRecentlyCount: number;
  otherPendingCount: number;
  otherPendingNet:   number;
  strandedCount:     number;
};

export type BrandPayoutRollup = {
  /** EVERY practice handed in, including those with nothing scheduled. */
  perPractice: BrandPracticePayout[];
  /**
   * Practices with a payout at all — which IS the number of separate deposits
   * the total represents. Named for the deposit rather than the practice
   * because that is the fact a brand admin reconciles against.
   */
  depositCount: number;
  /** Sum of the per-practice figures. Exact to the cent by construction. */
  totalNet:  number;
  planCount: number;
  /** How the total splits across certainties — a mixed total must say so. */
  awaitingCount: number;
  openCount:     number;
  /** Unique payout dates among contributing practices, earliest first. One
   *  entry → the hero may name a date; more → it must not. */
  payoutDates: string[];
  paidRecentlyNet:   number;
  paidRecentlyCount: number;
  /** Closed-but-unpaid batches BEYOND each practice's next one. Extra deposits,
   *  never folded into totalNet — the same choice the practice hero makes. */
  otherPendingCount: number;
  otherPendingNet:   number;
  strandedCount:     number;
};

export async function resolveBrandPayouts(
  supabase:  NextPayoutSupabase,
  practices: Array<{ id: string; name: string }>,
  now:       Date = new Date(),
): Promise<BrandPayoutRollup> {
  // Concurrent, so latency is one round of queries rather than N — see the
  // header on why the query count is spent deliberately.
  const resolved = await Promise.all(
    practices.map(async (p) => ({ practice: p, result: await resolveNextPayout(supabase, p.id, now) })),
  );

  const perPractice: BrandPracticePayout[] = resolved.map(({ practice, result }) => {
    const { next } = result;
    // The window is the batch's OWN stored boundaries for a closed batch and
    // the open window for a projection — resolveNextPayout already chose;
    // this only formats what it chose, through the shared helpers.
    const window = next.kind === 'none' ? null : next.window;

    return {
      practiceId:   practice.id,
      practiceName: practice.name,
      state:        next.kind === 'none' ? 'none' : next.kind === 'committed' ? 'awaiting' : 'open',
      totalNet:     next.kind === 'none' ? 0 : next.totalNet,
      planCount:    next.kind === 'none' ? 0 : next.planCount,
      dates: {
        payoutDate:  window ? payoutDateFor(window)         : null,
        windowFirst: window ? windowDates(window).firstDate  : null,
        windowLast:  window ? windowDates(window).lastDate   : null,
      },
      paidRecentlyNet:   result.paidRecentlyNet,
      paidRecentlyCount: result.paidRecentlyCount,
      otherPendingCount: result.otherPendingCount,
      otherPendingNet:   result.otherPendingNet,
      strandedCount:     result.strandedCount,
    };
  });

  const contributing = perPractice.filter((p) => p.state !== 'none');

  // Sorted highest-first so the practice that dominates the deposit total reads
  // first, and a practice with nothing scheduled sinks to the bottom rather
  // than interrupting the list. Name breaks ties, so the order is stable across
  // renders instead of following whatever order the practices arrived in.
  const ordered = [...perPractice].sort((a, b) =>
    b.totalNet - a.totalNet || a.practiceName.localeCompare(b.practiceName),
  );

  return {
    perPractice:   ordered,
    depositCount:  contributing.length,
    totalNet:      round2(sum(contributing.map((p) => p.totalNet))),
    planCount:     sum(contributing.map((p) => p.planCount)),
    awaitingCount: contributing.filter((p) => p.state === 'awaiting').length,
    openCount:     contributing.filter((p) => p.state === 'open').length,
    payoutDates:   uniqueSorted(contributing.map((p) => p.dates.payoutDate)),
    paidRecentlyNet:   round2(sum(perPractice.map((p) => p.paidRecentlyNet))),
    paidRecentlyCount: sum(perPractice.map((p) => p.paidRecentlyCount)),
    otherPendingCount: sum(perPractice.map((p) => p.otherPendingCount)),
    otherPendingNet:   round2(sum(perPractice.map((p) => p.otherPendingNet))),
    strandedCount:     sum(perPractice.map((p) => p.strandedCount)),
  };
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0);
}

/**
 * YYYY-MM-DD sorts correctly as a string, so this needs no Date and cannot
 * drift by timezone — the reason lib/payments/payoutSchedule hands these out as
 * calendar strings in the first place.
 */
function uniqueSorted(dates: Array<string | null>): string[] {
  return [...new Set(dates.filter((d): d is string => !!d))].sort();
}

/** Rands to 2dp. Sums of NUMERIC(12,2) can pick up float dust in JS. */
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
