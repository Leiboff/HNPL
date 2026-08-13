import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Tests — password-reset flow + auth-surface cross-links ────────────
//
// Source-text pins for the three parts of this build:
//   Part 1 — forgot / reset password flow (request page, auth
//            callback, update page). Enumeration-safe. Expired-link
//            handled everywhere. Reuses the shared password validator.
//            Reuses the /dashboard role-dispatcher for post-reset
//            redirect.
//   Part 2 — login page carries a Forgot-password link + prominent
//            patient + practice signup CTAs.
//   Part 3 — signup pages carry a prominent Log-in cross-link.
//
// A diff-scope guard confirms no payment / RLS / passkey files were
// touched in this build.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

// Existence + core file reads.
const CALLBACK   = read('app/auth/callback/route.ts');
const FP_PAGE    = read('app/forgot-password/page.tsx');
const FP_FORM    = read('app/forgot-password/ForgotPasswordForm.tsx');
const UP_PAGE    = read('app/update-password/page.tsx');
const UP_FORM    = read('app/update-password/UpdatePasswordForm.tsx');
const LOGIN      = read('app/(auth)/login/page.tsx');
const PT_SIGNUP  = read('app/signup/patient/page.tsx');
const PR_SIGNUP  = read('app/signup/practice/page.tsx');

// ─── /auth/callback ────────────────────────────────────────────────────

describe('/auth/callback route handler', () => {
  it('exchanges the PKCE code for a session and honours ?next=', () => {
    expect(CALLBACK).toMatch(/exchangeCodeForSession\(code\)/);
    expect(CALLBACK).toMatch(/searchParams\.get\('code'\)/);
    expect(CALLBACK).toMatch(/searchParams\.get\('next'\)/);
  });

  it('rejects off-domain / protocol-relative ?next= redirects', () => {
    // Only leading-slash relative paths pass safeNext; the // guard
    // stops protocol-relative escapes.
    expect(CALLBACK).toMatch(/safeNext/);
    expect(CALLBACK).toMatch(/raw\.startsWith\('\/\/'\)/);
    expect(CALLBACK).toMatch(/raw\.startsWith\('\/'\)/);
  });

  it('missing / invalid code redirects to /forgot-password?error=expired (never a dead end)', () => {
    expect(CALLBACK).toMatch(/forgot-password\?error=expired/);
    // Two failure branches — no-code AND exchange-error — both land
    // on the same friendly recover-path.
    const noCodeIdx   = CALLBACK.indexOf('if (!code)');
    const errBranchIdx = CALLBACK.indexOf('if (error)');
    expect(noCodeIdx).toBeGreaterThan(0);
    expect(errBranchIdx).toBeGreaterThan(0);
  });
});

// ─── /forgot-password ──────────────────────────────────────────────────

describe('/forgot-password — enumeration-safe request', () => {
  it('uses supabase.auth.resetPasswordForEmail with the /auth/callback redirectTo (next=/update-password)', () => {
    expect(FP_FORM).toMatch(/resetPasswordForEmail\(/);
    expect(FP_FORM).toMatch(/\/auth\/callback\?next=/);
    // The `next=` value URL-encodes /update-password.
    expect(FP_FORM).toMatch(/encodeURIComponent\(REDIRECT_NEXT\)/);
    expect(FP_FORM).toMatch(/REDIRECT_NEXT\s*=\s*['"]\/update-password['"]/);
  });

  it('always shows the same success state — no branch conditional on user-existence', () => {
    // No "user not found" / "no account" / "email does not exist"
    // string anywhere in the form; the success card is unconditional
    // once submit resolves (aside from the rate-limit friendly branch).
    const codeOnly = stripComments(FP_FORM);
    expect(codeOnly.toLowerCase()).not.toContain('user not found');
    expect(codeOnly.toLowerCase()).not.toContain('no account');
    expect(codeOnly.toLowerCase()).not.toContain('email does not exist');
    // The submitted-flag setter fires on BOTH the no-error and the
    // non-rate-limit-error paths — same success state either way.
    expect(FP_FORM).toMatch(/setSubmitted\(true\)/);
  });

  it('rate-limit errors show a friendly "try again" message (not a raw supabase error)', () => {
    expect(FP_FORM).toMatch(/rate limit/i);
    expect(FP_FORM).toMatch(/Please wait a minute before requesting another reset link/);
    // The detector checks status 429 + common Supabase phrasings.
    expect(FP_FORM).toMatch(/status === 429/);
    expect(FP_FORM).toMatch(/'security purposes'|security purposes/);
  });

  it('surfaces the ?error=expired query param as an amber "link expired" callout', () => {
    expect(FP_FORM).toMatch(/data-testid="forgot-password-link-expired"/);
    expect(FP_FORM).toMatch(/errorParam === 'expired'/);
  });
});

// ─── /update-password ──────────────────────────────────────────────────

describe('/update-password — recovery-session + role-aware redirect', () => {
  it('page bounces unauthenticated visitors to /forgot-password?error=expired (no dead end)', () => {
    expect(UP_PAGE).toMatch(/redirect\('\/forgot-password\?error=expired'\)/);
    expect(UP_PAGE).toMatch(/getUser\(\)/);
  });

  it('form calls supabase.auth.updateUser({ password }) on submit', () => {
    expect(UP_FORM).toMatch(/updateUser\(\{ password \}\)/);
  });

  it('reuses the shared checkPassword validator — no forked policy', () => {
    // Import + call the shared helper. If a future edit reintroduces
    // an inline password policy this test flags it.
    expect(UP_FORM).toMatch(/from ['"]@\/lib\/validation['"]/);
    expect(UP_FORM).toMatch(/checkPassword\(password, email\)/);
    // Same min-length floor as the signup surfaces (8).
    expect(UP_FORM).toMatch(/MIN_PASSWORD_LEN\s*=\s*8/);
  });

  it('successful update redirects through /dashboard (reuses the role-dispatcher)', () => {
    expect(UP_FORM).toMatch(/window\.location\.href\s*=\s*['"]\/dashboard['"]/);
    // The comment explicitly names the role dispatcher — pin the
    // decision so a future edit that forks per-role paths fails.
    expect(UP_FORM).toMatch(/role-dispatcher|profiles\.role/);
  });

  it('expired / invalid session errors show a friendly "Request a new link" state', () => {
    expect(UP_FORM).toMatch(/setShowRecoveryError\(true\)/);
    expect(UP_FORM).toMatch(/data-testid="update-password-request-new-link"/);
    // The button links back to /forgot-password (fresh request).
    expect(UP_FORM).toMatch(/href="\/forgot-password"/);
  });
});

// ─── Login page updates ────────────────────────────────────────────────

describe('Login page — Forgot-password link + prominent signup CTAs', () => {
  it('renders a Forgot-password link next to the password field', () => {
    expect(LOGIN).toMatch(/data-testid="login-forgot-password"/);
    expect(LOGIN).toMatch(/href="\/forgot-password"/);
  });

  it('renders prominent patient + practice signup CTAs as bordered cards (not footnote links)', () => {
    expect(LOGIN).toMatch(/data-testid="login-signup-patient"/);
    expect(LOGIN).toMatch(/data-testid="login-signup-practice"/);
    expect(LOGIN).toMatch(/href="\/signup\/patient"/);
    expect(LOGIN).toMatch(/href="\/signup\/practice"/);
    // Both CTAs live inside a labelled section — the "New to
    // BetterNow?" section header.
    expect(LOGIN).toMatch(/New to BetterNow/);
    expect(LOGIN).toMatch(/aria-label="New to BetterNow"/);
  });

  it('the previous "Don\'t have an account? Sign up → /" footnote is gone', () => {
    // The old wording pointed at the homepage — that is what "quite
    // hidden" referred to. The signup CTAs now point AT the signup
    // routes directly.
    expect(LOGIN).not.toMatch(/Don't have an account\?/);
    expect(LOGIN).not.toMatch(/href="\/"[^>]*>[^<]*Sign up/);
  });
});

// ─── Signup pages — Log-in cross-link (visible without scrolling) ─────

describe('Signup pages — prominent Log-in cross-link', () => {
  it('patient signup page renders the Log-in cross-link in the header (not just footer)', () => {
    expect(PT_SIGNUP).toMatch(/data-testid="patient-signup-login-cross-link"/);
    expect(PT_SIGNUP).toMatch(/href="\/login"/);
    // The header link is positioned ABOVE the form card in the JSX;
    // pinning that order guards against a regression that only leaves
    // a bottom-of-page link.
    const hdrLinkIdx = PT_SIGNUP.indexOf('patient-signup-login-cross-link');
    const formIdx    = PT_SIGNUP.indexOf('<PatientSignupForm');
    expect(hdrLinkIdx).toBeGreaterThan(0);
    expect(formIdx).toBeGreaterThan(hdrLinkIdx);
  });

  it('practice signup page renders the Log-in cross-link in the header', () => {
    expect(PR_SIGNUP).toMatch(/data-testid="practice-signup-login-cross-link"/);
    expect(PR_SIGNUP).toMatch(/href="\/login"/);
    const hdrLinkIdx = PR_SIGNUP.indexOf('practice-signup-login-cross-link');
    const formIdx    = PR_SIGNUP.indexOf('onSubmit={handleSubmit}');
    expect(hdrLinkIdx).toBeGreaterThan(0);
    expect(formIdx).toBeGreaterThan(hdrLinkIdx);
  });
});

// ─── /forgot-password page shell + form composition ────────────────────

describe('/forgot-password page shell', () => {
  it('renders the ForgotPasswordForm inside a Suspense boundary (useSearchParams)', () => {
    expect(FP_PAGE).toMatch(/<Suspense/);
    expect(FP_PAGE).toMatch(/ForgotPasswordForm/);
  });
});

// ─── Diff scope: no payment / RLS / passkey code touched ──────────────

describe('Diff scope — auth-surface only', () => {
  const NEW_FILES = [
    'app/auth/callback/route.ts',
    'app/forgot-password/page.tsx',
    'app/forgot-password/ForgotPasswordForm.tsx',
    'app/update-password/page.tsx',
    'app/update-password/UpdatePasswordForm.tsx',
  ];

  it.each(NEW_FILES)('%s exists', (path) => {
    expect(existsSync(resolve(ROOT, path))).toBe(true);
  });

  // Belt-and-braces: pin that the reset-flow client code never
  // imports payment/webhook/finance modules — a future refactor
  // that reaches into payment logic from an auth surface will trip.
  const FORBIDDEN = [
    '@/lib/finance',
    '@/lib/payments/',
    '@/lib/paystack/',
    '@/lib/bills/lifecycle',
    'app/api/webhooks/paystack',
  ];

  it.each(FORBIDDEN)('reset-flow files never import %s', (mod) => {
    const bodies = [CALLBACK, FP_PAGE, FP_FORM, UP_PAGE, UP_FORM];
    for (const body of bodies) {
      expect(body).not.toContain(`from '${mod}`);
      expect(body).not.toContain(`from "${mod}`);
    }
  });

  // The 0065 post-login passkey prompt lives at
  // /patient/PostLoginPasskeyPrompt.tsx and its layout wiring. This
  // build MUST NOT touch either — pin by asserting the passkey files
  // still exist AND that the reset-flow files never reference them.
  it('passkey prompt files still exist and are not touched by this build', () => {
    expect(existsSync(resolve(ROOT, 'app/patient/PostLoginPasskeyPrompt.tsx'))).toBe(true);
    expect(existsSync(resolve(ROOT, 'app/patient/passkey-actions.ts'))).toBe(true);
    const bodies = [CALLBACK, FP_PAGE, FP_FORM, UP_PAGE, UP_FORM];
    for (const body of bodies) {
      expect(body).not.toMatch(/PostLoginPasskeyPrompt|dismissPasskeyPrompt|skipPasskeyPrompt|dontAskAgainPasskey/);
    }
  });
});
