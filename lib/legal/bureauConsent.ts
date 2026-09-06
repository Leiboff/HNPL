// ─── Consent to a credit-bureau enquiry ────────────────────────────────
//
// A SEPARATE, STRICTER predicate than lib/legal/acceptance.ts's
// hasAcceptedTerms — deliberately, and the divergence is the whole point of
// this file existing rather than a second call to the shared one.
//
// ─── WHY NOT hasAcceptedTerms ─────────────────────────────────────────
//
// hasAcceptedTerms answers "may this account proceed into the app", and it
// answers YES for a GRANDFATHERED row: an account with a NULL
// terms_accepted_at that finished onboarding before acceptance was recorded
// at all. That clause is correct where it lives. Locking existing customers
// out of an app they already use, over a record we never asked them for, is
// a worse wrong than the gap it closes.
//
// It is NOT correct here. A bureau enquiry is a disclosure of personal
// information to a third party and a permanent entry on a real person's
// credit file. Under POPIA §71 the lawful basis has to be evidenced, and
// "this account finished onboarding" is not evidence of consent to anything.
// A grandfathered row means we have no record — and on this gate, no record
// has to mean no.
//
// So: a non-NULL terms_accepted_at AND a recorded terms_version, both, with
// no fallback. The four surfaces that use hasAcceptedTerms are untouched.
//
// ─── WHY THE VERSION ALLOWLIST ────────────────────────────────────────
//
// The lawful basis is not "the customer accepted some terms". It is a
// specific clause — clause 10 of the T&Cs, which carries the POPIA §71
// disclosure — in a specific version of a specific document.
//
// Without an allowlist, a future TERMS_VERSION would pass this gate
// automatically, including one that reworded or dropped clause 10. That
// failure is silent and points the wrong way: enquiries keep happening, on a
// basis that no longer exists. With the allowlist, a version bump FAILS the
// gate until someone confirms the new document still carries the clause and
// adds it here. Refusing to pull is recoverable; pulling without a basis is
// not.
//
// Pure on purpose — no I/O, no imports. Every caller has already read the
// profile row it needs, so this adds no round trip and cannot fail in a way
// that has to be interpreted.

/**
 * Versions of the customer T&Cs whose clause 10 carries the POPIA §71
 * credit-bureau disclosure.
 *
 * ADDING A VERSION HERE IS A LEGAL ASSERTION, not a version bump. Only add
 * one after confirming the document at that version actually contains the
 * disclosure — lib/legal/documentHash.ts pins the document bytes each
 * version corresponds to, which is what makes that confirmation checkable
 * rather than remembered.
 */
export const BUREAU_CONSENT_VERSIONS: readonly string[] = ['1.0'];

export type BureauConsentRow = {
  /** profiles.terms_accepted_at — the audit fact. Write-once. */
  terms_accepted_at: string | null;
  /** profiles.terms_version — from lib/legal/terms.ts's TERMS_VERSION. */
  terms_version: string | null;
};

/**
 * True when this profile has a RECORDED acceptance of a terms version that
 * covers a credit-bureau enquiry.
 *
 * A null row (no profile at all) is not consent. A missing timestamp is not
 * consent. A version outside the allowlist is not consent. There is no
 * grandfather clause and there must never be one — see the header.
 */
export function hasBureauConsent(profile: BureauConsentRow | null | undefined): boolean {
  if (!profile) return false;
  if (!profile.terms_accepted_at) return false;

  const version = profile.terms_version?.trim();
  if (!version) return false;

  return BUREAU_CONSENT_VERSIONS.includes(version);
}
