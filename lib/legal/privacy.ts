// ─── Privacy Policy — single source of truth for version + date ─────────
//
// Mirrors lib/legal/terms.ts. Referenced by the /legal/privacy page AND
// by the acceptance-recording writes (profiles.privacy_version at signup;
// plans.privacy_version at plan activation). Acceptance of the T&Cs and
// the Privacy Policy happens in the same moment (one combined "I agree"),
// so there is no separate privacy timestamp — the existing
// terms_accepted_at covers the combined acceptance instant; we only add
// the privacy VERSION marker so a row records which policy was in force.
//
// When you publish a new version, bump these + update the ported content
// on app/legal/privacy/LegalPrivacyPage.tsx. Existing rows keep their old
// privacy_version — an audit trail; do NOT backfill.
//
// ─── CHANGE LOG ──────────────────────────────────────────────────────
//
// 1.1 (2026-08-18) — clause 12.2 identified the Information Officer with an
//   unfilled placeholder, "[INSERT NAME / TITLE]", which shipped live. It now
//   identifies the Officer by ROLE and contact route instead of by person, so
//   there is nothing left to fill in and no individual to keep current. No
//   other clause changed.
//
//   Bumped rather than corrected in place because a row stamped
//   privacy_version = '1.0' should not label text that has since changed.
//   NOTE, so nobody over-trusts the bump: no re-acceptance is triggered by
//   it — nothing in the codebase compares a stored version against these
//   constants (verified by grep across app/ and lib/, 2026-08-18). The
//   version is an audit marker, not a gate.
//
//   Bumping is ALSO not a complete audit fix, and should not be mistaken for
//   one: superseded policy text is not archived anywhere, so no row at 1.0 or
//   1.1 can retrieve the words it accepted. The bump stops the label being
//   actively wrong; preserving the text per version is a separate task.
//
// 1.0 (2026-08-03) — first published version.

/** Current published version of the Privacy Policy. */
export const PRIVACY_VERSION = '1.1';

/** Effective date of PRIVACY_VERSION, ISO (YYYY-MM-DD) — machine form. */
export const PRIVACY_EFFECTIVE_DATE = '2026-08-18';

/** Human-readable form of PRIVACY_EFFECTIVE_DATE for on-page display. */
export const PRIVACY_EFFECTIVE_DATE_LABEL = '18 August 2026';
