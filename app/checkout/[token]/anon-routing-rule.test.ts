import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── /checkout/[token] anonymous-only routing rule ────────────────────────
//
// The anonymous multi-step Checkout is a SIGNUP path — it creates an
// account, tokenises a card, and charges the first instalment. It
// MUST NOT run for anyone who already has a betternow account. The
// existing patient's saved-card path is /patient/orders/{planId}/confirm
// (payWithSavedCard, no new Peach registration).
//
// This test file locks the routing rule in source text — no DB, no
// integration. It pins the four branches:
//
//   (1) logged-in owner → redirect to /patient/orders/{planId}/confirm.
//   (2) logged-in non-owner → redirect to /patient?reason=invitation_not_yours.
//   (3) logged-out AND ownership signal (plan.patient_id set OR email
//       resolves to existing account) → redirect to /login?next=…
//   (4) logged-out AND no ownership signal → anonymous CheckoutForm.
//
// It also pins:
//   - the login page honours ?next= (password + passkey + Google).
//   - the ContinueWithGoogleButton accepts + forwards the next prop.
//   - both use origin-relative safeNext validation.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const PAGE           = read('app/checkout/[token]/page.tsx');
const LOGIN          = read('app/(auth)/login/page.tsx');
const GOOGLE_BUTTON  = read('app/_components/ContinueWithGoogleButton.tsx');
const CONFIRM_PAGE   = read('app/patient/orders/[planId]/confirm/page.tsx');

describe('/checkout/[token] — anonymous flow is signup-only', () => {
  it('imports findExistingAuthUser (the email→account lookup for logged-out visitors)', () => {
    expect(PAGE).toMatch(/import\s*\{\s*findExistingAuthUser\s*\}\s*from\s*'@\/lib\/auth\/findExistingAuthUser'/);
  });

  it('looks up plan.patient_id via the service-role client (RPC does not expose it)', () => {
    // The get_invitation_by_token RPC returns email/plan_id/etc but NOT
    // plan.patient_id. Extending the RPC would be a migration; a direct
    // service-role read on plans.patient_id gives us the ownership
    // signal without one.
    const idx = PAGE.indexOf('.from(\'plans\')');
    expect(idx).toBeGreaterThan(0);
    // Assert the .select() targets patient_id on plans.
    const chunk = PAGE.slice(idx, idx + 400);
    expect(chunk).toMatch(/select\(\s*['"]patient_id['"]\s*\)/);
    expect(chunk).toMatch(/\.eq\(\s*['"]id['"]\s*,\s*row\.plan_id\s*\)/);
  });

  it('logged-in owner (sessionUser.id === plan.patient_id) → redirect to /patient/orders/{planId}/confirm', () => {
    expect(PAGE).toMatch(/planPatientId === sessionUser\.id/);
    expect(PAGE).toMatch(/redirect\(confirmPath\)/);
  });

  it('logged-in non-owner → redirect to /patient?reason=invitation_not_yours (never drop into a plan they don\'t own)', () => {
    expect(PAGE).toMatch(/redirect\(\s*['"]\/patient\?reason=invitation_not_yours['"]\s*\)/);
  });

  it('logged-out AND existing account (plan.patient_id OR email match) → /login?next=…', () => {
    expect(PAGE).toMatch(/findExistingAuthUser\(\s*svcForLookup\s*,\s*row\.email\s*\)/);
    expect(PAGE).toMatch(/redirect\(\s*`\/login\?next=\$\{encodeURIComponent\(confirmPath\)\}`\s*\)/);
  });

  it('logged-out AND truly new (no ownership signal, no email account) → CheckoutForm renders unchanged', () => {
    // Sanity: the file still ends with the anonymous CheckoutForm
    // render — the routing rule only redirects, never rewrites the
    // rendered form.
    expect(PAGE).toMatch(/<CheckoutForm[\s\S]{0,2000}initiateCheckout=\{initiateCheckout\}/);
    expect(PAGE).toMatch(/requestPhoneOtp=\{requestPhoneOtp\}/);
    expect(PAGE).toMatch(/verifyPhoneOtp=\{verifyPhoneOtp\}/);
  });

  it('findExistingAuthUser failure is non-fatal (logged as warn, does NOT lock out a truly-new patient)', () => {
    expect(PAGE).toMatch(/console\.warn\([^)]*findExistingAuthUser/);
    // A lookup blip must not redirect — the block sits inside a try
    // whose catch falls through, keeping existingAccount = false.
    const idx = PAGE.indexOf('findExistingAuthUser(svcForLookup, row.email)');
    expect(idx).toBeGreaterThan(0);
    const chunk = PAGE.slice(idx - 100, idx + 400);
    expect(chunk).toMatch(/try\s*\{/);
    expect(chunk).toMatch(/catch\s*\(/);
  });
});

describe('/login honours ?next= (post-login destination)', () => {
  it('reads ?next= from window.location.search on mount', () => {
    expect(LOGIN).toMatch(/URLSearchParams\(window\.location\.search\)/);
    expect(LOGIN).toMatch(/params\.get\(\s*['"]next['"]\s*\)/);
  });

  it('has a safeNext validator that clamps to /dashboard for non-relative or absent values', () => {
    // Mirror of /auth/callback safeNext — must reject anything that
    // doesn\'t start with / or that starts with //.
    expect(LOGIN).toMatch(/function safeNextParam/);
    expect(LOGIN).toMatch(/startsWith\(\s*['"]\/['"]/);
    expect(LOGIN).toMatch(/startsWith\(\s*['"]\/\/['"]/);
  });

  it('password sign-in redirects to nextPath (NOT hardcoded /dashboard)', () => {
    expect(LOGIN).toMatch(/window\.location\.href\s*=\s*nextPath/);
    // Old hardcoded /dashboard on password success must be gone.
    expect(LOGIN).not.toMatch(/window\.location\.href\s*=\s*['"]\/dashboard['"]/);
  });

  it('passkey sign-in also honours nextPath (via onPasskeySuccess)', () => {
    expect(LOGIN).toMatch(/onPasskeySuccess[\s\S]{0,120}nextPath/);
  });

  it('passes nextPath into the Google button (so OAuth round-trip lands on the same destination)', () => {
    expect(LOGIN).toMatch(/<ContinueWithGoogleButton[^/]*next=\{nextPath\}/);
  });
});

describe('ContinueWithGoogleButton forwards next through /auth/callback', () => {
  it('accepts an optional next prop', () => {
    expect(GOOGLE_BUTTON).toMatch(/next\?\:\s*string/);
  });

  it('validates next with an origin-relative safeNext (defence-in-depth vs the callback\'s own safeNext)', () => {
    expect(GOOGLE_BUTTON).toMatch(/function safeNext/);
    expect(GOOGLE_BUTTON).toMatch(/startsWith\(\s*['"]\/['"]/);
    expect(GOOGLE_BUTTON).toMatch(/startsWith\(\s*['"]\/\/['"]/);
  });

  it('encodes next into the callback URL (never a raw interpolation that could break the URL)', () => {
    expect(GOOGLE_BUTTON).toMatch(/\/auth\/callback\?next=\$\{encodeURIComponent\(nextParam\)\}/);
  });
});

describe('Confirm page ownership guard is the second line of defence', () => {
  // Even if the routing rule ever regresses, the confirm page itself
  // must never render for a non-owner. This pin locks the .eq('patient_id', user.id)
  // guard on the plan lookup.
  it('plans lookup is scoped to the session user by patient_id', () => {
    expect(CONFIRM_PAGE).toMatch(/\.eq\(\s*['"]patient_id['"]\s*,\s*user\.id\s*\)/);
    expect(CONFIRM_PAGE).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]pending_acceptance['"]\s*\)/);
    // Non-owner / non-pending → maybeSingle → null → bounce.
    expect(CONFIRM_PAGE).toMatch(/if\s*\(!rawPlan\)\s*redirect\(\s*['"]\/patient\/orders['"]\s*\)/);
  });
});
