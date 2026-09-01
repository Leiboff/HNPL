import { TERMS_VERSION } from './terms';
import { PRIVACY_VERSION } from './privacy';

// ─── Which text did they actually agree to? ────────────────────────────────
//
// THE GAP (audit 2026-09-02, A-14)
//
// `profiles.terms_version` records '1.0'. That answers "which version" only
// as long as nobody edits the clause text without bumping the version — and
// nothing stopped them. In a dispute over an NCA credit agreement the record
// has to survive the question "how do we know the text said that in August?",
// and a version string alone does not.
//
// A digest of the rendered document does. Stored alongside the version at
// every acceptance point, it makes the row self-verifying: recompute the hash
// of the document at version 1.0 and compare.
//
// ─── WHY THESE ARE COMMITTED CONSTANTS AND NOT COMPUTED AT RUNTIME ─────────
//
// The obvious implementation reads the .tsx and hashes it on demand. It does
// not survive deployment: Next bundles server code, so the source file is not
// reliably on disk in a serverless function, and a hash that silently becomes
// null in production is worse than no hash at all.
//
// So the digest is a constant, and documentHash.test.ts recomputes it from
// the source files and fails if they disagree. The test IS the enforcement:
// editing a clause without bumping the version and the hash together turns
// the suite red, which is exactly the change that should be hard to make by
// accident.
//
// WHEN YOU PUBLISH A NEW VERSION
//   1. edit the clause text,
//   2. bump TERMS_VERSION / PRIVACY_VERSION and their effective dates,
//   3. run the test, take the hash it reports, and paste it in below.
// Existing rows keep their old version AND their old hash — that pair is the
// audit trail, and backfilling either destroys it.

/** SHA-256 of app/legal/terms/LegalTermsPage.tsx at TERMS_VERSION. */
export const TERMS_DOC_SHA256 =
  '06938e3f518cec9decad78eed123d467e03a9ac24f00dc154b2f0739865e8e8b';

/** SHA-256 of app/legal/privacy/LegalPrivacyPage.tsx at PRIVACY_VERSION. */
export const PRIVACY_DOC_SHA256 =
  '99e33fe2ad7f381da1b21efa64e70bf3b826302c86587140b09a2eaf0010ce85';

/** The source files the hashes above cover. Read by the test, not at runtime. */
export const TERMS_DOC_PATH   = 'app/legal/terms/LegalTermsPage.tsx';
export const PRIVACY_DOC_PATH = 'app/legal/privacy/LegalPrivacyPage.tsx';

/**
 * The columns every acceptance point writes, so the three of them cannot
 * drift into recording different things about the same act.
 *
 * Was three inline object literals — signup, the OAuth callback and checkout
 * — which is how one of them comes to be missing a column. The signup path's
 * own comment already said as much about its internal copies.
 */
export function consentColumns(now: Date = new Date()): {
  terms_accepted_at:   string;
  terms_version:       string;
  privacy_version:     string;
  terms_doc_sha256:    string;
  privacy_doc_sha256:  string;
} {
  return {
    terms_accepted_at:  now.toISOString(),
    terms_version:      TERMS_VERSION,
    privacy_version:    PRIVACY_VERSION,
    terms_doc_sha256:   TERMS_DOC_SHA256,
    privacy_doc_sha256: PRIVACY_DOC_SHA256,
  };
}
