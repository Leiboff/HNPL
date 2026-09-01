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
//
// ─── THE TOKEN KIND, added 2026-09-02 (audit A-03) ────────────────────────
//
// Everything above reasons about the ACCOUNT and says nothing about WHO IS
// HOLDING THE TOKEN, and that turned out to be the whole question.
//
// An `invitation` token is emailed to the patient's own address, and the
// email the caller supplies is not their choice — initiateCheckout takes it
// from the invitation row. So reusing that account and minting a session for
// it is equivalent to a magic link sent to that address: the same trust model
// the rest of the app already runs on.
//
// A `session` token is the POS/QR one. It is rendered as a QR on the
// PRACTICE's own screen (app/practice/bills/new/BillQrPanel.tsx), and on that
// path `normalizedEmail` comes from the request body — the caller's choice.
// So "reuse the account at this email" means "the practice names an account
// and gets a session for it". Combined with resolveBillIdentity case C, which
// binds plans.patient_id to the owner of the SA ID the practice typed, that
// was a complete customer account takeover by a merchant.
//
// Hence: an account that already exists is never reused on the session path.
// The holder is asked to sign in, which is the one thing a practice cannot do
// on the patient's behalf.

export type ExistingAuthUser = {
  id:                 string;
  email_confirmed_at: string | null;
};

/** Which door the caller came through. See the header. */
export type CheckoutTokenKind = 'invitation' | 'session';

export type DiscriminationResult =
  | { action: 'create-new' }
  | { action: 'reuse';         userId: string }
  /**
   * The caller must authenticate. Replaces the old
   * 'reject-organic-collision', and now also covers every pre-existing
   * account reached through a POS/QR token (audit A-03). One action, so the
   * caller surfaces ONE message — the three distinct refusals it used to
   * emit were an oracle for whether a given address held an account and
   * whether it was the one on the bill.
   */
  | { action: 'require-login'; existingUserId: string };

export function discriminateExistingUser(
  existing:      ExistingAuthUser | null,
  planPatientId: string | null,
  tokenKind:     CheckoutTokenKind,
): DiscriminationResult {
  // No auth row exists for this email — fresh creation.
  if (!existing) return { action: 'create-new' };

  // ── The A-03 gate ──────────────────────────────────────────────────
  // On the POS/QR path the token is on the practice's screen and the email
  // is in the request body. An account that already exists is therefore
  // never handed to the token holder, whoever the plan is bound to.
  if (tokenKind === 'session') {
    return { action: 'require-login', existingUserId: existing.id };
  }

  // Plan already bound to this exact auth row → it's the same patient
  // returning to this same checkout, through a link emailed to that very
  // address. Decline-retry AND abandon-resume both land here.
  if (planPatientId !== null && planPatientId === existing.id) {
    return { action: 'reuse', userId: existing.id };
  }

  // Confirmed auth row but plan ISN'T bound to them — the email collides
  // with an organic BetterNow account that has nothing to do with this
  // invitation.
  if (existing.email_confirmed_at) {
    return { action: 'require-login', existingUserId: existing.id };
  }

  // Unconfirmed orphan (rare — e.g. an AUTH_ONLY orphan from a prior
  // failed flow). The plan isn't bound to them yet but nothing in
  // BetterNow recognises this email as a "real" account. Reuse the
  // dormant row; initiateCheckout will bind the plan to it next.
  return { action: 'reuse', userId: existing.id };
}
