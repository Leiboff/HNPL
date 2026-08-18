// ─── Published contact details — single source of truth ─────────────────
//
// The one home for the business contact details we publish publicly.
// Rendered by /contact (app/contact/ContactPage.tsx) and nowhere else, so
// changing a detail is a one-line edit here rather than a string hunt
// through markup.
//
// WHY THIS EXISTS AT ALL: these details are published for acquirer /
// merchant-onboarding compliance — a bank needs to see real, verifiable
// contact details on the site. That makes them a factual record, not
// marketing copy: do not embellish, and do not add a channel we cannot
// actually answer.
//
// The registered entity name and registration number are NOT invented
// here. They are the ones already published in the T&Cs and the Privacy
// Policy (app/legal/terms/LegalTermsPage.tsx clause 1.11,
// app/legal/privacy/LegalPrivacyPage.tsx clause 12.1). An acquirer expects
// the registered entity alongside the trading name, and it must match the
// legal documents exactly — so if the entity is ever re-registered, these
// three places change together.

/** Trading name, as used across the marketing surface. */
export const TRADING_NAME = 'betternow';

/** Registered legal entity, matching the T&Cs (1.11) and Privacy (12.1). */
export const LEGAL_ENTITY = 'BETTERNOW (PTY) LTD';

/** Company registration number, matching the T&Cs (1.11) and Privacy (12.1). */
export const REGISTRATION_NUMBER = '2026/420968/07';

/** Physical (street) address. An acquirer expects a real, verifiable one. */
export const ADDRESS_LINES = [
  'Unit 35, 19 Cross Road',
  'Glenhazel',
  'Johannesburg',
  '2192',
] as const;

/** Single-line form of ADDRESS_LINES, for metadata and structured data. */
export const ADDRESS_ONE_LINE = ADDRESS_LINES.join(', ');

/** Support mailbox. Also quoted independently in the legal documents —
 *  see the note in app/contact/ContactPage.tsx on why those are not
 *  refactored to read from here. */
export const SUPPORT_EMAIL = 'support@betternow.co.za';

// ── Phone ────────────────────────────────────────────────────────────────
//
// TEMPORARY: this is a PERSONAL number standing in until a business line
// is provisioned. It lives here, in exactly one place, precisely so the
// swap is a one-line change — do not copy the digits into markup, tests or
// metadata; import PHONE_DISPLAY / PHONE_TEL instead.
//
// When the business line arrives, edit BOTH constants below and nothing
// else. (They are separate because the human-readable spacing and the
// tel: URI form differ; a test pins that they describe the same digits.)

/** Human-readable phone number, in the local SA grouping. TEMPORARY — see above. */
export const PHONE_DISPLAY = '084 232 4201';

/** tel: URI target for PHONE_DISPLAY, E.164. TEMPORARY — see above. */
export const PHONE_TEL = '+27842324201';

// ── Hours ────────────────────────────────────────────────────────────────
//
// ONE set of hours for every channel, stated as when we ARE open. We
// deliberately do not enumerate closed days, split hours per channel, or
// explain absences: a published "closed" list is a promise about the whole
// week that is easy to break, and a bank reading this page wants the hours
// we answer on, not a policy document.

/** Operating hours. One line, one set of hours, for everything. */
export const HOURS = 'Monday to Friday, 08:00–17:00';
