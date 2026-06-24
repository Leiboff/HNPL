import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── logoutAndRedirect — must always redirect ────────────────────────────
//
// The bug this guards against: a "log out" button that calls
// `await supabase.auth.signOut()` and then redirects. If signOut throws
// or stalls (flaky mobile network on default scope='global' which POSTs
// to /auth/v1/logout), the unawaited redirect never runs and the button
// looks broken to the user — "tap, nothing happens."
//
// The contract these tests pin:
//   1. signOut is called with scope:'local' (no network round-trip; fast
//      local clear, which is the UX-critical part).
//   2. The redirect to /login fires on the HAPPY path.
//   3. The redirect to /login STILL fires when signOut throws — try/finally
//      is the load-bearing guarantee.

const signOutSpy = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: signOutSpy } }),
}));

// jsdom-like environment via happy-dom — window.location.assign is a
// no-op by default. We spy on it so the assertions can observe where
// the redirect points.
const assignSpy = vi.fn();
Object.defineProperty(window, 'location', {
  writable: true,
  value: { ...window.location, assign: assignSpy },
});

beforeEach(() => {
  signOutSpy.mockReset();
  assignSpy.mockReset();
});

import { logoutAndRedirect } from './logout';

describe('logoutAndRedirect — happy path', () => {
  it('calls signOut with scope:local then redirects to /login', async () => {
    signOutSpy.mockResolvedValue({ error: null });
    await logoutAndRedirect();

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    expect(signOutSpy).toHaveBeenCalledWith({ scope: 'local' });
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });
});

describe('logoutAndRedirect — failure modes still redirect', () => {
  it('signOut throws → STILL redirects to /login (the load-bearing guarantee)', async () => {
    signOutSpy.mockRejectedValue(new Error('Network down on mobile'));
    await logoutAndRedirect();

    expect(signOutSpy).toHaveBeenCalledTimes(1);
    // The finally clause ensures /login is reached even when signOut
    // threw. Without this, a flaky mobile network would leave the user
    // stranded on the authenticated page — the original bug.
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('signOut returns an error object → still redirects (no special handling needed)', async () => {
    signOutSpy.mockResolvedValue({ error: { message: 'session_not_found' } });
    await logoutAndRedirect();

    expect(assignSpy).toHaveBeenCalledWith('/login');
  });
});
