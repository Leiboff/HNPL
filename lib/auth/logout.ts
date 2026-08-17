'use client';

import { createClient } from '@/lib/supabase/client';
import { clearStoredActivity } from './activityStorage';

// ─── Shared client-side logout — revokes server-side, never blocks ──────
//
// ─── THE ORIGINAL BUG, AND WHY IT MUST STAY FIXED ─────────────────────
//
// This helper exists because of one specific failure: an unguarded
// `await supabase.auth.signOut()` followed by a redirect is brittle on
// mobile. The default scope='global' POSTs to Supabase to invalidate the
// refresh token; on a flaky mobile network that call can hang for many
// seconds or throw, and because the redirect ran AFTER the await, a throw
// killed the redirect. React swallows uncaught event-handler errors, so
// the user just saw "nothing happen" when they tapped Log out.
//
// The fix at the time was scope:'local' — no network call, so nothing to
// hang on. It worked, but it bought reliability by giving up revocation:
// `local` clears the browser and leaves the refresh token VALID on
// Supabase's side. A token captured before logout kept working.
//
// So the constraint is not "avoid the network call". It is:
//
//   THE REDIRECT MUST NOT BE REACHABLE FROM A NETWORK CALL'S RESULT.
//
// Anything that can hang must be either unawaited or time-bounded, and
// the local clear must run regardless. Reintroducing an unbounded
// `await signOut({ scope: 'global' })` here would restore the original
// bug — that is what the ordering below is protecting, and what the tests
// in sessionRevocation.test.ts pin.
//
// ─── HOW REVOCATION HAPPENS NOW, IN THREE STEPS ───────────────────────
//
//   1. POST /api/auth/logout with keepalive:true. The server holds the
//      cookies, so it can revoke properly — and `keepalive` tells the
//      browser to finish the request even though we navigate away
//      immediately after. That is what lets us never await it: it is
//      fire-and-forget in this document's lifetime but not in the
//      browser's. This is the path that actually invalidates the token.
//
//   2. A client-side global signOut, RACED against a short timeout. Belt
//      and braces for when the route itself is unreachable (a partial
//      deploy, a 404 behind a stale service worker) while Supabase is
//      fine. Bounded, so the worst case is a small delay rather than a
//      dead button.
//
//   3. An unconditional LOCAL signOut. Runs whether or not (2) finished,
//      because (2) clears browser state only on success — a hung global
//      call would otherwise leave the user still signed in locally, which
//      is the original bug wearing a different hat.
//
// Note that an access token is a stateless JWT and cannot be revoked
// mid-life by any of this. Up to one token lifetime of validity survives
// every logout, by design of the token format; revocation bounds the
// REFRESH token, which is the part that would otherwise last 400 days.
//
// One source of truth for the three logout button shapes in the app
// (dashboard, patient, settings sheet).

/** Server-side revocation endpoint. See app/api/auth/logout/route.ts. */
export const LOGOUT_REVOKE_ENDPOINT = '/api/auth/logout';

/**
 * How long the client-side revocation may delay the redirect.
 *
 * Sized as "long enough for a healthy round trip, short enough that a
 * hanging one is not mistaken for a broken button". A successful call
 * returns well inside this; a hung one costs the user this much and then
 * the redirect happens anyway.
 */
export const LOGOUT_REVOKE_TIMEOUT_MS = 1200;

export async function logoutAndRedirect(target: string = '/login'): Promise<void> {
  const supabase = createClient();
  try {
    // (1) Server-side revocation. NEVER awaited — keepalive is what makes
    //     that safe, and awaiting it would put a network call back on the
    //     path to the redirect.
    //
    //     Wrapped in its OWN try/catch, which is not belt-and-braces: the
    //     .catch() only handles a rejected promise, and `fetch` can fail
    //     SYNCHRONOUSLY (absent in an old browser or a stubbed test
    //     environment, or throwing on a malformed init). A synchronous
    //     throw here would jump straight to the outer catch and skip steps
    //     (2) and (3) — leaving the user redirected but still signed in
    //     locally, which is a worse bug than the one we started with.
    try {
      void fetch(LOGOUT_REVOKE_ENDPOINT, {
        method: 'POST',
        keepalive: true,
        credentials: 'same-origin',
      }).catch((err) => {
        console.error('[logout] server-side revocation request failed', err);
      });
    } catch (err) {
      console.error('[logout] could not dispatch server-side revocation', err);
    }

    // (2) Client-side revocation, time-bounded. The inner .catch keeps a
    //     rejection from escaping the race.
    await Promise.race([
      supabase.auth.signOut({ scope: 'global' }).catch((err) => {
        console.error('[logout] global signOut failed', err);
      }),
      new Promise((resolve) => setTimeout(resolve, LOGOUT_REVOKE_TIMEOUT_MS)),
    ]);

    // (3) Local clear — unconditional, and the step the user's experience
    //     actually depends on.
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    // Don't swallow silently — we want to know if this ever fails — but
    // also don't let it block the redirect.
    console.error('[logout] supabase.auth.signOut threw', err);
  } finally {
    // Drop the persisted idle timestamp so the next sign-in in this
    // browser starts from a clean slate rather than inheriting the
    // previous user's last-activity time on a shared device.
    clearStoredActivity();

    // window.location.assign forces a full navigation (vs the SPA
    // soft-navigation Link / router.push would do). A full nav re-runs
    // middleware against the (now-cleared) cookies, so the unauthenticated
    // state is what the landing page renders against.
    //
    // `target` defaults to '/login' so every existing caller
    // (dashboard, patient, settings sheet) is unchanged. The
    // InactivityGuard passes `/login?reason=inactivity` so the login
    // page can render the informational "signed out due to inactivity"
    // notice.
    window.location.assign(target);
  }
}
