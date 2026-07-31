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

  it('looks up plan.patient_id + status + peach_registration_id via the service-role client (RPC does not expose them)', () => {
    // The get_invitation_by_token RPC returns email/plan_id/etc but NOT
    // plan.patient_id, plan.status, or plan.peach_registration_id.
    // Extending the RPC would be a migration; a direct service-role
    // read on plans gives us the three signals we need for the routing
    // + uncaptured-resume decision without one.
    const idx = PAGE.indexOf('.from(\'plans\')');
    expect(idx).toBeGreaterThan(0);
    const chunk = PAGE.slice(idx, idx + 400);
    // patient_id must remain in the select — it's the ownership signal.
    expect(chunk).toMatch(/select\(\s*['"][^'"]*patient_id[^'"]*['"]\s*\)/);
    // status + peach_registration_id are the uncaptured detection.
    expect(chunk).toMatch(/select\(\s*['"][^'"]*status[^'"]*['"]\s*\)/);
    expect(chunk).toMatch(/select\(\s*['"][^'"]*peach_registration_id[^'"]*['"]\s*\)/);
    expect(chunk).toMatch(/\.eq\(\s*['"]id['"]\s*,\s*row\.plan_id\s*\)/);
  });

  it('logged-in owner + captured/pending_acceptance plan → redirect to /patient/orders/{planId}/confirm', () => {
    // The ownership check is unchanged; the redirect to /confirm still
    // fires for a session user who owns the plan AND whose plan is NOT
    // in the uncaptured state (has a token, or in pending_acceptance).
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

describe('/checkout/[token] — uncaptured plan resumes on the capture flow (not redirected to /confirm)', () => {
  // The post-5b7f719 rule redirected every logged-in owner to /confirm.
  // /confirm filters `.eq('status', 'pending_acceptance')` and bounces
  // to /patient/orders for any other status — so a plan that reached
  // pending_first_payment but never captured a card ended in a
  // permanent stuck state. The refined rule keeps uncaptured plans on
  // /checkout/[token], rendering ResumeCapture to re-open the Peach V2
  // widget for the SAME instalment-1 row (deterministic Peach ref →
  // Peach dedups the transaction).

  const ACTIONS   = read('app/checkout/[token]/actions.ts');
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  it('page detects uncaptured plans via status + peach_registration_id', () => {
    expect(PAGE).toMatch(/isUncapturedPlan/);
    // The definition must be exactly pending_first_payment AND no
    // peach_registration_id — anything else means the plan is in a
    // saved-card-appropriate state (or never accepted).
    expect(PAGE).toMatch(/planStatus === 'pending_first_payment'/);
    expect(PAGE).toMatch(/&&\s*!planRegistrationId/);
  });

  it('page renders <ResumeCapture> for a logged-in owner of an uncaptured plan (does NOT redirect to /confirm)', () => {
    // The uncaptured branch renders in-place; the redirect(confirmPath)
    // is guarded by the else-of-isUncapturedPlan.
    expect(PAGE).toMatch(/import ResumeCapture from '\.\/ResumeCapture'/);
    expect(PAGE).toMatch(/if \(isUncapturedPlan\)\s*\{/);
    expect(PAGE).toMatch(/<ResumeCapture[\s\S]{0,600}resumeAction=\{resumeFirstInstalmentCapture\}/);
  });

  it('page still redirects a logged-in owner to /confirm when the plan is NOT uncaptured', () => {
    // The redirect(confirmPath) still exists — just moved inside the
    // else of the uncaptured branch. The old behaviour (owner +
    // pending_acceptance / with-token → /confirm) is preserved.
    const idx = PAGE.indexOf('isUncapturedPlan');
    expect(idx).toBeGreaterThan(0);
    const chunk = PAGE.slice(idx, idx + 2500);
    expect(chunk).toMatch(/redirect\(confirmPath\)/);
  });

  it('non-owner path unchanged: never routed into the plan (belt-and-braces on the resume path)', () => {
    // The resume branch is inside the owner block (planPatientId ===
    // sessionUser.id). A non-owner never reaches ResumeCapture.
    // Pin this by locating ResumeCapture rendering and confirming it
    // sits after the planPatientId === sessionUser.id check.
    const ownerCheckIdx = PAGE.indexOf('planPatientId === sessionUser.id');
    const resumeIdx     = PAGE.indexOf('<ResumeCapture');
    expect(ownerCheckIdx).toBeGreaterThan(0);
    expect(resumeIdx).toBeGreaterThan(ownerCheckIdx);
    // The non-owner redirect must still be present after both.
    expect(PAGE).toMatch(/redirect\(\s*['"]\/patient\?reason=invitation_not_yours['"]\s*\)/);
  });
});

describe('resumeFirstInstalmentCapture — idempotent for the existing plan', () => {
  const ACTIONS = read('app/checkout/[token]/actions.ts');

  it('is exported and takes just the invitation token', () => {
    expect(ACTIONS).toMatch(/export async function resumeFirstInstalmentCapture\(\s*token:\s*string/);
  });

  it('requires a signed-in user (session guard)', () => {
    // Locate the action block and inspect its own content.
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    expect(startIdx).toBeGreaterThan(0);
    // Grab up to the next top-level export — that's this function's body.
    const rest        = ACTIONS.slice(startIdx);
    const nextExport  = rest.indexOf('\nexport ', 1);
    const body        = nextExport > 0 ? rest.slice(0, nextExport) : rest;

    expect(body).toMatch(/supabase\.auth\.getUser\(\)/);
    expect(body).toMatch(/if\s*\(!user\)/);
  });

  it('rejects a non-owner: plan.patient_id !== session user id', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    const rest     = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body     = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    expect(body).toMatch(/plan\.patient_id[^!]*!==\s*user\.id/);
  });

  it('requires plan.status === pending_first_payment AND peach_registration_id IS NULL', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    const rest     = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body     = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    expect(body).toMatch(/plan\.status\s*!==\s*'pending_first_payment'/);
    expect(body).toMatch(/if\s*\(plan\.peach_registration_id\)/);
  });

  it('does NOT create an account, upsert the profile, or delete/insert payments (no duplication)', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    const rest     = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body     = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    // These are the DB-write / account-side-effect signatures that
    // WOULD duplicate state. Their absence is the load-bearing
    // idempotency contract.
    expect(body).not.toMatch(/auth\.admin\.createUser/);
    expect(body).not.toMatch(/from\('profiles'\)\.upsert/);
    expect(body).not.toMatch(/from\('payments'\)\.delete/);
    expect(body).not.toMatch(/from\('payments'\)\.insert/);
    // The plan status/schedule columns must NOT be rewritten either
    // (initiateCheckout writes them on attempt 1; resume must not
    // touch them).
    expect(body).not.toMatch(/from\('plans'\)[\s\S]{0,120}status:\s*'pending_first_payment'/);
    expect(body).not.toMatch(/instalment_amount:/);
  });

  it('re-uses the SAME instalment-1 payment id and mints a deterministic Peach ref via checkoutRef(payment.id)', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    const rest     = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body     = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    // Reads (does NOT insert) the existing instalment-1 row.
    expect(body).toMatch(/from\('payments'\)[\s\S]{0,200}\.eq\(\s*'instalment_number'\s*,\s*1\s*\)/);
    // Mints ref from that row's id — deterministic across resume calls.
    expect(body).toMatch(/checkoutRef\(payment\.id as string\)/);
  });

  it('shopperResultUrl uses the token-based /checkout/[token]/complete route', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    const rest     = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body     = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    expect(body).toMatch(/\/checkout\/\$\{token\}\/complete/);
  });
});

describe('ResumeCapture — server action wired through, PeachWidget mounted on success', () => {
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  it('mounts PeachWidget with the checkoutId + shopperResultUrl returned by the resume action', () => {
    expect(RESUME_UI).toMatch(/PeachWidget/);
    expect(RESUME_UI).toMatch(/checkoutId=\{widget\.checkoutId\}/);
    expect(RESUME_UI).toMatch(/shopperResultUrl=\{widget\.shopperResultUrl\}/);
  });

  it('calls the injected resumeAction (server action) with the token, sets widget state on ok', () => {
    expect(RESUME_UI).toMatch(/resumeAction\(token\)/);
    expect(RESUME_UI).toMatch(/setWidget\(\{\s*checkoutId:[^}]*shopperResultUrl:/);
  });

  it('surfaces a visible error alert when the resume action fails (no silent stuck state)', () => {
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-error"/);
    expect(RESUME_UI).toMatch(/role="alert"/);
  });
});

describe('/checkout/[token] — card-only widget (no Apple Pay / Google Pay)', () => {
  // Wallet-issued tokens are SINGLE-USE — instalments 2..N would be
  // uncollectable if the first CIT captured a wallet token instead of
  // a reusable card registration. Force the V2 widget to card-only on
  // both entry points (fresh capture + resume). The provider/client
  // layer whitelists these fields at the boundary so a caller can't
  // pass an unsupported method through.
  //
  // V2 field names: defaultPaymentMethod + forceDefaultMethod. If a
  // future Peach V2 change renames these, the failure is loud — the
  // /v2/checkout endpoint returns an "unknown field" 400 (same shape
  // as the source-field failure on 2026-07-30) and PEACH CHECKOUT
  // INITIATE ERROR will log it.

  const ACTIONS  = read('app/checkout/[token]/actions.ts');
  const PROVIDER = read('lib/payments/provider.ts');
  const CLIENT   = read('lib/payments/peach/client.ts');

  it('CheckoutCreateParams exposes defaultPaymentMethod=\'CARD\' + forceDefaultMethod:boolean', () => {
    expect(PROVIDER).toMatch(/defaultPaymentMethod\?:\s*'CARD'/);
    expect(PROVIDER).toMatch(/forceDefaultMethod\?:\s*boolean/);
  });

  it('client.ts serialises defaultPaymentMethod + forceDefaultMethod into the /v2/checkout body', () => {
    // Both fields must be whitelisted at the boundary. Assert both
    // the input read AND the body write so a future refactor that
    // forgets the second half will break the test.
    expect(CLIENT).toMatch(/params\.defaultPaymentMethod === 'CARD'/);
    expect(CLIENT).toMatch(/body\.defaultPaymentMethod\s*=\s*'CARD'/);
    expect(CLIENT).toMatch(/typeof params\.forceDefaultMethod === 'boolean'/);
    expect(CLIENT).toMatch(/body\.forceDefaultMethod\s*=\s*params\.forceDefaultMethod/);
  });

  it('initiateCheckout (fresh) passes defaultPaymentMethod=\'CARD\' + forceDefaultMethod=true', () => {
    const startIdx = ACTIONS.indexOf('export async function initiateCheckout');
    expect(startIdx).toBeGreaterThan(0);
    const rest       = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body       = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    // Both card-only fields present in the createCheckout call body.
    expect(body).toMatch(/defaultPaymentMethod:\s*'CARD'/);
    expect(body).toMatch(/forceDefaultMethod:\s*true/);
  });

  it('resumeFirstInstalmentCapture (resume) also passes card-only fields', () => {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    expect(startIdx).toBeGreaterThan(0);
    const rest       = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    const body       = nextExport > 0 ? rest.slice(0, nextExport) : rest;
    expect(body).toMatch(/defaultPaymentMethod:\s*'CARD'/);
    expect(body).toMatch(/forceDefaultMethod:\s*true/);
  });
});

describe('/checkout/[token] — no fresh-vs-resume flicker on soft-nav back to the page', () => {
  // The routing decision (fresh CheckoutForm vs ResumeCapture) is
  // server-side in page.tsx. To ensure a soft-nav back to
  // /checkout/[token] (e.g. from the /complete "Try again" link)
  // ALWAYS re-runs that decision and never serves a stale RSC from
  // the client-side router cache, the page is marked force-dynamic +
  // revalidate=0, and the /complete retry uses a plain <a> tag
  // (hard reload) instead of a next/link soft-nav.
  //
  // Together these guarantee the first paint after any return trip
  // is the CORRECT surface, not a flash of the earlier one.

  const COMPLETE = read('app/checkout/[token]/complete/page.tsx');

  it('page opts into force-dynamic + revalidate=0 (client staleTime=0)', () => {
    expect(PAGE).toMatch(/export const dynamic\s*=\s*'force-dynamic'/);
    expect(PAGE).toMatch(/export const revalidate\s*=\s*0/);
  });

  it('/complete Try-again is a plain <a> (hard reload), not a next/link soft-nav', () => {
    // If we used next/link here, the router cache MIGHT serve the
    // pre-attempt RSC of /checkout/[token] (which rendered
    // CheckoutForm) before revalidating to the fresh ResumeCapture
    // RSC — that swap is the flicker.
    expect(COMPLETE).toMatch(/<a[\s\S]*?data-testid="checkout-complete-retry"/);
    expect(COMPLETE).not.toMatch(/<Link[\s\S]*?data-testid="checkout-complete-retry"/);
    // next/link should not be imported at all — it was only used for
    // this button.
    expect(COMPLETE).not.toMatch(/from 'next\/link'/);
  });

  it('isUncapturedPlan does not mislabel a genuinely fresh plan as resume', () => {
    // A fresh plan is 'pending_acceptance' (bill not yet accepted).
    // isUncapturedPlan requires 'pending_first_payment' — i.e. the
    // schedule has been written AND the CIT has not landed. The two
    // are mutually exclusive by construction: initiateCheckout /
    // acceptPlan / payWithSavedCard are the only writers of
    // 'pending_first_payment', and each ONLY runs after the patient
    // consented to a plan. A fresh plan therefore never satisfies
    // isUncapturedPlan and never sees the "Resume your payment"
    // surface.
    expect(PAGE).toMatch(/planStatus === 'pending_first_payment'/);
    // The uncaptured render is gated inside `if (isUncapturedPlan)`;
    // the else path (`redirect(confirmPath)`) handles fresh
    // pending_acceptance plans exactly as before.
    expect(PAGE).toMatch(/if \(isUncapturedPlan\)\s*\{/);
    expect(PAGE).toMatch(/redirect\(confirmPath\)/);
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
