// ─── Payout vocabulary, in ONE place ──────────────────────────────────────
//
// Two surfaces now talk about the same money at the same three certainties:
// the dashboard hero (./NextPayoutHero) and the payouts tab
// (./payouts/PayoutBatchList). They must not develop two vocabularies for it.
// A practice that reads "Building this week — Estimate" on one screen and
// "Provisional total" on the other has to work out whether those are the same
// state; when the answer is money, they will assume they are not.
//
// So the words live here and both import them. This module is pure strings and
// pure string interpolation: NO Date, NO formatting, NO arithmetic. Every date
// arrives already formatted by @/app/patient/_format and every amount by
// ./billHelpers formatRand — see NextPayoutHero's header for why any component
// that formats a SAST instant itself silently reports the wrong DAY.
//
// ── THE THREE STATES, AND THE ONE THAT MATTERS MOST ──────────────────────
//
//   open      the week is still accumulating. An ESTIMATE: the number is a
//             real sum of real rows, but the SET is not final.
//   awaiting  the batch is CLOSED — total_net and plan_count are final and
//             will not move — but the EFT has not been run. Settlement is
//             still a human action (0090: "Does not move money — settlement
//             stays a platform-admin action"), so a batch can sit here for
//             days.
//   paid      an admin has confirmed the transfer left our side (paid_at set).
//
// `awaiting` is the state this vocabulary exists to protect. It is the one a
// practice will misread if the copy is loose, and misreading it means
// believing money is in their account when it is not — so nothing in the
// awaiting strings may say paid, transferred, deposited, received, settled,
// landed, or in your account, and none of them names a date without a verb
// that places it in the future or leaves it open. The tab's tests assert on
// these strings directly, and on the absence of that whole vocabulary.
//
// The same reason drives the DATE CAPTIONS below: a bare date next to an
// amount reads as "paid on". Every date this feature renders carries a caption
// or a verb that says which of the three things it is.

/** Discriminates the three certainties. Also the chip/caption lookup key. */
export type PayoutStateKind = 'open' | 'awaiting' | 'paid';

// ── Shared with the hero ─────────────────────────────────────────────────

/** The badge on anything not yet final. The hero rendered it first. */
export const PAYOUT_ESTIMATE_BADGE = 'Estimate';

/** The hero's label for the still-open week. Reused verbatim, not paraphrased. */
export const PAYOUT_BUILDING_LABEL = 'Building this week';

/** Prefix for the window sentence, on every surface that states one. */
export const PAYOUT_WINDOW_PREFIX = 'Covers plans activated';

/**
 * Why an open week is not a promise. `lastDayLabel` is a pre-formatted day +
 * month ("19 Aug"), or a fallback phrase when the date is unknown.
 */
export function payoutEstimateNote(lastDayLabel: string): string {
  return `This week is still open, so it isn’t final — any plan a patient ` +
         `accepts before ${lastDayLabel} is added to it.`;
}

/** Used when a caller has no last-day date to name. */
export const PAYOUT_WEEK_CLOSES_FALLBACK = 'the week closes';

// ── Status chips ─────────────────────────────────────────────────────────
//
// Colour is never the only signal — each chip carries a distinct WORD, and
// the tab additionally renders the settlement sentence below every row. A
// reader who cannot separate amber from green still gets "Awaiting transfer"
// versus "Paid".

export const PAYOUT_STATUS_CHIP: Record<PayoutStateKind, { label: string; cls: string }> = {
  // Not "Pending": pending is what the DB column says, and to a practice it
  // reads as "something is happening" when the truth is that nothing has yet.
  // Not "Processing" either — 0090 is explicit that there is no bank
  // integration to report a processing state from, so claiming one invents a
  // rail that does not exist.
  awaiting: { label: 'Awaiting transfer', cls: 'bg-amber-100 text-amber-800' },
  paid:     { label: 'Paid',              cls: 'bg-green-100 text-green-700' },
  open:     { label: PAYOUT_ESTIMATE_BADGE, cls: 'bg-amber-100 text-amber-800' },
};

// ── Date captions ────────────────────────────────────────────────────────
//
// What the date beside the amount IS. Never omitted: an uncaptioned date on a
// money row is read as the day it was paid.

export const PAYOUT_DATE_CAPTION: Record<PayoutStateKind, string> = {
  awaiting: 'Due',
  paid:     'Transferred',
  open:     'Expected',
};

// ── Settlement sentences ─────────────────────────────────────────────────

/**
 * The one-line truth about where this batch's money actually is.
 *
 * `dateLabel` is pre-formatted (weekday + day + month) or null when there is
 * no honest date to give.
 *
 * The awaiting case splits on whether its due date has already passed,
 * because "due to be transferred on Friday 7 Aug" read on the 13th is worse
 * than saying nothing about timing: it names a date in the past for something
 * that has not happened, which reads as a claim that it did.
 */
export function payoutSettlementNote(
  kind:      PayoutStateKind,
  dateLabel: string | null,
  overdue:   boolean,
): string {
  if (kind === 'paid') {
    return dateLabel
      // "Left our side", not "arrived": paid_at is when an admin confirmed the
      // EFT went out, and an EFT is not instant. Promising arrival would be the
      // same overclaim one step later.
      ? `Transferred to your bank on ${dateLabel}.`
      : 'Transferred to your bank.';
  }
  if (kind === 'awaiting') {
    if (overdue || !dateLabel) {
      return 'This amount is final. The transfer hasn’t gone out yet — we’re on it.';
    }
    return `This amount is final. It’s due to be transferred on ${dateLabel}.`;
  }
  // 'open' — the caller renders payoutEstimateNote instead, which says why the
  // figure can still move. Returning the same sentence here would put two
  // instances of it on one row.
  return '';
}

/**
 * Plural-safe "N plans". Trivial, but it is on both surfaces and both had
 * their own copy of the ternary.
 */
export function payoutPlanCountLabel(count: number): string {
  return `${count} plan${count === 1 ? '' : 's'}`;
}
