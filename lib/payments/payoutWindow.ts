// ─── The weekly payout window ───────────────────────────────────────────
//
// One rule, stated once, so every surface that shows a payout figure agrees
// with the runner that produced it:
//
//   A payout batch covers plans ACTIVATED from Thursday 00:00:00 SAST
//   through Wednesday 23:59:59 SAST. The runner CLOSES it early the next
//   Thursday morning; the practice is PAID on the Friday.
//
// Closing and paying are two different days on purpose. Closing needs nothing
// but the passed cut-off, so it is automated as early as it can safely run
// (Thursday 02:00 SAST — see app/api/cron/payout-batches/route.ts). Paying is
// still a human running an EFT, and they now get a full extra day with the
// final figure in hand. Nothing in this file depends on which of the two it
// is being asked about: the WINDOW is the same interval either way.
//
// This is the reconcilability guarantee. A practice can only check a deposit
// against their bank statement if the set of plans inside it is bounded by
// two exact instants — so the boundary is defined here, in one pure
// function, rather than inline in the runner where a later edit could drift
// it away from the copy shown in the UI.
//
// ── Half-open interval ──────────────────────────────────────────────────
// The window is [windowStart, windowEnd): start inclusive, end EXCLUSIVE.
// windowEnd is Thursday 00:00:00 SAST — the instant the NEXT window opens.
//
// "Through Wednesday 23:59:59" is the human phrasing; a half-open interval
// is how you implement it without ever asking whether the last representable
// instant of Wednesday is .999, .999999, or something a future column type
// change makes different. An activation at Wednesday 23:59:59.999999 SAST is
// in; Thursday 00:00:00.000000 SAST is out. No arithmetic on "one
// millisecond before midnight" anywhere.
//
// ── Why end-of-day Wednesday and not 11:00 ──────────────────────────────
// The instalment-collection cron runs at 11:00 UTC = 13:00 SAST daily
// (vercel.json + app/api/cron/collect-instalments). A cut-off aligned to it
// would strand every Wednesday-afternoon activation into the following
// week's batch — an eight-day wait that a practice would reasonably read as
// a missing payout. End of day Wednesday is deliberate.
//
// Consequence worth stating in the UI, not hiding: a plan activated
// Wednesday pays out in two days; one activated Thursday waits eight. That
// is a normal settlement buffer, but owners will notice.
//
// ── Timezone ────────────────────────────────────────────────────────────
// SAST is UTC+2 year-round. South Africa has not observed DST since 1944 and
// has no scheduled plans to, so a fixed offset is correct rather than merely
// convenient — but the boundary is still constructed from an EXPLICIT
// '+02:00' offset string and never from the host's local time. A runner
// executing on a Vercel box in UTC and a developer's machine in SAST must
// compute the identical instant; anything that reads the ambient timezone
// would not. That is the whole reason this file does string-based
// construction instead of Date#setHours.

/** SAST = UTC+2, no DST, ever. */
export const SAST_OFFSET = '+02:00';

/** JS getUTCDay(): 0=Sun … 4=Thu. The window boundary always lands here. */
const THURSDAY = 4;

const MS_PER_DAY      = 24 * 60 * 60 * 1000;
const SAST_OFFSET_MS  = 2 * 60 * 60 * 1000;

export type PayoutWindow = {
  /** Thursday 00:00:00 SAST, INCLUSIVE. */
  windowStart: Date;
  /** The following Thursday 00:00:00 SAST, EXCLUSIVE. */
  windowEnd:   Date;
};

/**
 * The SAST calendar date an instant falls on, as 'YYYY-MM-DD'.
 *
 * Shifts the instant by the SAST offset and then reads UTC parts — so the
 * answer depends only on the offset constant, never on the host timezone.
 */
export function sastDateString(instant: Date): string {
  const shifted = new Date(instant.getTime() + SAST_OFFSET_MS);
  return shifted.toISOString().slice(0, 10);
}

/** SAST weekday of an instant (0=Sun … 4=Thu), offset-derived, never local. */
function sastWeekday(instant: Date): number {
  return new Date(instant.getTime() + SAST_OFFSET_MS).getUTCDay();
}

/**
 * Midnight SAST on a given SAST calendar date, as a UTC instant.
 *
 * Built by parsing an explicit-offset ISO string: '2026-08-13T00:00:00+02:00'
 * is unambiguous in every environment. (Note that `new Date('2026-08-13')`
 * would be parsed as UTC midnight and `new Date(2026, 7, 13)` as LOCAL
 * midnight — both wrong here, which is why neither is used.)
 */
export function sastMidnight(dateStr: string): Date {
  const d = new Date(`${dateStr}T00:00:00${SAST_OFFSET}`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`sastMidnight: not a valid YYYY-MM-DD date: ${dateStr}`);
  }
  return d;
}

/**
 * The window a run at `runAt` should settle: the most recently CLOSED
 * Thursday→Thursday interval.
 *
 * windowEnd is the most recent Thursday 00:00:00 SAST at or before `runAt`;
 * windowStart is seven days earlier.
 *
 * For the scheduled Thursday 02:00 SAST run that yields:
 *     window  = Thu 00:00 → Wed 23:59:59  (SAST)
 *     closed  = two hours after that Wednesday ends
 *     paid    = the Friday after that Wednesday
 * so a Wednesday activation is paid in two days and a Thursday one waits
 * eight. Any manual re-run from that Thursday through the following Wednesday
 * resolves to the SAME window, which is what makes re-running safe and
 * boring — the scheduled run, an operator re-run on the Friday, and a
 * curious click on the Sunday all settle the identical week.
 *
 * "At or before", not "strictly before": at exactly Thursday 00:00 SAST the
 * interval [previous Thursday, now) has just closed and contains no future
 * instant, so it is the correct thing to settle. Requiring strictly-before
 * there would skip that week entirely and strand it — the first version of
 * this function had that bug.
 *
 * No future-window guard is needed, and none is present: `candidate` starts
 * at midnight of the run's own SAST date (therefore <= runAt) and only ever
 * walks backwards, so it can never land in the future.
 */
export function payoutWindowForRun(runAt: Date): PayoutWindow {
  // Midnight SAST on the run's own SAST date, then back to the most recent
  // Thursday. Weekday is read via the offset so a UTC host and a SAST host
  // agree (they disagree between 22:00 and 00:00 UTC).
  const candidateSameDay = sastMidnight(sastDateString(runAt));
  const backToThursday   = (sastWeekday(candidateSameDay) - THURSDAY + 7) % 7;
  const windowEnd        = new Date(candidateSameDay.getTime() - backToThursday * MS_PER_DAY);

  return {
    windowStart: new Date(windowEnd.getTime() - 7 * MS_PER_DAY),
    windowEnd,
  };
}

/**
 * An explicit window for a backfill run, from the SAST calendar date of its
 * EXCLUSIVE Thursday end (e.g. '2026-08-13').
 *
 * Exists because the normal window is strict: if a weekly run is missed,
 * that week's payouts are not silently swept into the next batch, because a
 * batch whose label says "Thu 6 – Wed 12" must contain exactly that. The
 * operator backfills the missed week instead, and the runner reports any
 * stranded rows so a miss is visible rather than discovered by a practice.
 *
 * Rejects a date that isn't a Thursday — an off-by-one here would produce a
 * batch that overlaps its neighbours, which is worse than a failed run.
 */
export function payoutWindowEndingOn(thursdaySastDate: string): PayoutWindow {
  const windowEnd = sastMidnight(thursdaySastDate);
  if (sastWeekday(windowEnd) !== THURSDAY) {
    throw new Error(
      `payoutWindowEndingOn: ${thursdaySastDate} is not a Thursday in SAST — ` +
      'window boundaries must land on Thursday 00:00 SAST or batches would overlap.',
    );
  }
  return {
    windowStart: new Date(windowEnd.getTime() - 7 * MS_PER_DAY),
    windowEnd,
  };
}

/**
 * Human label for the window, for UI that must state what a payout covers.
 * Inclusive end date (the Wednesday), because "through Wednesday" is what a
 * practice reconciles against — never show them the exclusive Thursday.
 */
export function describePayoutWindow(w: PayoutWindow): string {
  const lastDay = sastDateString(new Date(w.windowEnd.getTime() - MS_PER_DAY));
  return `${sastDateString(w.windowStart)} to ${lastDay}`;
}
