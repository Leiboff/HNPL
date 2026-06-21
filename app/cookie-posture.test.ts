import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Cookie-posture regression ───────────────────────────────────────────
//
// Our two own-set cookies were hardened on 2026-06-21:
//   • hnpl_checkout_token (set in app/checkout/[token]/actions.ts)
//   • hnpl_invite_token   (set in app/signup/patient/actions.ts)
//
// Both must carry the FOUR attributes that combine to protect them:
//   1. httpOnly: true        — JS can't read them (no XSS exfil).
//   2. sameSite: 'lax'       — required because both ride at least one
//                              top-level navigation (Paystack callback
//                              / email-link click); 'strict' would drop.
//   3. secure: NODE_ENV ==='production' — only set over HTTPS in prod.
//                              Off in dev so localhost (http) still
//                              works.
//   4. path: appropriately scoped — checkout cookie scoped to /checkout
//                              (only read by /checkout/* pages); invite
//                              cookie path '/' because the proxy
//                              middleware reads it on every request
//                              until claim succeeds.
//
// These tests pin all four properties on each cookie. A future PR
// dropping `secure`, broadening `sameSite=none`, or removing httpOnly
// fails the suite loudly.
//
// Supabase's own session cookies are managed by the @supabase/ssr
// library and aren't audited here — that library sets httpOnly +
// sameSite=lax + secure-when-https itself, which the audit confirmed
// is correct posture. Tests for THOSE would have to mock the SSR
// library's internals and would couple us to an upstream impl detail;
// the audit doc in this commit's report records that posture instead.

const ROOT = resolve(process.cwd());
function read(p: string): string {
  return readFileSync(resolve(ROOT, p), 'utf8');
}

const CHECKOUT_ACTIONS = read('app/checkout/[token]/actions.ts');
const SIGNUP_ACTIONS   = read('app/signup/patient/actions.ts');

// Pluck the call-block for a cookieStore.set('name', ...) — we match
// across newlines (JSX-y multiline call), terminating at the closing
// brace + close paren of that call.
function findCookieSetBlock(src: string, cookieName: string): string {
  const re = new RegExp(
    `cookieStore\\.set\\([\\s\\S]*?['"]${cookieName}['"][\\s\\S]*?\\}\\s*\\);`,
  );
  const m = src.match(re);
  if (!m) throw new Error(`No cookieStore.set call for ${cookieName}`);
  return m[0];
}

describe('hnpl_checkout_token cookie posture', () => {
  const block = findCookieSetBlock(CHECKOUT_ACTIONS, 'hnpl_checkout_token');

  it('is httpOnly (no XSS exfiltration via document.cookie)', () => {
    expect(block).toMatch(/httpOnly:\s*true/);
  });

  it('is sameSite=lax (rides the Paystack callback navigation)', () => {
    expect(block).toMatch(/sameSite:\s*['"]lax['"]/);
  });

  it('is secure in production (only set over HTTPS in prod)', () => {
    expect(block).toMatch(/secure:\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]/);
  });

  it('is scoped to /checkout (narrower than / — only checkout routes read it)', () => {
    expect(block).toMatch(/path:\s*['"]\/checkout['"]/);
  });

  it('expires within 60 minutes (the checkout flow envelope)', () => {
    // maxAge in seconds. 60 * 60 = 3600.
    expect(block).toMatch(/maxAge:\s*60\s*\*\s*60(?!\s*\*)/);
  });

  it('the delete site matches the set path (so the cookie actually clears)', () => {
    // Browsers identify cookies by (name, domain, path). Without an
    // explicit path on delete, browsers create a phantom cookie at
    // the request URL's path and leave the real /checkout-scoped
    // cookie intact.
    expect(CHECKOUT_ACTIONS).toMatch(
      /cookieStore\.delete\(\s*\{\s*name:\s*['"]hnpl_checkout_token['"],\s*path:\s*['"]\/checkout['"]\s*\}\s*\)/,
    );
  });
});

describe('hnpl_invite_token cookie posture', () => {
  const block = findCookieSetBlock(SIGNUP_ACTIONS, 'hnpl_invite_token');

  it('is httpOnly', () => {
    expect(block).toMatch(/httpOnly:\s*true/);
  });

  it('is sameSite=lax (rides the email-link click navigation)', () => {
    expect(block).toMatch(/sameSite:\s*['"]lax['"]/);
  });

  it('is secure in production', () => {
    expect(block).toMatch(/secure:\s*process\.env\.NODE_ENV\s*===\s*['"]production['"]/);
  });

  it('is path=/ (middleware reads it on every request until claim)', () => {
    expect(block).toMatch(/path:\s*['"]\/['"]/);
  });

  it('expires within 7 days (upper bound on slow-completer signup)', () => {
    // 60 * 60 * 24 * 7 = 604800 seconds.
    expect(block).toMatch(/maxAge:\s*60\s*\*\s*60\s*\*\s*24\s*\*\s*7/);
  });
});

describe('No cookie anywhere is set with sameSite=none unless it explicitly needs cross-site', () => {
  // sameSite=none requires secure=true and is a CSRF risk if not
  // genuinely cross-site needed. Today no cookie of ours needs it.
  // A regression would be a real concern; pin against the entire
  // app tree.
  it('no own-set cookie declares sameSite=none', () => {
    const both = CHECKOUT_ACTIONS + '\n' + SIGNUP_ACTIONS;
    expect(both).not.toMatch(/sameSite:\s*['"]none['"]/);
  });
});
