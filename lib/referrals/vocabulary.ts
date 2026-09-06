// ─── The referral vocabulary, and what each state actually means ──────────
//
// Mirrors the CHECK constraints on `referrals` in migration 0145. Two lists
// is a drift risk and it is accepted for the same reason 0134 accepts it for
// rate-limit buckets: the point is that the database refuses a value the
// application did not declare, which it cannot do by reading the application.
// lib/referrals/vocabulary.test.ts pins the two against each other.
//
// ─── WHAT IS DELIBERATELY ABSENT ─────────────────────────────────────────
//
// There is no reward state here — no 'earned', no 'paid', no amount. The
// incentive programme is NOT built (see docs/REFERRALS.md). What this file
// declares is the *chain of custody* of a referral, which is the part an
// incentive would later read; inventing reward states before there is a
// policy to pay them would be inventing the policy.
//
// The seam is `qualified_at`. Nothing in this repo sets it. It is the column
// a future programme stamps when a referral meets whatever bar that
// programme defines, and it exists now so the bar can be applied to
// referrals that already happened rather than only to ones made afterwards.

/** Who is being referred. The two halves of the ask. */
export const REFERRAL_KINDS = ['patient', 'practice'] as const;
export type ReferralKind = (typeof REFERRAL_KINDS)[number];

/**
 * How the referral was made.
 *
 *   link    the referrer shared their code or link themselves — WhatsApp, a
 *           conversation, a screenshot. We never see the hop; the row is
 *           created when somebody ARRIVES carrying the code, so it has no
 *           invitee details and never will.
 *   invite  the referrer typed the invitee's details into the app. For a
 *           friend that sends an email; for a practice it creates a CRM lead.
 *           Either way the row exists before anybody acts on it.
 *
 * The distinction is not cosmetic: an 'invite' referral has an invitee we can
 * identify before signup, so an arriving account can be matched onto the row
 * that was created for them. A 'link' one cannot, and is only ever attributed
 * by the code the arrival carries.
 */
export const REFERRAL_CHANNELS = ['link', 'invite'] as const;
export type ReferralChannel = (typeof REFERRAL_CHANNELS)[number];

/**
 * The lifecycle.
 *
 *   pending    an invitation exists; nobody has acted on it.
 *   signed_up  an account was created and ATTRIBUTED to this referral. For a
 *              practice referral, the equivalent moment is a CRM lead
 *              existing — which is true from creation, so practice referrals
 *              start at 'signed_up' only when the practice itself registers.
 *   converted  the referred party did the thing that makes them a customer:
 *              a patient's first plan went active, or a referred practice was
 *              approved to trade. This is the state an incentive programme
 *              would care about, and the reason it is a state rather than a
 *              derived query is that the fact must be recorded WHEN it
 *              happens — a plan can later be cancelled, and that does not
 *              un-refer anybody.
 *   expired    an invitation that was never taken up, past its window.
 *   void       withdrawn, superseded, or found to be self-dealing. Terminal
 *              and deliberately non-specific: the reason belongs in the
 *              admin audit trail, not in an enum that would grow a branch
 *              per reason.
 */
export const REFERRAL_STATUSES = [
  'pending', 'signed_up', 'converted', 'expired', 'void',
] as const;
export type ReferralStatus = (typeof REFERRAL_STATUSES)[number];

/** States nothing may leave. Mirrored by the guard trigger in 0145. */
export const TERMINAL_REFERRAL_STATUSES = ['converted', 'expired', 'void'] as const;

export function isTerminalReferralStatus(status: string): boolean {
  return (TERMINAL_REFERRAL_STATUSES as readonly string[]).includes(status);
}

/**
 * How long an emailed invitation stays live.
 *
 * Thirty days, matching nothing else in the repo on purpose — the patient
 * invitation window (a bill waiting to be paid) is days, because money is
 * waiting; a referral is an offer with nothing hanging on it, and a friend
 * who signs up three weeks later is exactly the outcome we want. Past that
 * the row stops being an invitation and starts being retained personal
 * information about somebody who never became a customer, which is the
 * reason there is a limit at all — see the retention note in 0145.
 */
export const REFERRAL_INVITE_TTL_DAYS = 30;

/**
 * What to SHOW for a row, given the clock.
 *
 * A pending invitation past its window reads as expired to a person the
 * moment it lapses, but the row does not change until the maintenance job
 * runs (app/api/cron/referral-maintenance). Deriving the display here means
 * the screen never shows "pending" for something that is plainly not, and
 * means the job is a housekeeping detail rather than a correctness
 * dependency of the UI.
 *
 * Only ever widens 'pending' → 'expired'. Every other status is reported as
 * stored: a converted referral does not stop being converted because a date
 * passed.
 */
export function displayReferralStatus(
  row: { status: string; expires_at?: string | null },
  now: Date = new Date(),
): ReferralStatus | string {
  if (row.status !== 'pending') return row.status;
  if (!row.expires_at) return row.status;
  const expiry = new Date(row.expires_at);
  if (Number.isNaN(expiry.getTime())) return row.status;
  return expiry.getTime() <= now.getTime() ? 'expired' : 'pending';
}

/** Customer-facing label for a status. One definition, so two screens cannot
 *  disagree about what 'signed_up' is called. */
export const REFERRAL_STATUS_LABEL: Record<ReferralStatus, string> = {
  pending:   'Invited',
  signed_up: 'Joined',
  converted: 'Active',
  expired:   'Expired',
  void:      'Closed',
};
