import {
  payoutWindowForRun,
  payoutWindowEndingOn,
  describePayoutWindow,
  sastDateString,
  type PayoutWindow,
} from './payoutWindow';

// ─── Payout schedule, for surfaces that have to TALK about it ───────────
//
// ./payoutWindow.ts owns the boundary rule. This module owns the three
// derived facts a UI needs and payoutWindow deliberately does not provide,
// and it exists so that no component ever does date arithmetic of its own:
//
//   1. The window currently OPEN (still accumulating), as opposed to the
//      most recently closed one the runner settles.
//   2. The DATE a given window is paid on — the Friday after it closes.
//   3. The two calendar dates a window spans, for "Thu 6 – Wed 12" copy.
//
// It is a read-only consumer: it calls payoutWindow's exported functions and
// changes none of them. Everything here is derived from their output, so the
// boundary rule stays defined in exactly one place. If the Thursday boundary
// ever moves, this module follows automatically.
//
// WHY NOT JUST DO THIS IN THE COMPONENT
// ─────────────────────────────────────
// Because the failure mode is silent. A component that formats a
// SAST-midnight instant with toISOString() or the host timezone reports the
// wrong DAY — Thursday 00:00 SAST is 22:00 UTC on the Wednesday. That exact
// bug shipped once already in the runner's own window_label (fixed by
// routing it through describePayoutWindow), and a practice reading "covers
// Wed 5 – Tue 11" against their bank statement has no way to tell it is a
// display bug rather than a money bug. One module, tested, reused.

/**
 * SAST is UTC+2 year-round with no DST — ./payoutWindow.ts documents why
 * that is a correctness statement and not a convenience. So a calendar day
 * is exactly 24h and stepping one day off a SAST midnight cannot drift onto
 * the wrong date. This is the only raw duration in this file.
 */
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** How far back "paid recently" looks on the dashboard. */
export const PAID_RECENTLY_DAYS = 30;

/**
 * The window still ACCUMULATING at `now` — the one a plan activated today
 * lands in. It opens where the most recently closed window ended and runs a
 * further seven days.
 *
 * Derived rather than computed: the closed window's own length is used to
 * step forward, and the result is round-tripped through
 * payoutWindowEndingOn, which REFUSES a boundary that isn't a Thursday
 * 00:00 SAST. So a mistake here throws instead of quietly producing a
 * window that overlaps its neighbour.
 */
export function openPayoutWindow(now: Date): PayoutWindow {
  const closed = payoutWindowForRun(now);
  const weekMs = closed.windowEnd.getTime() - closed.windowStart.getTime();
  const nextBoundary = sastDateString(new Date(closed.windowEnd.getTime() + weekMs));
  return payoutWindowEndingOn(nextBoundary);
}

/**
 * The SAST calendar date (YYYY-MM-DD) a window's batch is PAID on.
 *
 * The window closes Thursday 00:00 SAST, the runner batches it at 02:00
 * SAST that morning, and the transfer goes out the next day. So the payout
 * date is the day after the exclusive end — never a hardcoded "Friday",
 * because if the boundary moves this follows it.
 */
export function payoutDateFor(window: PayoutWindow): string {
  return sastDateString(new Date(window.windowEnd.getTime() + ONE_DAY_MS));
}

/**
 * The first and last SAST calendar dates a window covers, for copy like
 * "covers plans activated Thu 6 – Wed 12 Aug".
 *
 * Both come straight out of describePayoutWindow, which already resolves the
 * INCLUSIVE last day (the Wednesday) rather than the exclusive Thursday
 * boundary — so this does no date arithmetic at all, and the dates a
 * practice reads are byte-identical to the ones the runner records.
 */
export function windowDates(window: PayoutWindow): { firstDate: string; lastDate: string } {
  const [firstDate, lastDate] = describePayoutWindow(window).split(' to ');
  return { firstDate, lastDate };
}

/**
 * The cutoff instant for the "paid out recently" figure: PAID_RECENTLY_DAYS
 * before `now`. Deliberately an instant and not a SAST calendar date —
 * payout_batches.paid_at is a TIMESTAMPTZ set at the moment an admin
 * confirms the transfer, so comparing it to a midnight would include or
 * exclude a whole day depending on the hour the run happened.
 */
export function paidRecentlySince(now: Date): Date {
  return new Date(now.getTime() - PAID_RECENTLY_DAYS * ONE_DAY_MS);
}
