import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hasAcceptedTerms } from './acceptance';

// ─── The T&C precondition, and the leak that made it one ───────────────
//
// FIELD BUG this file exists for: a Google sign-in by someone with no
// account was correctly refused and bounced to /signup to accept the
// terms — and then a second attempt landed the visitor inside an
// onboarding step, with no acceptance on record.
//
// Two defects, both pinned below.
//
//   1. The refusal in /auth/callback was `try { await signOut() } catch {}`.
//      supabase.auth.signOut() reports a failed revocation by RETURNING
//      `{ error }`, and it early-returns BEFORE removing the stored
//      session when the revocation call fails with anything other than
//      404/401/403. A try/catch sees none of that, so the visitor kept a
//      live session while being shown the "accept the terms" screen. The
//      client-side "already signed in?" shortcut on /signup then sent
//      them to /dashboard, and the patient layout forwarded them into
//      onboarding.
//
//   2. Nothing downstream re-checked. lib/onboarding/state.ts said so in
//      as many words: "by the time anyone reaches onboarding the column
//      is already set". That is only true while the single upstream gate
//      is perfect, which is not a property any one route has.

const ROOT = resolve(process.cwd());
const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

describe('hasAcceptedTerms', () => {
  it('an acceptance on record passes', () => {
    expect(hasAcceptedTerms({ terms_accepted_at: '2026-08-01T00:00:00Z', onboarding_completed: false })).toBe(true);
  });

  it('no acceptance and not finished → refused', () => {
    expect(hasAcceptedTerms({ terms_accepted_at: null, onboarding_completed: false })).toBe(false);
    expect(hasAcceptedTerms({ terms_accepted_at: null, onboarding_completed: null })).toBe(false);
  });

  it('grandfathers an account that finished onboarding before this existed', () => {
    // onboarding_completed is written only by the server, so it cannot be
    // asserted into being by a visitor. Locking out existing customers
    // over a record we never asked them for would be the worse wrong.
    expect(hasAcceptedTerms({ terms_accepted_at: null, onboarding_completed: true })).toBe(true);
  });

  it('a missing row is refused — "we do not know" means "no" on a gate', () => {
    expect(hasAcceptedTerms(null)).toBe(false);
    expect(hasAcceptedTerms(undefined)).toBe(false);
  });

  it('does not accept a merely truthy-looking completion flag', () => {
    // Strict === true. A string from a loosely-typed read must not pass.
    expect(hasAcceptedTerms({ terms_accepted_at: null, onboarding_completed: 'yes' as unknown as boolean })).toBe(false);
  });
});

// ─── Defect 1: the refusal must not depend on signOut succeeding ──────

describe('/auth/callback — the refusal is terminal', () => {
  const CALLBACK = read('app/auth/callback/route.ts');

  it('reads signOut\'s RETURNED error, not only a throw', () => {
    // The bug in one line: signOut does not throw when revocation fails.
    expect(CALLBACK).toMatch(/const \{ error: signOutError \} = await supabase\.auth\.signOut/);
    expect(CALLBACK).toMatch(/if \(signOutError\)/);
  });

  it('revokes GLOBALLY, so the refresh token is dead upstream', () => {
    expect(CALLBACK).toMatch(/signOut\(\{\s*scope:\s*'global'\s*\}\)/);
  });

  it('deletes the auth cookies on the response it actually returns', () => {
    // The part that makes it terminal regardless of what signOut did.
    expect(CALLBACK).toMatch(/clearAuthCookies\(refused,/);
    expect(CALLBACK).toMatch(/request\.cookies\.getAll\(\)/);
  });

  it('still uses the shared acceptance predicate rather than an inline copy', () => {
    expect(CALLBACK).toMatch(/from '@\/lib\/legal\/acceptance'/);
    expect(CALLBACK).toMatch(/!hasAcceptedTerms\(profile\)/);
  });
});

describe('clearAuthCookies — one implementation, used by every ending path', () => {
  const COOKIES = read('lib/auth/authCookies.ts');

  it('deletes onto the response passed in, filtered to Supabase auth cookies', () => {
    expect(COOKIES).toMatch(/response\.cookies\.delete\(name\)/);
    expect(COOKIES).toMatch(/isSupabaseAuthCookie\(name\)/);
  });

  it('de-duplicates the names it is given (two request objects can overlap)', () => {
    expect(COOKIES).toMatch(/new Set\(names\)/);
  });

  it('is the only implementation — no path hand-rolls the delete loop', () => {
    for (const rel of [
      'proxy.ts',
      'app/auth/callback/route.ts',
      'app/auth/require-terms/route.ts',
    ]) {
      const src = read(rel);
      expect(src, rel).toMatch(/clearAuthCookies\(/);
      expect(src, rel).not.toMatch(/if \(isSupabaseAuthCookie\(name\)\)/);
    }
  });
});

// ─── The refusal route ────────────────────────────────────────────────

describe('/auth/require-terms — where the session actually ends', () => {
  const ROUTE = read('app/auth/require-terms/route.ts');

  it('exists as a GET Route Handler (a Server Component cannot clear cookies)', () => {
    expect(ROUTE).toMatch(/export async function GET/);
  });

  it('RE-VERIFIES server-side, so a stray GET cannot log out a good account', () => {
    // The property that makes a GET logout route safe: an account that HAS
    // accepted is sent to the dispatcher, not signed out.
    expect(ROUTE).toMatch(/hasAcceptedTerms\(profile\)/);
    expect(ROUTE).toMatch(/if \(accepted\)/);
    expect(ROUTE).toMatch(/\/dashboard/);
  });

  it('reads the row with the SERVICE client, not the session being destroyed', () => {
    expect(ROUTE).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('fails CLOSED when the row cannot be read', () => {
    expect(ROUTE).toMatch(/accepted = false/);
  });

  it('revokes globally, clears cookies, and lands on the same screen as the callback', () => {
    expect(ROUTE).toMatch(/signOut\(\{\s*scope:\s*'global'\s*\}\)/);
    expect(ROUTE).toMatch(/clearAuthCookies\(/);
    expect(ROUTE).toMatch(/\/signup\?error=terms/);
  });
});

// ─── Defect 2: every surface a session can reach now re-checks ────────

describe('No onboarding step renders without an acceptance', () => {
  // The product rule, stated as the user stated it: it should never go to
  // ANY onboarding step unless the terms are accepted. Every page in the
  // tree, plus the router that hands out their URLs, plus the layout that
  // forwards into them.
  const GATED = [
    'app/onboarding/page.tsx',
    'app/onboarding/verify-email/page.tsx',
    'app/onboarding/phone/page.tsx',
    'app/onboarding/salary/page.tsx',
    'app/onboarding/identity/page.tsx',
    'app/onboarding/credit-check/page.tsx',
    'app/patient/layout.tsx',
  ];

  it.each(GATED)('%s calls requireTermsAccepted', (rel) => {
    const src = read(rel);
    expect(src).toMatch(/from '@\/lib\/legal\/termsGate'/);
    expect(src).toMatch(/requireTermsAccepted\(profile\)/);
  });

  // Where each gated surface's row actually comes from. The /onboarding
  // pages select inline; the patient layout reads the request-scoped memo,
  // so for that one the columns have to be present THERE.
  const ROW_SOURCE: Record<string, string> = Object.fromEntries([
    ...GATED.filter((rel) => rel !== 'app/patient/layout.tsx').map((rel) => [rel, rel]),
    ['app/patient/layout.tsx', 'lib/patient/requestProfile.ts'],
  ]);

  it.each(GATED)('%s reads the columns the gate needs', (rel) => {
    // A gate handed a row without these columns would silently refuse
    // everyone (both null) — or, worse, be "fixed" by removing the gate.
    const src = read(ROW_SOURCE[rel]);
    expect(src).toMatch(/terms_accepted_at/);
    expect(src).toMatch(/onboarding_completed/);
    expect(src).toMatch(/\brole\b/);
  });

  it('the gate runs BEFORE the step is computed, not after', () => {
    // Refusing after computeOnboarding would still have rendered nothing,
    // but it would have put a DB-shaped decision behind a step guard that
    // can redirect first. Order is the whole point of a precondition.
    for (const rel of [
      'app/onboarding/phone/page.tsx',
      'app/onboarding/salary/page.tsx',
      'app/onboarding/identity/page.tsx',
      'app/onboarding/credit-check/page.tsx',
    ]) {
      const src = read(rel);
      expect(src.indexOf('requireTermsAccepted(profile)'), rel)
        .toBeLessThan(src.indexOf('computeOnboarding('));
    }
  });

  it('the patient layout gates before it forwards into onboarding', () => {
    // This is the exact hop the field bug travelled: a surviving session
    // reached /patient and was forwarded to /onboarding.
    const LAYOUT = read('app/patient/layout.tsx');
    expect(LAYOUT.indexOf('requireTermsAccepted(profile)'))
      .toBeLessThan(LAYOUT.indexOf("redirect('/onboarding')"));
  });
});

describe('requireTermsAccepted — who it speaks for', () => {
  const GATE = read('lib/legal/termsGate.ts');

  it('exempts invited staff roles, who were never asked for customer T&Cs', () => {
    for (const role of ['practice_admin', 'practice_staff', 'practice_provider', 'admin', 'sales']) {
      expect(GATE).toMatch(new RegExp(`'${role}'`));
    }
  });

  it('treats a null role as a patient — the trigger default, and this is a gate', () => {
    expect(GATE).toMatch(/profile\?\.role && EXEMPT_ROLES\.has\(profile\.role\)/);
  });

  it('redirects to the route handler, never straight to /signup', () => {
    // Straight to /signup would leave the session alive, and /signup's own
    // client-side session shortcut would bounce back to /dashboard — a
    // loop, and the same defect one layer down.
    expect(GATE).toMatch(/redirect\('\/auth\/require-terms'\)/);
    expect(GATE).not.toMatch(/redirect\('\/signup/);
  });
});

// ─── The stale claim that made defect 2 possible ──────────────────────

describe('the onboarding state model no longer claims the column is always set', () => {
  it('points at the gate instead of asserting the precondition holds', () => {
    const STATE = read('lib/onboarding/state.ts');
    // Still no terms STEP — that part was right and has not changed.
    expect(STATE).not.toMatch(/'terms'/);
    // But the comment must no longer tell a reader the check is
    // unnecessary, which is what stopped anyone adding one.
    expect(STATE).toMatch(/termsGate/);
  });
});

// ─── Third layer: the refusal screen does not usher a session past itself

describe('/signup does not forward an existing session when it IS the refusal', () => {
  const ENTRY = readFileSync(resolve(ROOT, 'app/(auth)/signup/SignupEntry.tsx'), 'utf8');

  it('the "already signed in" shortcut is skipped on a ?error=terms bounce', () => {
    // This shortcut was the CARRIER in the field bug: a refused arrival
    // holding a session that failed to clear landed here and was
    // forwarded to /dashboard, which forwarded it into onboarding.
    expect(ENTRY).toMatch(/if \(bounce\) return;/);
    // And the effect depends on the flag, so it cannot fire before the
    // bounce is known.
    expect(ENTRY).toMatch(/\}, \[bounce\]\);/);
  });

  it('the shortcut still exists for a normal visit — this is a guard, not a removal', () => {
    expect(ENTRY).toMatch(/getSession\(\)/);
    expect(ENTRY).toMatch(/window\.location\.href = '\/dashboard';/);
  });
});
