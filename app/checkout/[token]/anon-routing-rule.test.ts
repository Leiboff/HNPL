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

  it('logged-in non-owner → told why, in place (never dropped into a plan they don\'t own)', () => {
    // Was a redirect to /patient?reason=invitation_not_yours. Nothing read
    // that parameter, so the patient landed on their dashboard with no
    // explanation at all. The AUTHORIZATION rule is unchanged — they still
    // never reach the plan — but the outcome is now stated on the screen
    // they are already looking at.
    expect(PAGE).toMatch(/return <BillMatchCard failure=\{billMatchFailureFor\(claimRefusal, resolved\.kind\)\} \/>/);
    expect(PAGE).not.toMatch(/invitation_not_yours/);
  });

  it('logged-out AND existing account (plan.patient_id OR email match) → /login?next=…', () => {
    // Only checked for an invitation-sourced token — a POS session
    // token has no email signal (see resolved.kind === 'invitation' gate).
    expect(PAGE).toMatch(/findExistingAuthUser\(\s*svcForLookup\s*,\s*resolved\.row\.email\s*\)/);
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
    const idx = PAGE.indexOf('findExistingAuthUser(svcForLookup, resolved.row.email)');
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
    // The redirect(confirmPath) still exists — just inside the else of the
    // uncaptured branch. The old behaviour (owner + pending_acceptance /
    // with-token → /confirm) is preserved.
    //
    // Anchored on the BRANCH rather than on a character window. This was
    // `PAGE.slice(idx, idx + 4000)`, which had already been widened once and
    // broke again when the counter-session claim was inserted above it — a
    // fixed offset makes an unrelated edit look like a routing regression.
    // What the test means is "the owner branch ends in that redirect", so
    // that is what it now asserts.
    const ownerBranch = PAGE.indexOf('if (planPatientId === sessionUser.id)');
    const redirectIdx = PAGE.indexOf('redirect(confirmPath)');
    const notYours    = PAGE.indexOf('<BillMatchCard failure=');
    expect(ownerBranch).toBeGreaterThan(0);
    expect(redirectIdx).toBeGreaterThan(ownerBranch);
    expect(notYours).toBeGreaterThan(redirectIdx);
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
    // The non-owner exit must still be present after both.
    expect(PAGE).toMatch(/<BillMatchCard failure=/);
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

  it('calls the injected resumeAction with the token + reuseExisting:true, sets widget state on ok', () => {
    // Pay always passes reuseExisting:true — "reuse the freshly-minted
    // checkout if you safely can". The action gates the actual reuse on
    // its fresh-checkout cookie (normal flow reuses; re-entry mints).
    expect(RESUME_UI).toMatch(/resumeAction\(token,\s*\{\s*reuseExisting:\s*true\s*\}\)/);
    expect(RESUME_UI).toMatch(/setWidget\(\{\s*checkoutId:[^}]*shopperResultUrl:/);
  });

  it('surfaces a visible error alert when the resume action fails (no silent stuck state)', () => {
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-error"/);
    expect(RESUME_UI).toMatch(/role="alert"/);
  });
});

describe('ResumeCapture — single "Confirm and pay" surface (no first-vs-return copy split)', () => {
  // The prior-attempt copy branch was removed: peach_checkout_id is
  // stamped during the FIRST initiateCheckout — before this capture
  // screen ever renders — so any priorAttempt flag derived from it was
  // effectively always true and mislabelled brand-new first attempts
  // as "Resume". The surface now reads "Confirm and pay" for BOTH a
  // first attempt and a genuine re-entry.
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');
  const PAGE_SRC  = read('app/checkout/[token]/page.tsx');

  it('heading is a single static "Confirm and pay" — no "Resume your payment" anywhere', () => {
    expect(RESUME_UI).toMatch(/Confirm and pay/);
    expect(RESUME_UI).not.toMatch(/Resume your payment/);
    expect(RESUME_UI).toMatch(/Complete instalment 1 to activate your plan/);
  });

  it('the priorAttempt prop + branch are gone from the component', () => {
    expect(RESUME_UI).not.toMatch(/priorAttempt/);
    // No copy ternary remains that could re-introduce a "Resume" label.
    expect(RESUME_UI).not.toMatch(/'Resume/);
  });

  it('page.tsx no longer computes or passes priorAttempt (nor selects peach_checkout_id here)', () => {
    expect(PAGE_SRC).not.toMatch(/priorAttempt/);
    // The instalment-schedule fetch in the uncaptured branch must not
    // re-add peach_checkout_id (it existed only for the removed copy).
    const idx = PAGE_SRC.indexOf('if (isUncapturedPlan)');
    expect(idx).toBeGreaterThan(0);
    const branch = PAGE_SRC.slice(idx, idx + 1600);
    expect(branch).not.toMatch(/peach_checkout_id/);
  });

  it('the schedule is still shown on the capture surface (unified with the fresh Pay step)', () => {
    expect(RESUME_UI).toMatch(/ScheduleStrip/);
    expect(PAGE_SRC).toMatch(/scheduleAmounts=\{scheduleAmounts\}/);
    expect(PAGE_SRC).toMatch(/scheduleDates=\{scheduleDates\}/);
  });

  it('the capture surface still renders for uncaptured plans (routing unchanged)', () => {
    expect(PAGE_SRC).toMatch(/if \(isUncapturedPlan\)\s*\{/);
    expect(PAGE_SRC).toMatch(/<ResumeCapture[\s\S]{0,700}resumeAction=\{resumeFirstInstalmentCapture\}/);
  });
});

describe('single confirm owned by ResumeCapture (CheckoutForm has NO confirm/pay step)', () => {
  // The redundant pre-pay interstitial is collapsed: OTP verification
  // fires the initiateCheckout hand-off DIRECTLY (handleVerified →
  // submitPay), so after Verify the form shows only a brief loading state
  // and redirects to /checkout/[token] with NO query param. The one and
  // only payment confirm — schedule + amount + Pay — lives on
  // ResumeCapture, the surface that demonstrably mounts the widget. No
  // ?capture=auto, no autoStart, no auto-fire, anywhere.
  const FORM_SRC   = read('app/checkout/[token]/CheckoutForm.tsx');
  const PAGE_SRC   = read('app/checkout/[token]/page.tsx');
  const RESUME_UI  = read('app/checkout/[token]/ResumeCapture.tsx');

  it('OTP verification hands off directly (no "Continue to payment" interstitial button)', () => {
    // onVerified runs the hand-off itself; there is no separate confirm
    // step to tap through.
    expect(FORM_SRC).toMatch(/onVerified=\{handleVerified\}/);
    expect(FORM_SRC).toMatch(/function handleVerified\(\)\s*\{[\s\S]{0,120}submitPay\(\)/);
    // Step 5 is a loading hand-off, not a confirm/pay screen: no
    // "Pay Rx today" button, no "First instalment — due today" eyebrow,
    // no "Confirm and pay" heading, and a loading placeholder is present.
    expect(FORM_SRC).not.toMatch(/Pay \$\{formatRand\(instalments\[0\]\)\} today/);
    expect(FORM_SRC).not.toMatch(/heading="Confirm and pay"/);
    expect(FORM_SRC).toMatch(/data-testid="checkout-handoff-loading"/);
    // CheckoutForm still mounts NO widget (that's ResumeCapture's job).
    expect(FORM_SRC).not.toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(FORM_SRC).not.toMatch(/<PeachWidget/);
  });

  it('CheckoutForm redirects to /checkout/[token] WITHOUT ?capture=auto', () => {
    expect(FORM_SRC).toMatch(/router\.replace\(`\/checkout\/\$\{token\}`\)/);
    expect(FORM_SRC).not.toMatch(/capture=auto/);
  });

  it('no ?capture=auto / autoStart machinery anywhere (page, form, or capture surface)', () => {
    for (const src of [FORM_SRC, PAGE_SRC, RESUME_UI]) {
      expect(src).not.toMatch(/capture=auto/);
      expect(src).not.toMatch(/autoStart/);
      expect(src).not.toMatch(/autoFired/);
      expect(src).not.toMatch(/autoFailed/);
      expect(src).not.toMatch(/resume-capture-autostart/);
    }
  });

  it('page.tsx no longer reads a capture query param', () => {
    expect(PAGE_SRC).not.toMatch(/sp\.capture/);
    // The uncaptured branch still renders ResumeCapture (routing intact).
    expect(PAGE_SRC).toMatch(/if \(isUncapturedPlan\)\s*\{/);
    expect(PAGE_SRC).toMatch(/<ResumeCapture[\s\S]{0,700}resumeAction=\{resumeFirstInstalmentCapture\}/);
  });

  it('ResumeCapture is a single confirm → widget: one Pay button, no auto-fire effect', () => {
    // One confirm view with the Pay button; the widget mounts on tap.
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-button"/);
    expect(RESUME_UI).toMatch(/Confirm and pay/);
    // No effect-driven auto-fire remains.
    expect(RESUME_UI).not.toMatch(/useEffect/);
    // Pay tap calls start() → the resume action.
    expect(RESUME_UI).toMatch(/onClick=\{\(\)\s*=>\s*void start\(\)\}/);
  });
});

describe('normal signup makes exactly ONE createCheckout (fresh-cookie reuse)', () => {
  // initiateCheckout mints + stamps a checkout AND drops a short-lived
  // fresh-checkout cookie. The ResumeCapture Pay that immediately follows
  // reuses THAT checkout (cookie value === stamped id) → one
  // createCheckout on the normal path. A genuine re-entry days later has
  // no fresh cookie → the action mints fresh (deterministic ref dedups),
  // so the widget always works. This replaces the deleted ?capture=auto
  // signal without any auto-start UI.
  const ACTIONS   = read('app/checkout/[token]/actions.ts');
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  function actionBody(name: string): string {
    const startIdx = ACTIONS.indexOf(`export async function ${name}`);
    expect(startIdx).toBeGreaterThan(0);
    const rest       = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    return nextExport > 0 ? rest.slice(0, nextExport) : rest;
  }

  it('initiateCheckout drops the fresh-checkout cookie carrying the minted checkoutId', () => {
    const body = actionBody('initiateCheckout');
    expect(body).toMatch(/cookieStore\.set\(FRESH_CHECKOUT_COOKIE,\s*checkoutId/);
  });

  it('resume reuses ONLY when the fresh cookie matches the stamped id (else mints)', () => {
    const body = actionBody('resumeFirstInstalmentCapture');
    // Reads the fresh cookie + the stamped id, and gates reuse on a match.
    expect(body).toMatch(/cookieStore\.get\(FRESH_CHECKOUT_COOKIE\)\?\.value/);
    expect(body).toMatch(/const existingCheckoutId = \(payment\.peach_checkout_id as string \| null\) \?\? null/);
    expect(body).toMatch(/freshCheckoutId === existingCheckoutId/);
    // createCheckout is gated behind the else of canReuse — skipped on reuse.
    const reuseIdx = body.indexOf('if (canReuse)');
    const mintIdx  = body.indexOf('provider.createCheckout');
    expect(reuseIdx).toBeGreaterThan(0);
    expect(mintIdx).toBeGreaterThan(reuseIdx);
    expect(body.slice(reuseIdx, mintIdx)).toMatch(/\}\s*else\s*\{/);
  });

  it('the instalment-1 select carries peach_checkout_id (so reuse has something to reuse)', () => {
    const body = actionBody('resumeFirstInstalmentCapture');
    expect(body).toMatch(/select\(\s*['"]id,\s*amount,\s*peach_checkout_id['"]\s*\)/);
  });

  it('ResumeCapture Pay always passes reuseExisting:true (reuse-if-safe hint)', () => {
    expect(RESUME_UI).toMatch(/resumeAction\(token,\s*\{\s*reuseExisting:\s*true\s*\}\)/);
  });

  it('the deterministic ref stays as the mint-path safety net (not removed)', () => {
    const body = actionBody('resumeFirstInstalmentCapture');
    expect(body).toMatch(/checkoutRef\(payment\.id as string\)/);
  });
});

describe('no pre-card screen claims a charge is already in progress', () => {
  // No pre-card surface may read "CHARGING YOUR CARD NOW" before any card
  // has been entered. CheckoutForm's hand-off step is a loading state (no
  // charge claim); ResumeCapture's confirm reads "First instalment — due
  // today" and its CTA is "Pay Rx today".
  const FORM_SRC  = read('app/checkout/[token]/CheckoutForm.tsx');
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  it('neither surface says "charging your card now"', () => {
    expect(FORM_SRC).not.toMatch(/[Cc]harging your card now/);
    expect(RESUME_UI).not.toMatch(/[Cc]harging your card now/);
  });

  it('ResumeCapture confirm reads "First instalment — due today" + "Pay Rx today"', () => {
    expect(RESUME_UI).toMatch(/First instalment — due today/);
    expect(RESUME_UI).toMatch(/Pay \$\{formatRand\(firstInstalmentAmount\)\} today/);
  });

  it('CheckoutForm hand-off makes no charge claim (loading state, no "Pay today" button)', () => {
    expect(FORM_SRC).toMatch(/data-testid="checkout-handoff-loading"/);
    expect(FORM_SRC).not.toMatch(/Pay \$\{formatRand\(instalments\[0\]\)\} today/);
    // "No charge yet" is explicit in the hand-off copy.
    expect(FORM_SRC).toMatch(/No charge yet/);
  });
});

describe('embedded checkout widget is card-only — no billing-address form (FIX 3)', () => {
  // Peach Embedded Checkout SDK: customisations.card.showBillingFields
  // (default true) controls the billing-address form; it "overrides the
  // backend configuration". It is a WIDGET render option, NOT a
  // /v2/checkout POST field — so it cannot trip the V2 "unknown field"
  // body rejection, and it must NOT be added to the server createCheckout
  // body. PeachWidget is the single V2 host both Flow A call sites
  // (initiateCheckout + resumeFirstInstalmentCapture) render into.
  const WIDGET  = read('app/_components/PeachWidget.tsx');
  const ACTIONS = read('app/checkout/[token]/actions.ts');

  function actionBody(name: string): string {
    const startIdx = ACTIONS.indexOf(`export async function ${name}`);
    expect(startIdx).toBeGreaterThan(0);
    const rest       = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    return nextExport > 0 ? rest.slice(0, nextExport) : rest;
  }

  it('PeachWidget passes customisations.card.showBillingFields=false to Checkout.initiate', () => {
    // Pins that showBillingFields:false is the FIRST key of the card block
    // without requiring it to be the ONLY one. The previous pin ended in
    // `false\s*\}`, which silently depended on `card` having exactly one
    // key — so merging the widget theming/registration-copy work (which
    // added a sibling `...REGISTRATION_CARD_COPY` spread right after it,
    // and a `theme` block above) turned this red while the behaviour was
    // never broken. The behavioural counterpart is
    // PeachWidget.test.tsx's `renderLog[0].showBillingFields === false`,
    // which reads what actually reaches the SDK.
    expect(WIDGET).toMatch(/customisations:\s*\{[\s\S]{0,160}card:\s*\{\s*showBillingFields:\s*false\b/);
  });

  it('showBillingFields is NOT sent on the server /v2/checkout body (avoids the unknown-field reject)', () => {
    // Neither server action may put showBillingFields or a billing object
    // into the createCheckout params — it's a widget option only.
    expect(actionBody('initiateCheckout')).not.toMatch(/showBillingFields/);
    expect(actionBody('resumeFirstInstalmentCapture')).not.toMatch(/showBillingFields/);
    expect(actionBody('initiateCheckout')).not.toMatch(/billing:/);
    expect(actionBody('resumeFirstInstalmentCapture')).not.toMatch(/billing:/);
  });

  it('identity fields (email/givenName/surname) are STILL passed on both call sites', () => {
    for (const name of ['initiateCheckout', 'resumeFirstInstalmentCapture']) {
      const body = actionBody(name);
      expect(body).toMatch(/customer:\s*\{/);
      expect(body).toMatch(/email:/);
      expect(body).toMatch(/givenName:/);
      expect(body).toMatch(/surname:/);
    }
  });
});

describe('checkout completion classifies V2 status correctly (FIX 1: no false decline)', () => {
  // /checkout/[token]/complete fetches the V2 status, classifies
  // result.code, and: success → activate (save card + plan active),
  // pending → processing/poll (NOT a decline), decline → declined UI.
  // The false-decline fix lives in the shared classifier (resultCodes),
  // so BOTH this page and the webhook benefit; here we pin the wiring.
  const COMPLETE = read('app/checkout/[token]/complete/page.tsx');
  const POLL     = read('app/checkout/[token]/complete/PendingAutoRefresh.tsx');

  it('classifies via the shared classifier (which now covers risk-flagged successes)', () => {
    expect(COMPLETE).toMatch(/import \{ classifyResultCode \} from '@\/lib\/payments\/peach\/resultCodes'/);
    expect(COMPLETE).toMatch(/classifyResultCode\(status\.resultCode\)/);
  });

  it('logs the FULL raw V2 status response under a greppable tag', () => {
    expect(COMPLETE).toMatch(/console\.log\('PEACH CHECKOUT STATUS RESPONSE:'/);
    // The untouched V2 body must be in the log payload (only occurrence).
    expect(COMPLETE).toMatch(/raw:\s*status\.raw/);
  });

  it('pending → a processing state that POLLS (PendingAutoRefresh), never a decline', () => {
    // classified === 'pending' returns <PendingCard/> which mounts the
    // auto-refresh poller — not the ErrorCard.
    expect(COMPLETE).toMatch(/if \(classified === 'pending'\)\s*\{\s*return <PendingCard/);
    expect(COMPLETE).toMatch(/<PendingAutoRefresh\s*\/>/);
    // The poller reloads the page (re-runs getCheckoutStatus), bounded.
    expect(POLL).toMatch(/window\.location\.replace/);
    expect(POLL).toMatch(/MAX_RELOADS/);
  });

  it('rejected → the declined ErrorCard; success → plan activation via the shared helper', () => {
    expect(COMPLETE).toMatch(/if \(classified === 'rejected'\)\s*\{\s*return <ErrorCard/);
    // SUCCESS branch (below the pending/rejected returns) performs the
    // idempotent activation (instalment collected + plan active + payout
    // inserted) via the SAME shared activateFirstInstalment helper the
    // portal payment-complete route and the Peach webhook use — not its
    // own inline payments/plans writes. See payouts-gap.test.ts for the
    // dedicated regression coverage of this wiring.
    expect(COMPLETE).toMatch(
      /import\s*\{\s*activateFirstInstalment\s*\}\s*from\s*'@\/lib\/payments\/activateFirstInstalment'/,
    );
    expect(COMPLETE).toMatch(/await activateFirstInstalment\(/);
  });

  it('purpose gate uses peachRefPurpose(ref) === \'c\' (NOT the stale hnpl_co_ literal prefix)', () => {
    // The compact ref format is bnc<13> (purpose 'c'); the old
    // startsWith('hnpl_co_') guard falsely rejected every compact-ref
    // success AFTER classification said success. Gate SOLELY on the ref
    // purpose — the legacy hnpl_co_ fallback is removed (only compact refs
    // are minted now; any legacy session expired long ago).
    expect(COMPLETE).toMatch(/import \{ peachRefPurpose \} from '@\/lib\/payments\/peach\/refs'/);
    expect(COMPLETE).toMatch(/peachRefPurpose\(reference\) === 'c'/);
    // The legacy prefix must not appear at all in the gate now.
    expect(COMPLETE).not.toMatch(/startsWith\('hnpl_co_'\)/);
  });

  it('completion path reads NO customParameters (activation keys off merchantTransactionId → payment row)', () => {
    // Audit: none of SHOPPER_planId/paymentId/patientId/token are read on
    // the status path, so the bracketed-flat-key gotcha does not apply
    // here. The reference is the ONLY status field used to find the row.
    expect(COMPLETE).not.toMatch(/customParameters/);
    expect(COMPLETE).not.toMatch(/SHOPPER_/);
    expect(COMPLETE).toMatch(/\.eq\('peach_payment_id', reference\)/);
  });
});

describe('bill-amount floor is configurable + allows sandbox test totals (R276 / R184)', () => {
  const LIMITS      = read('lib/config/billAmountLimits.ts');
  const BILL_ACTION = read('app/practice/bills/new/actions.ts');
  const BILL_FORM   = read('app/practice/bills/new/BillForm.tsx');

  it('exposes MIN/MAX constants + isAllowedBillAmount from a single shared module', () => {
    expect(LIMITS).toMatch(/export const MIN_BILL_AMOUNT/);
    expect(LIMITS).toMatch(/export const MAX_BILL_AMOUNT/);
    expect(LIMITS).toMatch(/export function isAllowedBillAmount/);
    // Env-configurable (NEXT_PUBLIC_ so client + server read the same).
    expect(LIMITS).toMatch(/NEXT_PUBLIC_MIN_BILL_AMOUNT/);
    expect(LIMITS).toMatch(/NEXT_PUBLIC_MAX_BILL_AMOUNT/);
  });

  it('default floor is R1 (allows R184/R276; the old R500 floor is gone)', () => {
    // Default fallback is 1, not 500.
    expect(LIMITS).toMatch(/'NEXT_PUBLIC_MIN_BILL_AMOUNT',\s*1\s*\)/);
    // The hardcoded 500-floor comparison must be gone from BOTH
    // validators.
    expect(BILL_ACTION).not.toMatch(/billAmount < 500/);
    expect(BILL_FORM).not.toMatch(/billAmount >= 500/);
  });

  it('server + client both validate via the shared isAllowedBillAmount', () => {
    expect(BILL_ACTION).toMatch(/isAllowedBillAmount\(billAmount\)/);
    expect(BILL_FORM).toMatch(/isAllowedBillAmount\(billAmount\)/);
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
    // The confirm page now accepts pending_acceptance (fresh confirm) AND
    // pending_first_payment (resume of an abandoned saved-card one-click),
    // still owner-scoped by patient_id above.
    expect(CONFIRM_PAGE).toMatch(/\.in\(\s*['"]status['"]\s*,\s*\[\s*['"]pending_acceptance['"]\s*,\s*['"]pending_first_payment['"]\s*\]\s*\)/);
    // Non-owner / non-pending → maybeSingle → null → bounce.
    expect(CONFIRM_PAGE).toMatch(/if\s*\(!rawPlan\)\s*redirect\(\s*['"]\/patient\/orders['"]\s*\)/);
  });
});

describe('post-success UX — hero-first, skippable password, collapsed hand-off, widget sizing', () => {
  const DONE     = read('app/checkout/[token]/done/page.tsx');
  const PWFORM   = read('app/checkout/[token]/done/PasswordSetForm.tsx');
  const GLOBALS  = read('app/globals.css');
  const WIDGET   = read('app/_components/PeachWidget.tsx');
  const FORM_SRC = read('app/checkout/[token]/CheckoutForm.tsx');
  const LOGIN    = read('app/(auth)/login/page.tsx');

  // ── FIX 1: success is the hero; password is secondary + skippable ──

  it('success hero renders ABOVE the password form (confirmation is never buried)', () => {
    const heroIdx = DONE.indexOf('checkout-success-hero');
    const pwIdx   = DONE.indexOf('<PasswordSetForm');
    expect(heroIdx).toBeGreaterThan(0);
    expect(pwIdx).toBeGreaterThan(heroIdx);           // hero precedes password
    expect(DONE).toMatch(/Payment successful — your plan is active/);
    // Amount paid + remaining schedule + practice name are surfaced.
    expect(DONE).toMatch(/Paid today/);
    expect(DONE).toMatch(/data-testid="checkout-success-schedule"/);
    expect(DONE).toMatch(/\.from\('practices'\)/);
  });

  it('password step is skippable — "Skip for now" lands on /patient (dashboard)', () => {
    expect(PWFORM).toMatch(/data-testid="checkout-done-skip"/);
    expect(PWFORM).toMatch(/href="\/patient"/);
    // The password is now OPTIONAL, not the only exit.
    expect(PWFORM).toMatch(/Optional/);
    expect(PWFORM).not.toMatch(/ONLY way out/);
  });

  it('skip is not a lockout — /login offers password reset + passkey (no-password re-entry)', () => {
    // Email is confirmed for checkout accounts, so forgot-password always
    // works; passkey is the durable passwordless credential.
    expect(LOGIN).toMatch(/\/forgot-password/);
    expect(LOGIN).toMatch(/Sign in with a passkey/);
  });

  // ── FIX 2: widget sizing — full width, min-height floor, no inner scroll ──

  it('PeachWidget host carries the peach-embed sizing class', () => {
    expect(WIDGET).toMatch(/data-testid="peach-widget" className="peach-embed"/);
  });

  it('globals.css contains the injected widget within the mobile viewport (min-width reset + overflow-x contained), full-width, min-height floor, no fixed-height/nested-scroll clip', () => {
    // iframe: full-width, capped to the container, and min-width reset so an
    // SDK intrinsic/min width can't force it wider than a 360–390px phone.
    expect(GLOBALS).toMatch(/\.peach-embed iframe/);
    expect(GLOBALS).toMatch(/width:\s*100%\s*!important/);
    expect(GLOBALS).toMatch(/max-width:\s*100%\s*!important/);
    expect(GLOBALS).toMatch(/min-width:\s*0\s*!important/);
    expect(GLOBALS).toMatch(/min-height:\s*\d+px/);
    // Wrapper CONTAINS horizontal overflow rather than letting it spill to
    // the viewport (regression guard against the old `overflow: visible`).
    expect(GLOBALS).toMatch(/\.peach-embed\s*\{[^}]*overflow-x:\s*hidden/);
    expect(GLOBALS).not.toMatch(/\.peach-embed\s*\{[^}]*overflow:\s*visible/);
    // Still NO fixed-height clip and NO nested scrollbar.
    expect(GLOBALS).not.toMatch(/\.peach-embed[^}]*max-height/);
    expect(GLOBALS).not.toMatch(/\.peach-embed[^}]*overflow:\s*auto/);
  });

  // ── FIX 3: collapsed hand-off; consent preserved ──

  it('post-OTP hands off AUTOMATICALLY (no interstitial) to the single ResumeCapture confirm', () => {
    expect(FORM_SRC).toMatch(/onVerified=\{handleVerified\}/);
    expect(FORM_SRC).toMatch(/function handleVerified\(\)\s*\{[\s\S]{0,140}submitPay\(\)/);
    // Hand-off step is a loading state, not a confirm/pay screen.
    expect(FORM_SRC).toMatch(/data-testid="checkout-handoff-loading"/);
    expect(FORM_SRC).not.toMatch(/heading="Confirm and pay"/);
  });

  it('T&C consent capture preserved — the checkbox still gates on the Details step', () => {
    // Consent is a client-side required gate on Details (termsAccepted),
    // captured BEFORE account creation — unchanged. Since migration 0081
    // the acceptance is ALSO recorded server-side by initiateCheckout:
    // profiles.terms_accepted_at/terms_version on the profile upsert and
    // plans.terms_accepted_at/terms_version on the plan activation (pinned
    // in app/terms-acceptance.test.ts). The label now links to
    // /legal/terms.
    expect(FORM_SRC).toMatch(/id="checkout-termsAccepted"/);
    expect(FORM_SRC).toMatch(/checked=\{details\.termsAccepted\}/);
    expect(FORM_SRC).toMatch(/Please accept the payment-plan terms/);
  });
});
