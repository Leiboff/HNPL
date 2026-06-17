// ─── Checkout user-discrimination ──────────────────────────────────────────
//
// Pure helper, kept in isolation so the rule can be locked down by
// tests instead of by reading the call site. It answers the question
// at the top of initiateCheckout:
//
//   "There's an auth row at this email, AND a plan bound to some
//    patient_id. Should this `initiateCheckout` call reuse that auth
//    row, reject because the email collides with an organic account,
//    or create a fresh account?"
//
// The discriminator's input is the existing auth row (from
// findExistingAuthUser) plus the plan's patient_id at the moment we
// read it. The output is a single typed action.
//
// Why plan ownership, not just email_confirmed_at:
//
//   The previous "email_confirmed_at ⇒ reject" rule broke decline-
//   retry. Our own first initiateCheckout call creates the user with
//   email_confirm: true (because the emailed-link click IS verification),
//   so every retry saw a confirmed user and rejected — never reusing.
//
//   Plan-ownership cuts straight to the right question: did we bind
//   this plan to this auth row on a prior pass through this same
//   flow? If yes, it's our own returning patient; reuse cleanly.
//   If no AND the user is confirmed, it's an organic-account email
//   collision (or someone signed up for BetterNow organically between
//   bill creation and the link click — the #6 race) and we reject
//   with login guidance.

export type ExistingAuthUser = {
  id:                 string;
  email_confirmed_at: string | null;
};

export type DiscriminationResult =
  | { action: 'create-new' }
  | { action: 'reuse';                        userId: string }
  | { action: 'reject-organic-collision';     existingUserId: string };

export function discriminateExistingUser(
  existing:      ExistingAuthUser | null,
  planPatientId: string | null,
): DiscriminationResult {
  // No auth row exists for this email — fresh creation.
  if (!existing) return { action: 'create-new' };

  // Plan already bound to this exact auth row → it's the same patient
  // returning to this same checkout. Decline-retry AND abandon-resume
  // both land here. Reuse the account, no duplicate.
  if (planPatientId !== null && planPatientId === existing.id) {
    return { action: 'reuse', userId: existing.id };
  }

  // Confirmed auth row but plan ISN'T bound to them — the email collides
  // with an organic BetterNow account that has nothing to do with this
  // invitation. Reject with login guidance; the caller surfaces a CTA.
  if (existing.email_confirmed_at) {
    return { action: 'reject-organic-collision', existingUserId: existing.id };
  }

  // Unconfirmed orphan (rare — e.g. an AUTH_ONLY orphan from a prior
  // failed flow). The plan isn't bound to them yet but nothing in
  // BetterNow recognises this email as a "real" account. Reuse the
  // dormant row; initiateCheckout will bind the plan to it next.
  return { action: 'reuse', userId: existing.id };
}
