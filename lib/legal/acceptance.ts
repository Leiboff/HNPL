// ─── Has this account accepted the terms? ──────────────────────────────
//
// ONE predicate, because the answer is asked in four places that must
// never disagree: /auth/callback (deciding whether an OAuth arrival gets
// to keep its session), /auth/require-terms (the refusal route), the
// /onboarding step gate, and the patient layout. When the rule lived
// inline at the callback only, the other three did not ask at all — which
// is the defect this file was extracted for.
//
// Pure on purpose: no I/O, no imports. The caller has already read the
// row it needs, so this cannot fail in an ambiguous way, and it is
// testable with plain fixtures.

export type TermsAcceptanceRow = {
  /** profiles.terms_accepted_at — the audit fact. Write-once. */
  terms_accepted_at:    string | null;
  /** profiles.onboarding_completed — server-written only. See below. */
  onboarding_completed: boolean | null;
};

/**
 * True when this account may proceed into the app.
 *
 * Either it has an acceptance on record, or it is GRANDFATHERED: an
 * account that finished onboarding before acceptance was recorded at all.
 *
 * The grandfather clause is not a hole. It is deliberate, and it is
 * narrow for two reasons:
 *
 *   • onboarding_completed is written only by the server, never by
 *     anything a visitor controls, so it cannot be asserted into being.
 *   • Locking existing customers out of an app they already use, over a
 *     record we never asked them for, is a worse wrong than the gap it
 *     closes.
 *
 * A null row (no profile at all) is NOT accepted — "we don't know" has to
 * mean "no" on a gate.
 */
export function hasAcceptedTerms(profile: TermsAcceptanceRow | null | undefined): boolean {
  if (!profile) return false;
  if (profile.terms_accepted_at) return true;
  return profile.onboarding_completed === true;
}
