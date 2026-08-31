import { redirect } from 'next/navigation';
import { hasAcceptedTerms, type TermsAcceptanceRow } from './acceptance';

// ─── The gate every post-auth patient surface runs ─────────────────────
//
// Acceptance is a precondition of the account, not an onboarding step —
// that part has not changed. What changed is that the precondition is now
// CHECKED where it is relied upon, instead of only at the door that is
// supposed to establish it.
//
// The bug that produced this file: /auth/callback refuses an OAuth
// arrival with no acceptance by calling supabase.auth.signOut() and
// redirecting to /signup. But signOut REPORTS a failed revocation by
// returning `{ error }` — it early-returns before removing the stored
// session — and the callback only caught throws. So a failed sign-out
// left the visitor holding a live session while showing them the "accept
// the terms" screen. The client-side "already signed in?" shortcut on
// /signup then carried them to /dashboard, and the patient layout's
// routing gate forwarded them into an onboarding step.
//
// The callback's refusal is now terminal (it deletes the auth cookies on
// the response it actually returns, rather than trusting signOut). This
// gate is the second layer, and the one that makes the rule the product
// rule rather than one route's rule:
//
//   NO onboarding step, and no patient surface, renders for an account
//   with no acceptance on its profile row.
//
// ─── Why it takes a row and returns nothing ───────────────────────────
//
// Every caller has ALREADY read the profile row it needs — the step pages
// for their own step guards, the patient layout via the request-scoped
// memo in lib/patient/requestProfile.ts. Taking the row means this gate
// adds no round trip anywhere, and cannot itself fail in a way that has
// to be interpreted. `redirect()` throws, so there is no return value and
// nothing for a caller to forget to check.
//
// ─── Why it redirects to a ROUTE HANDLER ──────────────────────────────
//
// A Server Component cannot clear cookies — setting them during render is
// not supported (see the cookies() API docs), which is exactly why
// lib/supabase/server.ts swallows the attempt. So a gate that only
// redirected to /signup would leave the session in place, and /signup's
// own client-side session shortcut would bounce straight back to
// /dashboard: a loop, and the same defect one layer down.
//
// /auth/require-terms is a Route Handler, where cookies CAN be written.
// It re-verifies the condition, revokes, clears the cookies on its own
// response, and only then sends the visitor to /signup to agree.

/**
 * The row this gate needs. `role` is read only to decide whether the gate
 * APPLIES — see below.
 */
export type GatedProfile = TermsAcceptanceRow & {
  role?: string | null;
};

/**
 * Roles this gate does not speak for.
 *
 * profiles.terms_accepted_at records acceptance of the CUSTOMER T&Cs
 * (lib/legal/terms.ts — the ones a patient agrees to when taking a
 * payment plan). Practice, provider, admin and sales accounts are
 * provisioned by invitation and have never been asked for it, so
 * refusing them here would lock out staff over a record we never
 * collected — a bug, not a stricter rule.
 *
 * A NULL or unknown role is treated as a patient, deliberately: the 0024
 * trigger defaults new signups to 'patient', so null means "brand new
 * account" far more often than it means "staff", and this is a gate.
 */
const EXEMPT_ROLES: ReadonlySet<string> = new Set([
  'practice_admin',
  'practice_staff',
  'practice_provider',
  'admin',
  'sales',
]);

/**
 * Refuse the request unless the terms have been accepted.
 *
 * Call it AFTER establishing who the user is and BEFORE rendering
 * anything, in any surface a patient session can reach. Never returns
 * when it refuses — it throws Next's redirect.
 */
export function requireTermsAccepted(profile: GatedProfile | null | undefined): void {
  if (profile?.role && EXEMPT_ROLES.has(profile.role)) return;
  if (hasAcceptedTerms(profile)) return;
  redirect('/auth/require-terms');
}
