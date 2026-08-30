import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Google OAuth (patients) — source-text pins ────────────────────────
//
// Additive Google sign-in for patients only. Shape:
//
//   1. Button renders on /login (with "For patients" caption) and on
//      /signup/patient. NOT on /signup/practice (staff invite-only).
//   2. signInWithOAuth('google') with a redirectTo that reuses the
//      existing /auth/callback and a hardcoded ?next=/dashboard so
//      the callback's safeNext clamp cannot be tampered with.
//   3. /auth/callback exchanges the code (unchanged) AND runs an
//      OAuth profile-sync fixup that fills in first_name/last_name
//      from user_metadata (Google emits given_name/family_name) —
//      idempotent, never overwrites role, defensive against the
//      profile trigger missing.
//   4. Dispatcher (/dashboard) still routes by profile.role; Google
//      sign-ins funnel through it just like email/password.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const BUTTON      = read('app/_components/ContinueWithGoogleButton.tsx');
const CALLBACK    = read('app/auth/callback/route.ts');
const LOGIN       = read('app/(auth)/login/page.tsx');
const PT_SIGNUP_F = read('app/signup/patient/PatientSignupForm.tsx');
const PR_SIGNUP   = read('app/signup/practice/page.tsx');
const DISPATCHER  = read('app/dashboard/page.tsx');

// ─── Button component ────────────────────────────────────────────────

describe('ContinueWithGoogleButton — Google OAuth initiation', () => {
  it('calls supabase.auth.signInWithOAuth with provider: google', () => {
    expect(BUTTON).toMatch(/signInWithOAuth\(\s*\{[\s\S]*?provider:\s*['"]google['"]/);
  });

  it('sends the user back through /auth/callback with a safeNext-clamped next param', () => {
    // Post-2026-07-30 the button accepts an optional `next` prop so
    // the /checkout/[token] anonymous-only routing rule can carry a
    // safeNext-validated destination (e.g. /patient/orders/{id}/confirm)
    // across the OAuth round trip. Both ends validate:
    //   • the button's own safeNext() clamps to /dashboard when the
    //     prop is missing, non-relative, or protocol-relative.
    //   • /auth/callback::safeNext re-validates the returned param.
    //
    // Pin the URL shape (variable, no longer a literal), the local
    // safeNext validator, and the encodeURIComponent wrap. The button
    // still forbids reading URLSearchParams directly — the value is
    // always caller-supplied via a prop, never a raw window read.
    expect(BUTTON).toMatch(/\/auth\/callback\?next=\$\{encodeURIComponent\(nextParam\)\}/);
    expect(BUTTON).toMatch(/function safeNext/);
    expect(BUTTON).toMatch(/const DEFAULT = ['"]\/dashboard['"]/);
    // The button MUST NOT read the URL directly — its `next` prop is
    // caller-controlled + validated.
    expect(BUTTON).not.toMatch(/window\.location\.search|new URLSearchParams/);
  });

  it('uses the SSR browser client', () => {
    expect(BUTTON).toMatch(/from ['"]@\/lib\/supabase\/client['"]/);
  });

  it('honours Google branding — white background, uncoloured "G" glyph, standard label', () => {
    // No brand-navy/teal gradient on the button surface.
    expect(BUTTON).not.toMatch(/linear-gradient\(135deg,\s*#13294B/);
    // The label defaults to Google's approved wording.
    expect(BUTTON).toMatch(/label = ['"]Continue with Google['"]/);
    // 4-colour "G" glyph — pin the Google colours are all present.
    expect(BUTTON).toMatch(/#4285F4/);
    expect(BUTTON).toMatch(/#34A853/);
    expect(BUTTON).toMatch(/#FBBC05/);
    expect(BUTTON).toMatch(/#EA4335/);
  });

  it('exposes a stable testid for wiring pins', () => {
    expect(BUTTON).toMatch(/data-testid="continue-with-google"/);
  });
});

// ─── Placement (patient-only) ────────────────────────────────────────

describe('Placement — patient surfaces only', () => {
  it('/login renders the Google block', () => {
    expect(LOGIN).toMatch(/from ['"]@\/app\/_components\/ContinueWithGoogleButton['"]/);
    expect(LOGIN).toMatch(/<ContinueWithGoogleButton\b/);
    expect(LOGIN).toMatch(/data-testid="login-google-block"/);
    // The "For patients" caption that used to sit with this button was
    // removed with the auth redesign — see the note on the
    // practice-dashboard-ux suite. Google being a patient path in
    // practice is still true and still enforced where it matters (staff
    // are invite-provisioned, and /auth/callback never rewrites a role);
    // it is simply no longer narrated in the UI.
  });

  it('the email signup form does NOT offer Google — the chooser does', () => {
    // WAS: pinned the Google block above the form on /signup/patient.
    //
    // That form is now reached by choosing "Sign up with email" on the
    // /signup chooser, where Google sits beside it. Offering it again
    // inside the form re-asks a question the visitor answered one screen
    // earlier. The block is gone from the form and the chooser is now
    // the single place the methods compete.
    // Match the IMPORT and the JSX, not prose — the note left where the
    // block used to be names the component to explain its absence, and a
    // bare substring check would forbid the file explaining itself.
    expect(PT_SIGNUP_F).not.toMatch(/^import .*ContinueWithGoogleButton/m);
    expect(PT_SIGNUP_F).not.toMatch(/<ContinueWithGoogleButton/);
    expect(PT_SIGNUP_F).not.toMatch(/data-testid="patient-signup-google-block"/);
    const ENTRY = read('app/(auth)/signup/SignupEntry.tsx');
    expect(ENTRY).toMatch(/<ContinueWithGoogleButton/);
  });

  it('/signup/practice does NOT render the Google button (staff = email/password)', () => {
    expect(PR_SIGNUP).not.toMatch(/ContinueWithGoogleButton/);
    expect(PR_SIGNUP).not.toMatch(/signInWithOAuth/);
  });
});

// ─── /auth/callback: OAuth handling + profile sync ────────────────────

describe('/auth/callback — reuses PKCE exchange; adds OAuth profile-sync', () => {
  it('still calls exchangeCodeForSession and honours safeNext', () => {
    expect(CALLBACK).toMatch(/exchangeCodeForSession\(code\)/);
    expect(CALLBACK).toMatch(/function safeNext/);
    // A raw `next` value that starts with `//` (protocol-relative) is
    // rejected — pin the guard.
    expect(CALLBACK).toMatch(/raw\.startsWith\(['"`]\/\/['"`]\)/);
  });

  it('defines ensureOAuthProfileSynced and calls it only for OAuth users', () => {
    expect(CALLBACK).toMatch(/async function ensureOAuthProfileSynced/);
    // The check that gates the sync — user has at least one non-email
    // identity (i.e. OAuth provider).
    expect(CALLBACK).toMatch(/identities\.some\(\(i\)\s*=>\s*i\.provider\s*!==\s*['"]email['"]\)/);
    // ensureOAuthProfileSynced is invoked from the callback after the
    // exchange succeeds — pin the CALL site (which uses `await` and
    // passes user.id), not the function definition higher in the file.
    const exchangeIdx = CALLBACK.indexOf('exchangeCodeForSession(code)');
    const syncIdx     = CALLBACK.indexOf('await ensureOAuthProfileSynced(');
    expect(exchangeIdx).toBeGreaterThan(0);
    expect(syncIdx).toBeGreaterThan(exchangeIdx);
  });

  it('extractOAuthName reads given_name/family_name (Google) with sensible fallbacks', () => {
    expect(CALLBACK).toMatch(/md\.given_name/);
    expect(CALLBACK).toMatch(/md\.family_name/);
    // Fallbacks: first_name/last_name (other providers), then
    // full_name/name split on first space.
    expect(CALLBACK).toMatch(/md\.first_name/);
    expect(CALLBACK).toMatch(/md\.last_name/);
    expect(CALLBACK).toMatch(/md\.full_name/);
  });

  it('never overwrites existing role or non-empty name fields (idempotent)', () => {
    // The sync only fills name fields WHEN THEY'RE CURRENTLY EMPTY.
    expect(CALLBACK).toMatch(/if\s*\(!profile\.first_name\s*&&\s*names\.first\)/);
    expect(CALLBACK).toMatch(/if\s*\(!profile\.last_name\s*&&\s*names\.last\)/);
    // No `role:` in the UPDATE payload — a Google sign-in never
    // demotes an existing staff account.
    const scope = CALLBACK.slice(CALLBACK.indexOf('async function ensureOAuthProfileSynced'));
    const updateMatch = scope.match(/\.update\(\s*(updates|\{[\s\S]*?\})\s*\)/);
    expect(updateMatch).not.toBeNull();
    // The updates object only ever gets first_name / last_name keys —
    // pin that no other column ever ends up in it.
    const allSetsInScope = scope.match(/updates\.\w+/g) ?? [];
    for (const setter of allSetsInScope) {
      const col = setter.replace('updates.', '');
      expect(['first_name', 'last_name']).toContain(col);
    }
  });

  it('provisions a defensive profile row (role=patient) if the trigger somehow missed', () => {
    // The insert branch handles the "trigger didn't fire" edge case.
    // Ensure the fallback insert defaults role='patient'.
    expect(CALLBACK).toMatch(/role:\s*['"]patient['"]/);
    // Uses service-role for the write (session client can't
    // insert into another user's row under standard RLS).
    expect(CALLBACK).toMatch(/createServiceClient/);
  });

  it('sync failures now fail CLOSED — no acceptance on record, no session', () => {
    // This used to pin the opposite: the try/catch swallowed the error
    // and redirected to /dashboard anyway, so a fixup failure never
    // stranded anyone. That was right while the sync only filled in
    // display names.
    //
    // The same code path now decides whether the customer's T&C
    // acceptance was recorded, and "we don't know" has to mean "no" —
    // otherwise a thrown error is a way INTO the app with nothing
    // agreed to. The try/catch is still there; what changed is that the
    // catch refuses instead of shrugging.
    const scope = CALLBACK.slice(CALLBACK.indexOf('exchangeCodeForSession(code)'));
    expect(scope).toMatch(/try\s*\{[\s\S]*?ensureOAuthProfileSynced\([\s\S]*?\}\s*catch/);
    expect(scope).toMatch(/outcome = 'write-failed';/);
    expect(scope).toMatch(/if \(outcome !== 'ok'\)/);
    expect(scope).toMatch(/await supabase\.auth\.signOut\(\)/);
    expect(scope).not.toMatch(/non-blocking\)/);
  });

  it('the name-sync half is still non-blocking — it costs a display name, not a session', () => {
    // The distinction the fail-closed rule must not flatten: an empty
    // first_name is recoverable from account settings, a missing legal
    // record is not. Only the acceptance write refuses.
    const scope = CALLBACK.slice(CALLBACK.indexOf('async function ensureOAuthProfileSynced'));
    expect(scope).toMatch(/if \(!needsAcceptance\) \{[\s\S]*?name sync failed \(non-blocking\)[\s\S]*?return 'ok';/);
  });
});

// ─── Dispatcher unchanged (Google funnels through /dashboard) ─────────

describe('Dispatcher — Google sign-ins funnel through the same role router', () => {
  it('/dashboard still routes on profile.role → /patient / /brand / /practice / /provider / /admin', () => {
    expect(DISPATCHER).toMatch(/case ['"]patient['"]:/);
    expect(DISPATCHER).toMatch(/case ['"]practice_admin['"]:/);
    expect(DISPATCHER).toMatch(/case ['"]practice_provider['"]:/);
    expect(DISPATCHER).toMatch(/case ['"]admin['"]:/);
  });
});

// ─── Diff scope — auth surfaces + callback only ───────────────────────

describe('Diff scope — no payment / RLS / passkey action changes', () => {
  it('the button does not import payment / webhook / finance modules', () => {
    const FORBIDDEN = [
      '@/lib/payments/',
      '@/lib/paystack/',
      '@/lib/bills/lifecycle',
      'app/api/webhooks/paystack',
      '@/lib/finance',
    ];
    for (const mod of FORBIDDEN) {
      expect(BUTTON).not.toContain(`from '${mod}`);
      expect(BUTTON).not.toContain(`from "${mod}`);
    }
  });

  it('the callback does not touch payment / passkey / KYC modules', () => {
    expect(CALLBACK).not.toMatch(/from ['"].*paystack/);
    expect(CALLBACK).not.toMatch(/from ['"].*passkey/);
    expect(CALLBACK).not.toMatch(/from ['"]@\/lib\/finance['"]/);
  });

  it('the callback\'s ONLY table access is profiles (no plans/payments/bills)', () => {
    const tableAccesses = CALLBACK.match(/\.from\(['"](\w+)['"]\)/g) ?? [];
    const tables = tableAccesses.map((s) => s.replace(/\.from\(['"](\w+)['"]\)/, '$1'));
    for (const t of tables) {
      expect(t).toBe('profiles');
    }
  });
});

// ─── Regression: existing sign-in surfaces untouched ──────────────────

describe('Regression — email/password + passkey still supported on /login', () => {
  it('email + password fields still render', () => {
    expect(LOGIN).toMatch(/id="email"/);
    expect(LOGIN).toMatch(/id="password"/);
    expect(LOGIN).toMatch(/signInWithPassword/);
  });

  it('passkey sign-in still gated on browser support', () => {
    expect(LOGIN).toMatch(/passkeySupport\s*&&/);
    expect(LOGIN).toMatch(/Sign in with a passkey/);
  });
});
