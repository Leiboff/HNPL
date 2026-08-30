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
//   • Per-layout durations: patient 5/5 (logout at 10), and
//     practice/brand/provider/admin/crm 10/5 (logout at 15, per PCI
//     DSS 4.0 req 8.2.8). Re-derived from 10/10 — see the note there.
//   • Diff scope: no payment/webhook/finance-math file changes.
//
// Behaviour lives elsewhere on purpose. This file is source-regex pins;
// what the guard actually DOES with elapsed time (a reloaded tab, a
// hidden tab, a forged timestamp) is driven through the real component in
// InactivityGuard.elapsed.test.tsx, and the revocation shape is pinned in
// sessionRevocation.test.ts.

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
const CRM_LAY       = read('app/crm/layout.tsx');

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

  // RE-DERIVED. This used to read "still calls signOut with scope: local
  // (never global)", which pinned the wrong thing — it pinned the FIX
  // rather than the PROPERTY, and so it also pinned the cost of that fix:
  // scope:'local' makes no server call, so logout never invalidated the
  // refresh token.
  //
  // The reasoning behind 'local' was sound and is preserved: the default
  // scope:'global' POSTs to Supabase, and an unguarded `await signOut()`
  // before a redirect could hang or throw on a flaky mobile network —
  // killing the redirect, so the user tapped Log out and saw nothing
  // happen. What that argument actually requires is not "never call the
  // server" but:
  //
  //   THE REDIRECT MUST NOT BE REACHABLE FROM A NETWORK CALL'S RESULT.
  //
  // So the local clear is still pinned here as the step the user's
  // experience depends on, and the no-unbounded-await property is pinned
  // in full in lib/auth/sessionRevocation.test.ts alongside the
  // revocation it now coexists with.
  it('still clears locally — the step the redirect depends on', () => {
    expect(LOGOUT_LIB).toMatch(/signOut\(\s*\{\s*scope:\s*['"]local['"]\s*\}\s*\)/);
  });

  it('and does so unconditionally, after any revocation attempt', () => {
    // A global signOut clears browser state only on success (auth-js does
    // the network call first). Ordering the local clear last is what makes
    // revocation safe to attempt at all.
    const globalAt = LOGOUT_LIB.indexOf("scope: 'global'");
    const localAt  = LOGOUT_LIB.indexOf("scope: 'local'");
    expect(globalAt).toBeGreaterThan(0);
    expect(localAt).toBeGreaterThan(globalAt);
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

  // ─── Elapsed time, not a running timer ──────────────────────────────

  it('derives elapsed time from a PERSISTED timestamp, not just the ref', () => {
    // The in-memory ref alone measured time-since-mount, so every reload
    // minted a fresh idle window. Behaviour is proven in
    // InactivityGuard.elapsed.test.tsx; this pins the wiring.
    expect(GUARD).toMatch(/from ['"]\.\/activityStorage['"]/);
    expect(GUARD).toMatch(/effectiveLastActivity\(lastActivityRef\.current,\s*readStoredActivity\(nowMs\)\)/);
  });

  it('mount does NOT write the timestamp', () => {
    // If it did, the reload being detected would refresh the value on its
    // way in and the check would always pass. Pinned as the absence of a
    // seed on the persist ref.
    expect(GUARD).toMatch(/lastPersistRef\s*=\s*useRef<number>\(0\)/);
  });

  it('"Stay signed in" writes THROUGH to storage, unthrottled', () => {
    // Load-bearing. By the time the modal is open the stored value is the
    // older of the two, and tick() takes the minimum — so resetting only
    // the ref would leave the modal reopening on the very next tick.
    expect(GUARD).toMatch(/function stay\(\)[\s\S]*?writeStoredActivity\(clock\(\)\)/);
  });

  it('activity writes through on a coarser throttle than the ref reset', () => {
    expect(GUARD).toMatch(/ACTIVITY_PERSIST_THROTTLE_MS/);
    expect(GUARD).toMatch(/writeStoredActivity\(t\)/);
  });
});

// ─── Per-layout wiring + durations ────────────────────────────────────

describe('Per-layout wiring — InactivityGuard mounted with role-appropriate durations', () => {
  // RE-DERIVED from 10/10 to 10/5 on the staff surfaces. PCI DSS 4.0 req
  // 8.2.8 requires re-authentication after 15 minutes idle for accounts
  // with administrative capabilities — which every one of these is — and
  // 10/10 logged out at 20.
  //
  // The COUNTDOWN was shortened rather than the working window: staff keep
  // the familiar 10 minutes of uninterrupted work and lose only warning
  // time, which nobody was supposed to be using as working time anyway.
  const STAFF_LAYOUTS: [string, string][] = [
    ['practice', PRACTICE_LAY],
    ['brand',    BRAND_LAY],
    ['provider', PROVIDER_LAY],
    ['admin',    ADMIN_LAY],
    ['crm',      CRM_LAY],
  ];

  it('patient: 5 / 5 → logout at 10 min (already inside 15, left alone)', () => {
    // The tag is no longer self-closing on the props alone — it also
    // carries sessionStartedAt (see lib/auth/activity-stale-session.test.ts).
    // The DURATIONS are what this test is for, so it pins those and stops
    // requiring the tag to end immediately after them.
    expect(PATIENT_LAY).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(PATIENT_LAY).toMatch(/<InactivityGuard\s+minutesIdle=\{5\}\s+minutesWarn=\{5\}[\s\S]{0,160}?\/>/);
  });

  it.each(STAFF_LAYOUTS)('%s: 10 / 5 → logout at 15 min', (_name, src) => {
    expect(src).toMatch(/from ['"]@\/lib\/auth\/InactivityGuard['"]/);
    expect(src).toMatch(/<InactivityGuard\s+minutesIdle=\{10\}\s+minutesWarn=\{5\}[\s\S]{0,160}?\/>/);
  });

  it('EVERY staff surface logs out at 15 minutes or under — 8.2.8', () => {
    // Asserted arithmetically rather than by matching the literals again,
    // so it holds if someone retunes the split. This is the compliance
    // statement; the per-layout tests above are the wiring.
    for (const [name, src] of STAFF_LAYOUTS) {
      const m = src.match(/<InactivityGuard\s+minutesIdle=\{(\d+)\}\s+minutesWarn=\{(\d+)\}/);
      expect(m, `${name} mounts an InactivityGuard`).not.toBeNull();
      const total = Number(m![1]) + Number(m![2]);
      expect(total, `${name} logs out after ${total} min`).toBeLessThanOrEqual(15);
    }
  });

  it('no staff surface was left on the old 20-minute total', () => {
    // The regression that matters: adding a new dashboard tree by copying
    // an old layout would reintroduce 10/10.
    for (const [name, src] of STAFF_LAYOUTS) {
      expect(src, name).not.toMatch(/minutesIdle=\{10\}\s+minutesWarn=\{10\}/);
    }
  });

  it('the patient side is genuinely unchanged, not swept along', () => {
    expect(PATIENT_LAY).toMatch(/minutesIdle=\{5\}\s+minutesWarn=\{5\}/);
    expect(PATIENT_LAY).not.toMatch(/minutesIdle=\{10\}/);
  });

  it('the till keeps its own server-side device lock, untouched', () => {
    // Explicitly out of scope: it is server-side, sliding, and already
    // well inside 15 minutes. Pinned so this task cannot be read as having
    // moved it.
    const TILL = read('lib/auth/tillDevice.ts');
    expect(TILL).toMatch(/TILL_IDLE_TIMEOUT_MS\s*=\s*5\s*\*\s*60\s*\*\s*1000/);
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

  it('logout helper still builds its client the same way and still clears locally', () => {
    // RE-DERIVED. The `not.toMatch(scope: 'global')` line that used to live
    // here was the load-bearing half of the old pin, and it was pinning the
    // absence of server-side revocation as though that were the goal. It
    // was a side effect. See the re-derivation note above, and
    // sessionRevocation.test.ts for what replaced it.
    expect(LOGOUT_LIB).toMatch(/createClient/);
    expect(LOGOUT_LIB).toMatch(/scope:\s*['"]local['"]/);
  });
});
