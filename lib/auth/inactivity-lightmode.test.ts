import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Light-mode enforcement + inactivity auto-logout ──────────────────
//
// Pins:
//
//   PART 1 (light mode)
//   • globals.css sets :root { color-scheme: light } AND does NOT
//     have @media (prefers-color-scheme: dark).
//   • Root layout emits <meta name="color-scheme" content="light">.
//   • Root <html> and <body> declare an explicit light background.
//   • Brand routes (which had no layout.tsx) now DO have one; both
//     brand and practice layouts render the InactivityGuard.
//
//   PART 2 (inactivity)
//   • InactivityGuard mounts activity listeners + a single 1 s tick
//     + a visibilitychange handler; cleans them up on unmount.
//   • Activity listeners are NOT touched while the modal is open
//     (so a passer-by scrolling doesn't silently extend a shared-
//     device session).
//   • Expiry calls the shared logoutAndRedirect helper with the
//     /login?reason=inactivity target.
//   • Login page renders the informational notice on
//     ?reason=inactivity.
//   • Per-layout durations: patient 5/5, brand/practice/provider/
//     admin 10/10.
//   • Diff scope: no payment/webhook/finance-math file changes.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const GLOBALS_CSS   = read('app/globals.css');
const ROOT_LAYOUT   = read('app/layout.tsx');
const LOGIN         = read('app/(auth)/login/page.tsx');
const LOGOUT_LIB    = read('lib/auth/logout.ts');
const GUARD         = read('lib/auth/InactivityGuard.tsx');

const PATIENT_LAY   = read('app/patient/layout.tsx');
const PRACTICE_LAY  = read('app/practice/layout.tsx');
const BRAND_LAY     = read('app/brand/layout.tsx');
const PROVIDER_LAY  = read('app/provider/layout.tsx');
const ADMIN_LAY     = read('app/admin/layout.tsx');

// ─── PART 1 — light-mode enforcement ──────────────────────────────────

describe('globals.css — light-mode forced, no dark-mode media query', () => {
  it('sets :root { color-scheme: light }', () => {
    expect(GLOBALS_CSS).toMatch(/:root\s*\{[\s\S]*?color-scheme:\s*light[\s\S]*?\}/);
  });

  it('does NOT contain an @media (prefers-color-scheme: dark) rule', () => {
    // Explanatory prose in comments MAY reference the phrase; a real
    // @media rule is what we're forbidding. Strip comments before
    // checking so the prose doesn't create a false positive.
    //
    // Deliberately NOT lib/testing/stripComments: this is CSS, where `/* */`
    // is the ONLY comment form and `//` is not a comment at all. Running the
    // JS-aware helper over it would treat `url(//host/x)` and any bare
    // `https://` as a line comment and delete the rest of the line. Block-only
    // is not an oversight here — it is the correct stripper for the language.
    const codeOnly = GLOBALS_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(codeOnly).not.toMatch(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/);
  });

  it('does NOT redefine --background to a dark value', () => {
    // The old code set --background: #0a0a0a inside the dark media
    // query. That block is gone.
    expect(GLOBALS_CSS).not.toMatch(/--background:\s*#0a0a0a/);
    expect(GLOBALS_CSS).not.toMatch(/--background:\s*#000000/);
  });

  it('body still reads var(--background) (fallback stays consistent with :root)', () => {
    expect(GLOBALS_CSS).toMatch(/body\s*\{[\s\S]*?background:\s*var\(--background\)/);
  });
});

describe('Root layout — belt-and-braces color-scheme declarations', () => {
  it('emits <meta name="color-scheme" content="light">', () => {
    expect(ROOT_LAYOUT).toMatch(/<meta\s+name="color-scheme"\s+content="light"\s*\/?>/);
  });

  it('declares viewport.colorScheme = "light" (Next 16 metadata API)', () => {
    expect(ROOT_LAYOUT).toMatch(/colorScheme:\s*['"]light['"]/);
  });

  it('applies an explicit background to <body>', () => {
    // Any light bg class or inline style — pin that a bg class exists
    // on the body element specifically.
    expect(ROOT_LAYOUT).toMatch(/<body[^>]*className=[^>]*bg-\[?#?f7fbfb/);
  });
});

describe('Layout wrappers — brand + practice + patient + provider + admin', () => {
  it('brand/layout.tsx exists (previously missing → dark-mode leak)', () => {
    expect(existsSync(resolve(ROOT, 'app/brand/layout.tsx'))).toBe(true);
  });

  it('practice/layout.tsx exists (previously missing)', () => {
    expect(existsSync(resolve(ROOT, 'app/practice/layout.tsx'))).toBe(true);
  });
});

// ─── PART 2 — logout helper + guard component ─────────────────────────

describe('logoutAndRedirect — accepts optional target, defaults to /login', () => {
  it('signature accepts an optional target argument (default /login)', () => {
    expect(LOGOUT_LIB).toMatch(/logoutAndRedirect\(\s*target:\s*string\s*=\s*['"]\/login['"]\s*\)/);
  });

  it('still calls signOut with scope: local (never global)', () => {
    expect(LOGOUT_LIB).toMatch(/signOut\(\s*\{\s*scope:\s*['"]local['"]\s*\}\s*\)/);
  });

  it('the redirect happens in finally + uses window.location.assign(target)', () => {
    expect(LOGOUT_LIB).toMatch(/finally\s*\{[\s\S]*?window\.location\.assign\(target\)/);
  });
});

describe('InactivityGuard component contract', () => {
  it('has both minutesIdle and minutesWarn props', () => {
    expect(GUARD).toMatch(/minutesIdle:\s*number/);
    expect(GUARD).toMatch(/minutesWarn:\s*number/);
  });

  it('mounts activity listeners for pointerdown / touchstart / keydown / scroll / wheel', () => {
    expect(GUARD).toMatch(/ACTIVITY_EVENTS\s*=\s*\[\s*'pointerdown',\s*'touchstart',\s*'keydown',\s*'scroll',\s*'wheel'/);
    expect(GUARD).toMatch(/window\.addEventListener\(evt,\s*markActivity/);
  });

  it('throttles the activity reset (does not churn state on every scroll pixel)', () => {
    expect(GUARD).toMatch(/RESET_THROTTLE_MS/);
    expect(GUARD).toMatch(/t\s*-\s*lastResetRef\.current\s*<\s*RESET_THROTTLE_MS/);
  });

  it('activity does NOT reset the timer while the modal is open', () => {
    expect(GUARD).toMatch(/if\s*\(\s*modalOpenRef\.current\s*\)\s*return;/);
  });

  it('polls once per second via setInterval(tick, 1000)', () => {
    expect(GUARD).toMatch(/setInterval\(tick,\s*1000\)/);
  });

  it('handles visibilitychange — rechecks on tab wake', () => {
    expect(GUARD).toMatch(/visibilitychange/);
    expect(GUARD).toMatch(/if\s*\(!document\.hidden\)\s*tick\(\)/);
  });

  it('cleans up listeners + interval on unmount', () => {
    expect(GUARD).toMatch(/removeEventListener\(evt,\s*markActivity/);
    expect(GUARD).toMatch(/removeEventListener\(['"]visibilitychange['"]/);
    expect(GUARD).toMatch(/clearInterval\(interval\)/);
  });

  it('expiry calls logoutAndRedirect with /login?reason=inactivity (not the default target)', () => {
    expect(GUARD).toMatch(/logoutAndRedirect\(['"`]\/login\?reason=inactivity['"`]\)/);
  });

  it('modal has both "Stay signed in" (primary) and "Sign out now" (secondary) buttons', () => {
    expect(GUARD).toMatch(/data-testid="inactivity-stay"/);
    expect(GUARD).toMatch(/data-testid="inactivity-signout"/);
    expect(GUARD).toMatch(/Stay signed in/);
    expect(GUARD).toMatch(/Sign out now/);
  });

  it('modal has aria-modal="true" + a labelledby heading', () => {
    expect(GUARD).toMatch(/role="dialog"/);
    expect(GUARD).toMatch(/aria-modal="true"/);
    expect(GUARD).toMatch(/aria-labelledby="inactivity-title"/);
  });

  it('modal copy: "Are you still there?" + M:SS countdown', () => {
    expect(GUARD).toMatch(/Are you still there\?/);
    expect(GUARD).toMatch(/For your security, you.+ll be signed out in/);
    expect(GUARD).toMatch(/data-testid="inactivity-countdown"/);
  });

  it('"Stay signed in" resets lastActivityRef to the current clock', () => {
    expect(GUARD).toMatch(/function stay\(\)[\s\S]*?lastActivityRef\.current\s*=\s*clock\(\)/);
  });
});

// ─── Per-layout wiring + durations ────────────────────────────────────

describe('Per-layout wiring — InactivityGuard mounted with role-appropriate durations', () => {
  it('patient: 5 / 5', () => {
    expect(PATIENT_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(PATIENT_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{5\}\s+minutesWarn=\{5\}\s*\/>/);
  });

  it('practice: 10 / 10', () => {
    expect(PRACTICE_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(PRACTICE_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{10\}\s+minutesWarn=\{10\}\s*\/>/);
  });

  it('brand: 10 / 10', () => {
    expect(BRAND_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(BRAND_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{10\}\s+minutesWarn=\{10\}\s*\/>/);
  });

  it('provider: 10 / 10', () => {
    expect(PROVIDER_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(PROVIDER_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{10\}\s+minutesWarn=\{10\}\s*\/>/);
  });

  it('admin: 10 / 10', () => {
    expect(ADMIN_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(ADMIN_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{10\}\s+minutesWarn=\{10\}\s*\/>/);
  });
});

// ─── Login page — inactivity notice on ?reason=inactivity ─────────────

describe('Login page — renders the inactivity notice on ?reason=inactivity', () => {
  it('reads the reason param and sets the informational notice', () => {
    expect(LOGIN).toMatch(/params\.get\(['"]reason['"]\)/);
    expect(LOGIN).toMatch(/reason\s*===\s*['"]inactivity['"]/);
    expect(LOGIN).toMatch(/You were signed out due to inactivity/);
  });

  it('the notice does NOT use error styling (it\'s informational)', () => {
    // The login page has a blue-tinted `notice` banner (bg-blue-50)
    // and a red-tinted `error` banner (bg-red-50). Pin that the
    // inactivity branch is routed via setNotice — narrow the search
    // to the same effect block that reads `reason` so we don't pick
    // up unrelated setError calls elsewhere in the file.
    const idx = LOGIN.indexOf("params.get('reason')");
    expect(idx).toBeGreaterThan(0);
    const scope = LOGIN.slice(idx, idx + 400);
    expect(scope).toMatch(/setNotice\(/);
    expect(scope).not.toMatch(/setError\(/);
  });
});

// ─── Diff scope — no payment / webhook / finance changes ──────────────

describe('Diff scope — light-mode + inactivity guard only', () => {
  const FORBIDDEN = [
    '@/lib/payments/',
    '@/lib/paystack/',
    '@/lib/bills/lifecycle',
    'app/api/webhooks/paystack',
    '@/lib/finance',
  ];

  it('the guard does not import payment / webhook / finance modules', () => {
    for (const mod of FORBIDDEN) {
      expect(GUARD).not.toContain(`from '${mod}`);
      expect(GUARD).not.toContain(`from "${mod}`);
    }
  });

  it('the guard\'s only auth import is the logout helper', () => {
    // Pin the surface — a regression that reaches into passkey /
    // signOut / signIn code from the guard would trip this.
    expect(GUARD).toMatch(/from\s+['"]\.\/logout['"]/);
    expect(GUARD).not.toMatch(/from\s+['"]@\/lib\/supabase/);
    expect(GUARD).not.toMatch(/signInWith/);
    expect(GUARD).not.toMatch(/passkey/i);
  });

  it('logout helper unchanged except for the optional target arg', () => {
    // Still uses createClient + signOut. This test guards against
    // scope regressions (e.g. someone removing scope: 'local').
    expect(LOGOUT_LIB).toMatch(/createClient/);
    expect(LOGOUT_LIB).toMatch(/scope:\s*['"]local['"]/);
    expect(LOGOUT_LIB).not.toMatch(/scope:\s*['"]global['"]/);
  });
});
