import type { ClaimOutcome } from '@/lib/checkout/claimSessionPlan';

// ─── "We can't match this bill to you" — the honest version ────────────────
//
// This surface replaces a redirect to the patient dashboard carrying a
// `reason` query parameter. That redirect was the bug, in two layers:
//
//   1. NOTHING RENDERED THE REASON. /patient reads only `welcome` from its
//      searchParams, so the parameter was dropped on the floor. The patient
//      was silently deposited on their dashboard with no explanation at all.
//      A bad message is a wording problem; no message is a dead end.
//
//   2. IT MOVED THEM OFF THE SCREEN THEY WERE LOOKING AT. This is a person
//      standing at a counter with a receptionist beside them, mid-payment.
//      Whatever we say is worth far more said HERE, where the two of them
//      can act on it together, than on a dashboard one navigation away.
//
// The buckets below exist because a single catch-all is a new dead end for
// the largest group. Telling someone whose ACCOUNT has no ID on it to
// "check the ID number on the bill" sends reception to look at a bill that
// is perfectly correct; they find nothing, and everyone is stuck. Splitting
// costs one branch.
//
// What none of these do is offer a fix we know fails. In particular the
// no_account_id bucket does NOT route to /onboarding/identity to add an ID:
// since 0097 that step refuses an ID another account already holds, which is
// precisely the situation these patients are in. Honest about the limit
// beats falsely helpful. When a support-side release path exists, that
// bucket's copy should point at it.
//
// AMENDMENT — every bill now carries an SA ID
//   When the dashboard gained a required ID field and QR/email became a
//   delivery toggle, 'different_account' stopped describing one situation
//   and started describing two. Its original justification was that an
//   emailed bill is keyed on the address with no ID involved — which is now
//   simply false. Rather than reword a premise that had expired, the bucket
//   was re-derived: an invitation whose plan is BOUND keeps it, and one
//   bound to nobody gets 'unclaimed_invitation', whose next step differs
//   because the account the old copy pointed at does not exist. Copy that
//   asserts something untrue is the failure mode this whole surface was
//   built to fix; leaving it in place because the heading still reads well
//   would have been the third instance.
//
// WHY THIS LIVES BESIDE THE PAGE RATHER THAN IN IT
//   So that every bucket's reachability is provable by calling
//   billMatchFailureFor with real arguments, instead of inferred by reading
//   the page's source text. An unreachable-but-permitted state is the exact
//   trap fixed twice already (the 'declined' stage, the CHECK constraint),
//   and a bucket nothing can produce is the same shape of bug.

export type BillMatchFailure =
  /** The till captured an ID; the account's ID is a different one, or the plan went to someone else first. */
  | 'id_mismatch'
  /** The signed-in account carries no SA ID at all — nothing to match against. */
  | 'no_account_id'
  /** Our fault: unreadable ciphertext or a failed write. Never the patient's problem. */
  | 'our_fault'
  /** An EMAILED bill ALREADY BOUND to another account, opened while signed in as somebody else. */
  | 'different_account'
  /**
   * An EMAILED bill bound to NOBODY, opened while signed in as somebody
   * else. Re-derived when every bill gained an SA ID: 'different_account'
   * used to cover this too, and its advice — "sign in with the account the
   * bill was emailed to" — is impossible here, because reaching this state
   * means neither the ID nor the address had an account at issuance. There
   * is no other account to sign into.
   */
  | 'unclaimed_invitation';

export type BillMatchCopy = { heading: string; body: string; next: string };

export const BILL_MATCH_COPY: Record<BillMatchFailure, BillMatchCopy> = {
  id_mismatch: {
    heading: "We couldn't match this bill to your account",
    body:    'The ID number on this bill doesn’t match the one on your BetterNow account.',
    next:    'Ask reception to check the ID number on the bill.',
  },
  no_account_id: {
    // Deliberately says what reception can and cannot do. Since the
    // duplicate cleanup, this is the biggest bucket by some distance.
    heading: "We couldn't match this bill to your account",
    body:    'Your BetterNow account doesn’t have an ID number on it yet, so there’s nothing for us to match this bill against.',
    next:    'Ask reception to check the ID on the bill — and if it’s right, contact support, because this one can’t be fixed from your side.',
  },
  our_fault: {
    heading: 'Something went wrong on our side',
    body:    'We couldn’t check this bill against your account just now. This isn’t a problem with the bill or with your account.',
    next:    'Please try again. If it keeps happening, contact support.',
  },
  different_account: {
    // What makes this bucket distinct is not the absence of an ID — it is
    // that the bill is ALREADY BOUND to a real account, so signing into
    // that account is a next step that actually exists.
    heading: 'This bill was sent to a different account',
    body:    'You’re signed in to a BetterNow account this bill wasn’t sent to.',
    next:    'If you have more than one account, sign in with the one the bill was emailed to.',
  },
  unclaimed_invitation: {
    // Reaching here means the practice's ID lookup found no account and
    // neither did the email — so telling this person to "sign in with the
    // other account" would send them after something that does not exist.
    // The only real fix is at the counter.
    heading: 'This bill isn’t linked to your account',
    body:    'This bill was emailed to a different address and hasn’t been linked to any BetterNow account yet.',
    next:    'If it’s meant for you, ask reception to re-issue it to the email address or ID number on your account.',
  },
};

/**
 * Map a refusal to the thing the person in front of us needs to hear.
 *
 * `claimReason` is null when the claim never ran — the plan already had an
 * owner, or this is an invitation token, both of which reach this surface
 * without claimUnboundSessionPlan being consulted at all. Keying copy off
 * the claim outcome alone would leave those two uncovered.
 */
export function billMatchFailureFor(
  claimReason: ClaimOutcome['reason'] | null,
  tokenKind:   'invitation' | 'session',
  planIsBound: boolean,
): BillMatchFailure {
  // An invitation splits on whether the bill reached anyone. Bound means a
  // real account owns it and can be signed into; unbound means the ID and
  // the address both belonged to nobody at issuance, so there is no second
  // account to send this person after.
  if (tokenKind === 'invitation') {
    return planIsBound ? 'different_account' : 'unclaimed_invitation';
  }

  switch (claimReason) {
    case 'no_profile_id':                 return 'no_account_id';
    case 'decrypt_failed':
    case 'write_failed':                  return 'our_fault';
    // 'already_bound' folds in here: to the person standing at the counter a
    // lost race and a mismatched ID are the same event, and the same next
    // step — reception checks the bill — applies to both.
    case 'id_mismatch':
    case 'already_bound':
    default:                              return 'id_mismatch';
  }
}
