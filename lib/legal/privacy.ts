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

/** Current published version of the Privacy Policy. */
export const PRIVACY_VERSION = '1.0';

/** Effective date of PRIVACY_VERSION, ISO (YYYY-MM-DD) — machine form. */
export const PRIVACY_EFFECTIVE_DATE = '2026-08-03';

/** Human-readable form of PRIVACY_EFFECTIVE_DATE for on-page display. */
export const PRIVACY_EFFECTIVE_DATE_LABEL = '3 August 2026';
