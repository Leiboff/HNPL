// ─── Legal terms — single source of truth for version + effective date ──
//
// The customer T&Cs are versioned. Every place that RENDERS the terms
// (the /legal/terms page header + footer) or RECORDS acceptance of them
// (patient signup → profiles.terms_version; plan activation →
// plans.terms_version) reads these constants, so a future revision is a
// one-line bump here rather than a string hunt across pages + actions +
// migrations.
//
// When you publish a new version:
//   1. bump TERMS_VERSION + TERMS_EFFECTIVE_DATE(_LABEL) here,
//   2. update the ported clause text on app/legal/terms/LegalTermsPage.tsx,
//   3. existing rows keep their old terms_version (an audit trail of what
//      each customer actually agreed to) — do NOT backfill them.

/** Current published version of the customer T&Cs. Stamped on the
 *  profile at signup and on the plan at activation. */
export const TERMS_VERSION = '1.0';

/** Effective date of TERMS_VERSION, ISO (YYYY-MM-DD) — machine form. */
export const TERMS_EFFECTIVE_DATE = '2026-08-03';

/** Human-readable form of TERMS_EFFECTIVE_DATE for on-page display. */
export const TERMS_EFFECTIVE_DATE_LABEL = '3 August 2026';
