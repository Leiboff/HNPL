import {
  PAYOUT_STATUS_CHIP,
  PAYOUT_DATE_CAPTION,
  type PayoutStateKind,
} from '@/app/practice/payoutCopy';

// ─── Brand payout vocabulary — the group layer, and nothing else ────────────
//
// The three certainties an unpaid batch can be in — open / awaiting / paid —
// are already named, coloured and captioned in ../practice/payoutCopy.ts, and
// this module does NOT restate them. It re-exports the bridge and adds only the
// strings that are genuinely new at brand level, which is a shorter list than it
// looks: one idea, said plainly.
//
// ── THE ONE IDEA ─────────────────────────────────────────────────────────────
//
// A brand with three practices does not get one transfer. It gets THREE — each
// into that practice's own account, each reconcilable against that practice's
// own plans. So a group total is a SUM OF N DEPOSITS, and presenting it as a
// single figure without saying so produces a number that cannot be found
// anywhere on any bank statement. A brand admin who trusts it goes looking for
// R41,180.00 and finds R12,400.00, R14,600.00 and R14,180.00, and has no way to
// tell whether that is three deposits or a shortfall.
//
// Hence: the deposit count is never optional, never a footnote, and never
// implied by the fact that practices are listed below. It sits in the same
// breath as the total.
//
// This is not a new idea in the product either — the practice hero already says
// "each arrives as its own deposit" about a practice's own unsettled earlier
// batches (NextPayoutHero's Footnotes). Brand level is that same sentence one
// scope up, so it borrows the wording rather than coining a second one.
//
// ── THE HONESTY CONSTRAINT IS UNCHANGED, AND HARDER HERE ────────────────────
//
// Settlement is still a manual EFT an admin runs, so a closed batch sits
// AWAITING TRANSFER, sometimes for days. At brand level a group total can hold
// several practices at once, in different states — one closed and unpaid, one
// still accumulating. So the group figure can be part-final and part-estimate,
// and it must say which. Nothing in this module may claim, for any state other
// than paid, that money has arrived: no paid, transferred, deposited, received,
// settled, landed, cleared, or in your account. The word "deposits" appears
// throughout as a NOUN naming the shape of a future transfer, never as a report
// that one happened, and the tests assert exactly that distinction.

/**
 * nextPayout's discriminant → the shared chip/caption key.
 *
 * `committed` means a payout_batches row is CLOSED — total_net and plan_count
 * are final — and the EFT has not been run. In ../practice/payoutCopy's
 * vocabulary that is `awaiting`, not `paid`. Getting this mapping wrong is the
 * single way this feature could tell a brand their money has landed when it has
 * not, which is why it is one exported function with one test rather than a
 * ternary at each call site.
 */
export function brandPayoutStateKind(kind: 'committed' | 'projected'): PayoutStateKind {
  return kind === 'committed' ? 'awaiting' : 'open';
}

/** Re-exported so brand components import ONE copy module, not two. */
export { PAYOUT_STATUS_CHIP, PAYOUT_DATE_CAPTION };

/** The hero's label. "Next payouts", plural, before a number is even read. */
export const BRAND_PAYOUT_LABEL = 'Next payouts';

/**
 * The deposit count, beside the total.
 *
 * Both halves are stated even though they are the same number, because they are
 * two different facts that happen to coincide: how many practices contribute,
 * and how many transfers result. A brand admin needs the second one to
 * reconcile, and inferring it from the first is exactly the inference this
 * whole module exists to remove.
 */
export function brandDepositSummary(depositCount: number): string {
  const practices = `${depositCount} ${depositCount === 1 ? 'practice' : 'practices'}`;
  const deposits  = `${depositCount} separate ${depositCount === 1 ? 'deposit' : 'deposits'}`;
  return `Across ${practices} · ${deposits}`;
}

/**
 * Why the total is not a transfer. `totalLabel` is pre-formatted by
 * ../practice/billHelpers formatRand — no money formatting happens here.
 *
 * Note the deliberate absence of the verb "paid": every tense of it reads as a
 * claim about something that has already happened, and at n practices at least
 * one of these deposits usually has not. "Has its own bank account" states the
 * mechanism without asserting anything about this money.
 */
export function brandSeparateDepositsNote(depositCount: number, totalLabel: string): string {
  if (depositCount === 1) {
    return 'One practice has a payout due, so this is a single deposit into that ' +
           'practice’s own account.';
  }
  return `Each practice has its own bank account, so this total arrives as ` +
         `${depositCount} separate deposits — never one transfer of ${totalLabel}. ` +
         `Reconcile each practice below against its own deposit.`;
}

/**
 * Shown when the group total mixes closed batches with still-open weeks. The
 * total is then part-final and part-estimate, and a single chip cannot say so.
 */
export const BRAND_PAYOUT_MIXED_NOTE =
  'Part of this total is still an estimate — some weeks haven’t closed yet. ' +
  'Each practice below says which.';

/**
 * Shown when the contributing practices do not share one payout date, which
 * happens the moment one practice has an earlier batch still unsettled. The
 * hero then names no date at all: naming the earliest would read as the date
 * the whole total arrives.
 */
export const BRAND_PAYOUT_MULTI_DATE_NOTE =
  'These don’t all arrive on the same day — each practice below carries its own date.';

// ── Empty state ─────────────────────────────────────────────────────────────
//
// Same rule as the practice hero: NOT "R0.00". Zero reads as a measured figure
// — "we checked, you are owed nothing" — when the truth is that nothing has been
// scheduled yet.

export const BRAND_PAYOUT_EMPTY_TITLE = 'Nothing scheduled yet';
export const BRAND_PAYOUT_EMPTY_NOTE =
  'Once a patient accepts a plan at one of your practices, that practice’s ' +
  'payout appears here with the date it arrives.';

/** The per-practice row's label for a practice with no payout, in a list where
 *  others have one. Says nothing about what the practice is owed. */
export const BRAND_PRACTICE_NO_PAYOUT = 'None scheduled';

// ── Earlier unsettled batches ───────────────────────────────────────────────

/**
 * Closed batches BEYOND the one counted in the total, still awaiting transfer.
 * Reported as extra deposits rather than folded into the figure, because that
 * is what they are — the same choice the practice hero makes, and the reason its
 * wording is echoed here.
 */
export function brandOtherPendingNote(count: number, netLabel: string): string {
  return `${count} earlier payout${count === 1 ? '' : 's'} totalling ${netLabel} ` +
         `${count === 1 ? 'is' : 'are'} also still to be transferred, on top of the ` +
         `total above — each arrives as its own deposit.`;
}
