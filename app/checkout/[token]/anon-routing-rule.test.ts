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
    // Widened window: the uncaptured branch now also fetches the full
    // schedule + prior-attempt signal before the else-redirect, so
    // redirect(confirmPath) sits further down.
    const chunk = PAGE.slice(idx, idx + 4000);
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
    // The capture runs through runCapture(reuse), which passes the flag
    // as reuseExisting. Auto-start calls runCapture(true) (reuse the
    // stamped checkout); re-entry calls runCapture(false) (mint fresh).
    expect(RESUME_UI).toMatch(/resumeAction\(token,\s*\{\s*reuseExisting:\s*reuse\s*\}\)/);
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

describe('checkout shows exactly ONE "Confirm and pay" before the widget (no double confirm)', () => {
  // Before: CheckoutForm's Pay tap → initiateCheckout signs the patient
  // in (mutates cookies) → /checkout/[token] re-renders as the signed-in-
  // owner uncaptured-plan branch → ResumeCapture, a SECOND near-identical
  // "Confirm and pay". The patient saw two confirms then the widget.
  //
  // After: CheckoutForm no longer mounts the widget itself. On a
  // successful initiate it hands off with router.replace(?capture=auto);
  // page.tsx reads that param and passes autoStart to ResumeCapture,
  // which fires the capture immediately and mounts the widget — no second
  // confirm. Plain re-entry (no param) still shows one confirm → widget.
  const FORM_SRC   = read('app/checkout/[token]/CheckoutForm.tsx');
  const PAGE_SRC   = read('app/checkout/[token]/page.tsx');
  const RESUME_UI  = read('app/checkout/[token]/ResumeCapture.tsx');

  it('CheckoutForm no longer mounts PeachWidget inline (that was the source of the 2nd confirm/widget)', () => {
    expect(FORM_SRC).not.toMatch(/from ['"]@\/app\/_components\/PeachWidget['"]/);
    expect(FORM_SRC).not.toMatch(/<PeachWidget/);
    // The inline widget state is gone.
    expect(FORM_SRC).not.toMatch(/setWidget/);
  });

  it('CheckoutForm hands off to the single confirm+widget surface via router.replace(?capture=auto)', () => {
    expect(FORM_SRC).toMatch(/useRouter/);
    expect(FORM_SRC).toMatch(/router\.replace\(`\/checkout\/\$\{token\}\?capture=auto`\)/);
  });

  it('page.tsx reads ?capture=auto and forwards it as autoStart to ResumeCapture', () => {
    expect(PAGE_SRC).toMatch(/searchParams/);
    expect(PAGE_SRC).toMatch(/sp\.capture === 'auto'/);
    expect(PAGE_SRC).toMatch(/autoStart=\{autoStartCapture\}/);
  });

  it('ResumeCapture auto-fires the capture once on mount when autoStart (skips its own confirm)', () => {
    expect(RESUME_UI).toMatch(/autoStart/);
    // Fires start() from an effect, guarded against double-invoke.
    expect(RESUME_UI).toMatch(/autoFiredRef/);
    expect(RESUME_UI).toMatch(/useEffect\(/);
    // The auto-start path renders a "setting up" placeholder, NOT the
    // confirm chrome — so the confirm never shows in the hand-off case.
    expect(RESUME_UI).toMatch(/resume-capture-autostarting/);
  });

  it('re-entry (no ?capture=auto) still shows the single confirm → widget (autoStart=false path)', () => {
    // The confirm view + button remain for the non-autoStart case.
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-button"/);
    expect(RESUME_UI).toMatch(/Confirm and pay/);
    // autoStart is a required prop, so page.tsx must pass it (true only
    // on the hand-off); default rendering is the confirm.
    expect(RESUME_UI).toMatch(/autoStart:\s*boolean/);
  });
});

describe('new-customer signup makes exactly ONE createCheckout (auto-start reuses, does not re-mint)', () => {
  // Before: the new-customer path called createCheckout TWICE — once in
  // initiateCheckout (CheckoutForm's Pay), then again in the auto-start
  // resumeFirstInstalmentCapture after the ?capture=auto hand-off —
  // deduped to one real transaction only by the deterministic
  // merchantTransactionId. On a money path the normal flow should make
  // ONE checkout call, not two-that-dedup.
  //
  // After: the auto-start hand-off carries reuseExisting=true. The
  // resume action detects the checkout initiateCheckout already minted
  // + stamped on the instalment-1 row (peach_checkout_id) and MOUNTS
  // THE WIDGET ON THAT SAME CHECKOUT — no second createCheckout. A
  // genuine re-entry (reuseExisting=false) still mints fresh (the
  // stored checkout is past its validity window). The deterministic
  // ref stays as the safety net for the mint path only.
  const ACTIONS   = read('app/checkout/[token]/actions.ts');
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  function resumeBody(): string {
    const startIdx = ACTIONS.indexOf('export async function resumeFirstInstalmentCapture');
    expect(startIdx).toBeGreaterThan(0);
    const rest       = ACTIONS.slice(startIdx);
    const nextExport = rest.indexOf('\nexport ', 1);
    return nextExport > 0 ? rest.slice(0, nextExport) : rest;
  }

  it('resumeFirstInstalmentCapture accepts a reuseExisting option', () => {
    expect(ACTIONS).toMatch(/export async function resumeFirstInstalmentCapture\(\s*token:\s*string\s*,\s*opts\?:\s*\{\s*reuseExisting\?:\s*boolean\s*\}/);
    const body = resumeBody();
    expect(body).toMatch(/const reuseExisting = opts\?\.reuseExisting === true/);
  });

  it('reads the already-stamped peach_checkout_id off the instalment-1 row', () => {
    const body = resumeBody();
    // The instalment-1 select now includes peach_checkout_id (the id
    // initiateCheckout stamped) so the reuse branch has something to
    // reuse.
    expect(body).toMatch(/select\(\s*['"]id,\s*amount,\s*peach_checkout_id['"]\s*\)/);
    expect(body).toMatch(/const existingCheckoutId = \(payment\.peach_checkout_id as string \| null\) \?\? null/);
  });

  it('reuse branch mounts the SAME checkout (no createCheckout) when reuseExisting + a stamped id exist', () => {
    const body = resumeBody();
    // The mint call is now GATED behind the else of the reuse branch —
    // so the auto-start (reuseExisting=true) path skips it entirely.
    expect(body).toMatch(/if\s*\(reuseExisting && existingCheckoutId\)\s*\{\s*checkoutId = existingCheckoutId;/);
    // createCheckout still exists (for the mint/re-entry branch) but
    // sits inside the else.
    const reuseIdx = body.indexOf('if (reuseExisting && existingCheckoutId)');
    const mintIdx  = body.indexOf('provider.createCheckout');
    expect(reuseIdx).toBeGreaterThan(0);
    expect(mintIdx).toBeGreaterThan(reuseIdx);
    // The createCheckout lives under an `else {` opened after the reuse
    // branch — proving it's skipped on reuse.
    const between = body.slice(reuseIdx, mintIdx);
    expect(between).toMatch(/\}\s*else\s*\{/);
  });

  it('ResumeCapture reuses on auto-start (runCapture(true)) and mints on re-entry (runCapture(false))', () => {
    // Auto-start fires runCapture(true) → reuseExisting=true → reuse the
    // stamped checkout. Re-entry's manual button fires runCapture(false)
    // → mint fresh. runCapture threads the flag as reuseExisting.
    expect(RESUME_UI).toMatch(/resumeAction\(token,\s*\{\s*reuseExisting:\s*reuse\s*\}\)/);
    // Auto-start effect uses reuse=true (both the first attempt and the
    // single automatic retry).
    expect(RESUME_UI).toMatch(/runCapture\(true\)/);
    // Re-entry confirm button mints fresh.
    expect(RESUME_UI).toMatch(/runCapture\(false\)/);
  });

  it('the deterministic ref stays as the mint-path safety net (not removed)', () => {
    const body = resumeBody();
    // checkoutRef(payment.id) is still built — it dedups a mid-flight
    // double-mint on the re-entry path.
    expect(body).toMatch(/checkoutRef\(payment\.id as string\)/);
  });
});

describe('auto-start failure never degrades into a second confirm (FIX 1: retry then inline error)', () => {
  // Observed: new customer taps Pay → ?capture=auto hand-off hit a
  // transient Peach/network failure → user was dropped on the manual
  // "Confirm and pay" surface (the second confirm), which then worked on
  // a second tap. The double-confirm we removed was still reachable via
  // the auto-start ERROR path. Fix: retry once automatically (reuse path
  // is idempotent), then show a COMPACT inline error + single "Try again"
  // — never the full confirm chrome.
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  it('the ENTIRE autoStart case is handled before the manual confirm view (confirm unreachable on hand-off)', () => {
    // A single `if (autoStart) { ... return ... }` wraps both the
    // in-flight placeholder and the error card, and always returns — so
    // execution never reaches the manual confirm markup when autoStart.
    expect(RESUME_UI).toMatch(/if \(autoStart\)\s*\{/);
    // The manual confirm button lives AFTER (below) the autoStart block.
    const autoIdx    = RESUME_UI.indexOf('if (autoStart) {');
    const confirmIdx = RESUME_UI.indexOf('data-testid="resume-capture-button"');
    expect(autoIdx).toBeGreaterThan(0);
    expect(confirmIdx).toBeGreaterThan(autoIdx);
  });

  it('retries the capture ONCE automatically on failure before surfacing anything', () => {
    // The effect fires runCapture(true), and on failure retries
    // runCapture(true) a second time after a backoff, only THEN setting
    // the terminal autoFailed flag.
    expect(RESUME_UI).toMatch(/AUTO_RETRY_DELAY_MS/);
    expect(RESUME_UI).toMatch(/setTimeout\(resolve, AUTO_RETRY_DELAY_MS\)/);
    expect(RESUME_UI).toMatch(/setAutoFailed\(true\)/);
    // Two runCapture(true) calls in the effect (attempt + retry) — count
    // occurrences to prove the retry exists.
    const reuseCalls = RESUME_UI.match(/runCapture\(true\)/g) ?? [];
    expect(reuseCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('terminal failure renders a compact error + "Try again" (NOT the manual confirm heading)', () => {
    // The autoFailed branch shows the error alert + a retry button whose
    // handler re-fires the reuse capture — and crucially does NOT render
    // the "Confirm and pay" heading (that heading is only in the
    // non-autoStart manual view).
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-autostart-error"/);
    expect(RESUME_UI).toMatch(/data-testid="resume-capture-retry"/);
    expect(RESUME_UI).toMatch(/retryAutoStart/);
    // The error card block must not contain the confirm heading text —
    // slice from the autostart-error testid to the next return.
    const errIdx = RESUME_UI.indexOf('resume-capture-autostart-error');
    const card   = RESUME_UI.slice(errIdx, errIdx + 900);
    expect(card).not.toMatch(/Confirm and pay/);
  });

  it('retryAutoStart re-fires the reuse capture (idempotent — same checkoutId/ref, no double-charge)', () => {
    // The manual Try-again handler calls runCapture(true) → reuseExisting
    // true → the resume action reuses the stamped checkoutId (or, in the
    // fallback-mint case, the deterministic ref dedups). A retry cannot
    // create a second checkout or double-charge.
    const idx  = RESUME_UI.indexOf('async function retryAutoStart');
    expect(idx).toBeGreaterThan(0);
    const body = RESUME_UI.slice(idx, idx + 300);
    expect(body).toMatch(/runCapture\(true\)/);
  });
});

describe('pre-card confirm copy does not claim a charge is already in progress (FIX 2)', () => {
  // The pre-card confirm screen previously read "CHARGING YOUR CARD NOW"
  // before any card had been entered. Both the fresh CheckoutForm confirm
  // step AND the ResumeCapture re-entry confirm are pre-card screens —
  // neither may claim a charge is happening.
  const FORM_SRC  = read('app/checkout/[token]/CheckoutForm.tsx');
  const RESUME_UI = read('app/checkout/[token]/ResumeCapture.tsx');

  it('CheckoutForm confirm step no longer says "charging your card now"', () => {
    expect(FORM_SRC).not.toMatch(/[Cc]harging your card now/);
    expect(FORM_SRC).toMatch(/First instalment — due today/);
  });

  it('ResumeCapture confirm no longer says "charging your card now"', () => {
    expect(RESUME_UI).not.toMatch(/[Cc]harging your card now/);
    expect(RESUME_UI).toMatch(/First instalment — due today/);
  });

  it('the CTA still commits to paying today (unchanged)', () => {
    // "Pay Rx today" remains the button copy on both surfaces.
    expect(FORM_SRC).toMatch(/Pay \$\{formatRand\(instalments\[0\]\)\} today/);
    expect(RESUME_UI).toMatch(/Pay \$\{formatRand\(firstInstalmentAmount\)\} today/);
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
    expect(WIDGET).toMatch(/customisations:\s*\{[\s\S]{0,80}card:\s*\{\s*showBillingFields:\s*false\s*\}/);
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
    expect(CONFIRM_PAGE).toMatch(/\.eq\(\s*['"]status['"]\s*,\s*['"]pending_acceptance['"]\s*\)/);
    // Non-owner / non-pending → maybeSingle → null → bounce.
    expect(CONFIRM_PAGE).toMatch(/if\s*\(!rawPlan\)\s*redirect\(\s*['"]\/patient\/orders['"]\s*\)/);
  });
});
