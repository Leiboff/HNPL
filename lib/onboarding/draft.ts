// ─── Resumable-draft helpers (pure) ─────────────────────────────────────
//
// The "draft" is just the profiles row while onboarding_completed=false —
// see supabase/migrations/0085_onboarding_draft_resume.sql. This module
// holds the pure bits: the expiry rule and the masking shown on the
// "Welcome back" interstitial so a returning patient can confirm the
// draft is theirs without us ever printing the raw email/phone.
//
// No I/O here — same convention as lib/onboarding/state.ts.

/** A draft untouched for this many days is treated as expired — only
 *  "Start over" is offered, no continue option. */
export const DRAFT_EXPIRY_DAYS = 30;

/** Short-lived, single-purpose, httpOnly cookie. Its presence on the
 *  NEXT /onboarding load means "this request is a direct continuation
 *  of the step the caller just finished" — set by the step action
 *  right before the client navigates back to /onboarding, and checked
 *  by the router to decide whether the resume interstitial is needed.
 *  Value is the user id (not just a flag) so a leftover cookie from a
 *  previous session on a shared device can never suppress the
 *  interstitial for a DIFFERENT patient's draft. Never read by client
 *  JS — server-side only, per the no-localStorage/sessionStorage rule. */
export const ONBOARDING_ADVANCE_COOKIE = 'hnpl_onboarding_advance';

/** Just long enough to bridge a step action's redirect into the next
 *  page load; not a security boundary. */
export const ONBOARDING_ADVANCE_TTL_SECONDS = 120;

/**
 * True once `lastActiveAt` is more than DRAFT_EXPIRY_DAYS in the past.
 * A null `lastActiveAt` means no draft exists yet — never "expired",
 * just absent — so this only makes sense to call once the caller has
 * already established a draft exists.
 */
export function isDraftExpired(lastActiveAt: string | null, now: Date = new Date()): boolean {
  if (!lastActiveAt) return false;
  const ageMs = now.getTime() - new Date(lastActiveAt).getTime();
  return ageMs > DRAFT_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Masks an email's local part for display on the resume interstitial:
 * "jane.smith@example.com" → "j*********h@example.com". Short local
 * parts (<=2 chars) collapse to a single visible leading character.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.indexOf('@');
  if (at <= 0) return null;
  const local  = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (!domain) return null;

  if (local.length <= 2) return `${local[0]}***@${domain}`;
  const middle = '*'.repeat(local.length - 2);
  return `${local[0]}${middle}${local[local.length - 1]}@${domain}`;
}

/**
 * Masks a phone number to its last 4 digits for display: "0821234567"
 * → "•••• 4567". Returns null for anything too short to mask sensibly.
 */
export function maskPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 4) return null;
  return `•••• ${digits.slice(-4)}`;
}
