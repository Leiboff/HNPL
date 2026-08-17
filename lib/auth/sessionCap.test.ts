import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import {
  ABSOLUTE_SESSION_MAX_MS,
  SESSION_CAP_REDIRECT_REASON,
  isCapExemptPath,
  isSupabaseAuthCookie,
  sessionExceedsAbsoluteCap,
} from './sessionCap';

// ─── The layer we had none of ────────────────────────────────────────────
//
// Before this, a session could live indefinitely. The idle guard measures
// LAST ACTIVITY, so touching the page occasionally reset it forever; and
// the hourly access-token expiry is not a bound at all, because
// lib/supabase/middleware.ts calls auth.getUser() on every request, which
// silently redeems the refresh token.
//
// So the cap has to be measured from AUTHENTICATION, and it has to be
// enforced somewhere the browser cannot reach — which is the second half
// of what this file pins.

const ROOT  = resolve(process.cwd());
const read  = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));
const PROXY = read('proxy.ts');
const MW    = read('lib/supabase/middleware.ts');
const LOGIN = read('app/(auth)/login/page.tsx');

const HOUR = 60 * 60 * 1000;
const NOW  = Date.parse('2026-08-17T12:00:00.000Z');
const iso  = (ms: number) => new Date(ms).toISOString();

describe('the cap value', () => {
  it('is 12 hours', () => {
    expect(ABSOLUTE_SESSION_MAX_MS).toBe(12 * HOUR);
  });

  it('clears the longest realistic shift but not two of them', () => {
    // The reasoning, pinned as a range rather than as the number twice.
    // Long enough that a receptionist is never interrupted mid-shift;
    // short enough that a session cannot straddle two shifts and two
    // different people at the same desk.
    expect(ABSOLUTE_SESSION_MAX_MS).toBeGreaterThanOrEqual(8 * HOUR);
    expect(ABSOLUTE_SESSION_MAX_MS).toBeLessThan(24 * HOUR);
  });

  it('is far longer than the idle timeout — they bound different things', () => {
    // Idle: 15 min for staff. Absolute: measured from sign-in and
    // unaffected by activity. A cap anywhere near the idle window would
    // just be a second idle timeout.
    expect(ABSOLUTE_SESSION_MAX_MS).toBeGreaterThan(20 * 15 * 60 * 1000);
  });
});

describe('sessionExceedsAbsoluteCap — measured from authentication', () => {
  it('a session younger than the cap survives', () => {
    expect(sessionExceedsAbsoluteCap(iso(NOW - 11 * HOUR), NOW)).toBe(false);
  });

  it('a session older than the cap does not', () => {
    expect(sessionExceedsAbsoluteCap(iso(NOW - 13 * HOUR), NOW)).toBe(true);
  });

  it('the boundary is inclusive — exactly at the cap requires re-auth', () => {
    expect(sessionExceedsAbsoluteCap(iso(NOW - ABSOLUTE_SESSION_MAX_MS), NOW)).toBe(true);
    expect(sessionExceedsAbsoluteCap(iso(NOW - ABSOLUTE_SESSION_MAX_MS + 1000), NOW)).toBe(false);
  });

  it('a CONTINUOUSLY ACTIVE session still hits the cap', () => {
    // The whole point of the layer. Activity is not an input to this
    // function, so there is no argument value that can represent "but
    // they were using it" — which is exactly the property we want.
    const signedInAt = NOW - 13 * HOUR;
    // Simulate a full day of being busy every single minute.
    for (let m = 0; m <= 13 * 60; m++) {
      const t = signedInAt + m * 60_000;
      expect(sessionExceedsAbsoluteCap(iso(signedInAt), t)).toBe(t - signedInAt >= ABSOLUTE_SESSION_MAX_MS);
    }
  });

  it('accepts an explicit cap so callers can be tested without moving the constant', () => {
    expect(sessionExceedsAbsoluteCap(iso(NOW - 2 * HOUR), NOW, 1 * HOUR)).toBe(true);
    expect(sessionExceedsAbsoluteCap(iso(NOW - 2 * HOUR), NOW, 3 * HOUR)).toBe(false);
  });
});

describe('sessionExceedsAbsoluteCap — fails CLOSED on a bad timestamp', () => {
  it.each([
    ['null',        null],
    ['undefined',   undefined],
    ['empty',       ''],
    ['garbage',     'not-a-date'],
    ['a number',    '1700000000000'],
  ])('%s → requires re-authentication', (_label, value) => {
    // Cheap and self-healing: the cost is one unnecessary sign-in, after
    // which last_sign_in_at is freshly populated. Failing OPEN would
    // silently restore the uncapped behaviour, invisibly — worse than a
    // visible annoyance.
    expect(sessionExceedsAbsoluteCap(value as string | null | undefined, NOW)).toBe(true);
  });

  it('a FUTURE sign-in time does not force a spurious sign-out', () => {
    // Clock skew between Supabase and the edge. The subtraction goes
    // negative, which is under any cap — no special case needed.
    expect(sessionExceedsAbsoluteCap(iso(NOW + 5 * 60_000), NOW)).toBe(false);
  });
});

describe('exempt paths — the redirect-loop guard', () => {
  it.each(['/login', '/login/', '/signup', '/signup/practice', '/forgot-password',
           '/auth/callback', '/api/auth/logout'])('%s is exempt', (p) => {
    expect(isCapExemptPath(p)).toBe(true);
  });

  it.each(['/practice', '/practice/pos', '/patient', '/brand/revenue', '/admin',
           '/crm', '/dashboard', '/update-password', '/checkout/abc123'])(
    '%s is NOT exempt', (p) => {
      expect(isCapExemptPath(p)).toBe(false);
    });

  it('every route by which a session is OBTAINED is exempt', () => {
    // If clearing the auth cookies ever fails — a domain mismatch, a
    // half-rolled-out deploy — an unexempted /login would bounce forever
    // and the user could not sign in again to fix it.
    for (const p of ['/login', '/signup', '/auth/callback', '/auth/confirm', '/forgot-password']) {
      expect(isCapExemptPath(p), p).toBe(true);
    }
  });

  it('/update-password is deliberately NOT exempt', () => {
    // A reset link creates a fresh sign-in, so the cap does not bite on the
    // real flow; and a genuinely 12-hour-old session being sent to log in
    // before changing a password is correct.
    expect(isCapExemptPath('/update-password')).toBe(false);
  });
});

describe('cookie matching handles the chunked case', () => {
  it('matches the plain auth cookie', () => {
    expect(isSupabaseAuthCookie('sb-abcdefghij-auth-token')).toBe(true);
  });

  it('matches CHUNKED auth cookies', () => {
    // A session over 4 KB is split. Deleting only the unsuffixed name
    // leaves chunks behind, and @supabase/ssr reassembles what it finds —
    // a partial delete is worse than either extreme.
    expect(isSupabaseAuthCookie('sb-abcdefghij-auth-token.0')).toBe(true);
    expect(isSupabaseAuthCookie('sb-abcdefghij-auth-token.1')).toBe(true);
  });

  it('does not match our own cookies', () => {
    expect(isSupabaseAuthCookie('hnpl_invite_token')).toBe(false);
    expect(isSupabaseAuthCookie('x-pathname')).toBe(false);
  });
});

// ─── Wiring: enforced on the SERVER, and nowhere else ────────────────────

describe('the cap is enforced in the proxy', () => {
  it('proxy.ts calls sessionExceedsAbsoluteCap', () => {
    expect(PROXY).toMatch(/sessionExceedsAbsoluteCap\(/);
  });

  it('it is measured from last_sign_in_at, not from activity', () => {
    // last_sign_in_at is set when credentials are presented and is NOT
    // touched by a token refresh, which is what makes it the correct
    // anchor — and being server-supplied, one the browser cannot forge.
    expect(PROXY).toMatch(/user\.last_sign_in_at/);
  });

  it('it is skipped on exempt paths', () => {
    expect(PROXY).toMatch(/isCapExemptPath\(request\.nextUrl\.pathname\)/);
  });

  it('it REVOKES server-side rather than only clearing cookies', () => {
    // A cookie wipe makes the refresh token unreachable from this browser;
    // it does not make it invalid. Layer four is revocation.
    expect(PROXY).toMatch(/signOut\(\{\s*scope:\s*'global'\s*\}\)/);
  });

  it('it clears the auth cookies onto the response it actually returns', () => {
    // signOut's own cookie writes land on the passthrough response, which
    // the capped branch discards in favour of a redirect. The deletes have
    // to be applied to the redirect.
    expect(PROXY).toMatch(/isSupabaseAuthCookie\(name\)/);
    expect(PROXY).toMatch(/capped\.cookies\.delete\(name\)/);
  });

  it('it collects cookie names from BOTH request objects', () => {
    // A token refresh can change the chunk count (a session crossing 4 KB
    // splits into `…-auth-token.0`, `.1`), and those new names exist only
    // on the mutated request. Deleting some chunks and not others is worse
    // than deleting none — @supabase/ssr reassembles what it finds.
    expect(PROXY).toMatch(/request\.cookies\.getAll\(\)\.map\(\(c\) => c\.name\)/);
    expect(PROXY).toMatch(/modifiedRequest\.cookies\.getAll\(\)\.map\(\(c\) => c\.name\)/);
  });

  it('it redirects to /login with the reason code', () => {
    expect(PROXY).toMatch(/loginUrl\.pathname\s*=\s*'\/login'/);
    expect(PROXY).toMatch(/searchParams\.set\('reason',\s*SESSION_CAP_REDIRECT_REASON\)/);
    expect(SESSION_CAP_REDIRECT_REASON).toBe('session_expired');
  });

  it('it clears the existing query string rather than carrying it over', () => {
    // nextUrl.clone() keeps the original search params; leaving them would
    // append ?reason= to whatever the user was doing.
    expect(PROXY).toMatch(/loginUrl\.search\s*=\s*''/);
  });

  it('it runs BEFORE the invitation claim, so an over-cap session cannot write', () => {
    const capAt    = PROXY.indexOf('sessionExceedsAbsoluteCap');
    const claimAt  = PROXY.indexOf('hnpl_invite_token');
    expect(capAt).toBeGreaterThan(0);
    expect(claimAt).toBeGreaterThan(0);
    expect(capAt).toBeLessThan(claimAt);
  });
});

describe('updateSession hands back what the cap needs, without a second round trip', () => {
  it('returns the user rather than discarding it', () => {
    // auth.getUser() validates the JWT over the network. Calling it twice
    // per request to learn the same fact is a real round trip added to
    // every page load.
    expect(MW).toMatch(/const \{ data: \{ user \} \} = await supabase\.auth\.getUser\(\)/);
    expect(MW).toMatch(/return \{ response: supabaseResponse, user, supabase \}/);
  });

  it('and the client, so the revocation reuses the cookie-bound one', () => {
    expect(MW).toMatch(/supabase: SupabaseClient/);
  });
});

describe('the login page explains the cap without lying about it', () => {
  it('handles reason=session_expired separately from inactivity', () => {
    // The user was not idle. Telling them they were is wrong, and
    // confusing when they were mid-task.
    expect(LOGIN).toMatch(/reason === 'session_expired'/);
    expect(LOGIN).toMatch(/reason === 'inactivity'/);
  });

  it('derives the hours from the constant so the copy cannot drift', () => {
    expect(LOGIN).toMatch(/ABSOLUTE_SESSION_MAX_MS/);
    expect(LOGIN).not.toMatch(/sessions end after 12 hours/);
  });

  it('is informational, not an error', () => {
    const start = LOGIN.indexOf("reason === 'session_expired'");
    expect(start).toBeGreaterThan(0);
    // Bounded by the end of the enclosing effect rather than by a
    // character count — a fixed window bled into the unrelated passkey
    // effect below and picked up its setError.
    const end = LOGIN.indexOf('}, []);', start);
    expect(end).toBeGreaterThan(start);
    const scope = LOGIN.slice(start, end);
    expect(scope).toMatch(/setNotice\(/);
    expect(scope).not.toMatch(/setError\(/);
  });
});

describe('the cap is not enforceable from the client', () => {
  it('no client component decides it', () => {
    // Stated as a test because the value of this layer is entirely that it
    // is unreachable from the browser. A client-side copy would be a
    // suggestion, and would invite someone to treat the pair as equivalent.
    const GUARD = read('lib/auth/InactivityGuard.tsx');
    expect(GUARD).not.toMatch(/ABSOLUTE_SESSION_MAX_MS|sessionExceedsAbsoluteCap/);
    // The login page imports the constant for COPY only — never to decide.
    expect(LOGIN).not.toMatch(/sessionExceedsAbsoluteCap/);
  });
});
