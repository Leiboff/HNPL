'use client';

import { createClient } from '@/lib/supabase/client';

// ─── Shared client-side logout — never blocks the redirect ──────────────
//
// The bug it fixes: an unguarded `await supabase.auth.signOut()` followed
// by a redirect is brittle on mobile. The default scope='global' triggers
// a POST to Supabase to invalidate the refresh token server-side; on a
// flaky mobile network that call can hang for many seconds or throw, and
// because the redirect runs AFTER the await, a throw kills the redirect.
// React swallows uncaught event-handler errors, so the user just sees
// "nothing happen" when they tap Log out.
//
// Two design choices here:
//   1. scope:'local' — clears the browser session immediately (cookies +
//      localStorage) WITHOUT the network round-trip. Server-side refresh-
//      token invalidation matters less for our model (sessions expire
//      and we don't allow concurrent sessions to do anything risky); the
//      local clear is the UX-critical part.
//   2. try/finally — the redirect runs in `finally` so even if the local
//      signOut throws (e.g. localStorage access denied in a private tab),
//      the user still lands on /login.
//
// One source of truth for the three logout button shapes in the app
// (dashboard, patient, settings sheet).

export async function logoutAndRedirect(): Promise<void> {
  const supabase = createClient();
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch (err) {
    // Don't swallow silently — we want to know if this ever fails — but
    // also don't let it block the redirect.
    console.error('[logout] supabase.auth.signOut threw', err);
  } finally {
    // window.location.assign forces a full navigation (vs the SPA
    // soft-navigation Link / router.push would do). A full nav re-runs
    // middleware against the (now-cleared) cookies, so the unauthenticated
    // state is what /login renders against.
    window.location.assign('/login');
  }
}
