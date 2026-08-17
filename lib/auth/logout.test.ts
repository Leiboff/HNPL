import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── logoutAndRedirect — must always redirect, AND must now revoke ───────
//
// THE ORIGINAL BUG, unchanged: a "log out" button that calls
// `await supabase.auth.signOut()` and then redirects. If signOut throws or
// stalls (flaky mobile network on the default scope='global', which POSTs
// to /auth/v1/logout), the redirect after the await never runs and the
// button looks broken — "tap, nothing happens."
//
// WHAT CHANGED, and why these tests were re-derived rather than deleted:
//
//   The old fix was scope:'local' — no network call, so nothing to hang
//   on. It worked, and this file pinned it as `signOut called exactly
//   once, with scope:'local'`. But that pinned the FIX rather than the
//   PROPERTY, and so it also locked in the cost: 'local' makes no server
//   call, so logging out left the refresh token VALID upstream. A token
//   captured before logout kept working.
//
//   The reasoning behind 'local' is still right. What it actually requires
//   is not "never call the server" but:
//
//     THE REDIRECT MUST NOT BE REACHABLE FROM A NETWORK CALL'S RESULT.
//
//   So the contract these tests now pin:
//     1. Revocation is ATTEMPTED — server-side via a keepalive POST, and
//        client-side via a global signOut.
//     2. Nothing that can hang sits on the path to the redirect: the
//        global call is raced against a timeout, and the keepalive POST is
//        never awaited at all.
//     3. A LOCAL clear always runs afterwards, because a global signOut
//        clears browser state only on success.
//     4. The redirect to /login fires on the happy path, when signOut
//        throws, when it hangs forever, and when the POST fails.
//        try/finally is still the load-bearing guarantee.

const signOutSpy = vi.fn();

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { signOut: signOutSpy } }),
}));

// happy-dom's window.location.assign is a no-op; spy so assertions can
// observe where the redirect points.
const assignSpy = vi.fn();
Object.defineProperty(window, 'location', {
  writable: true,
  value: { ...window.location, assign: assignSpy },
});

const fetchSpy = vi.fn<(input: unknown, init?: unknown) => Promise<unknown>>();

beforeEach(() => {
  signOutSpy.mockReset();
  assignSpy.mockReset();
  fetchSpy.mockReset();
  fetchSpy.mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetchSpy);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

import { logoutAndRedirect, LOGOUT_REVOKE_ENDPOINT, LOGOUT_REVOKE_TIMEOUT_MS } from './logout';
import { LAST_ACTIVITY_STORAGE_KEY } from './activityStorage';

const scopesUsed = () =>
  signOutSpy.mock.calls.map((c) => (c[0] as { scope: string } | undefined)?.scope);

describe('logoutAndRedirect — happy path', () => {
  beforeEach(() => { signOutSpy.mockResolvedValue({ error: null }); });

  it('revokes globally, then clears locally, then redirects', async () => {
    await logoutAndRedirect();

    // Order matters: local last, so a failed global cannot leave the
    // browser signed in.
    expect(scopesUsed()).toEqual(['global', 'local']);
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('fires the server-side revocation as a keepalive POST', async () => {
    await logoutAndRedirect();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(LOGOUT_REVOKE_ENDPOINT);
    expect(init.method).toBe('POST');
    // keepalive is what makes never-awaiting it safe: without it, firing
    // and navigating away would mean firing and cancelling.
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('same-origin');
  });

  it('honours a custom target (the InactivityGuard passes one)', async () => {
    await logoutAndRedirect('/login?reason=inactivity');
    expect(assignSpy).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it('drops the persisted idle timestamp', async () => {
    // Shared devices: the next person to sign in on this browser must not
    // inherit the previous user's last-activity time.
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(Date.now()));
    await logoutAndRedirect();
    expect(window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY)).toBeNull();
  });
});

describe('logoutAndRedirect — nothing that can hang blocks the redirect', () => {
  it('a global signOut that HANGS FOREVER still redirects, bounded by the timeout', async () => {
    // The original bug, reproduced as precisely as it can be: the network
    // call never comes back. Under the pre-'local' code this stranded the
    // user on the authenticated page forever.
    vi.useFakeTimers();
    signOutSpy.mockImplementation((opts: { scope: string }) =>
      opts.scope === 'global'
        ? new Promise(() => {})          // never settles
        : Promise.resolve({ error: null }),
    );

    const pending = logoutAndRedirect();

    // Still waiting — proves the race is real and not a no-op that would
    // make the rest of this test vacuous.
    expect(assignSpy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(LOGOUT_REVOKE_TIMEOUT_MS);
    await pending;

    expect(assignSpy).toHaveBeenCalledWith('/login');
    // And the local clear still happened despite the global never finishing.
    expect(scopesUsed()).toContain('local');
  });

  it('the keepalive POST is not awaited — a hanging POST does not delay anything', async () => {
    signOutSpy.mockResolvedValue({ error: null });
    fetchSpy.mockImplementation(() => new Promise(() => {}));   // never settles

    // No fake timers, no advancing: if this were awaited the test would
    // time out rather than fail.
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });
});

describe('logoutAndRedirect — every failure mode still redirects', () => {
  it('signOut throws on BOTH calls → still redirects', async () => {
    signOutSpy.mockRejectedValue(new Error('Network down on mobile'));
    await logoutAndRedirect();
    // The finally clause is the load-bearing guarantee. Without it a flaky
    // mobile network leaves the user stranded on the authenticated page.
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('the GLOBAL call throws → the local clear still runs', async () => {
    signOutSpy.mockImplementation((opts: { scope: string }) =>
      opts.scope === 'global'
        ? Promise.reject(new Error('revocation refused'))
        : Promise.resolve({ error: null }),
    );
    await logoutAndRedirect();
    expect(scopesUsed()).toEqual(['global', 'local']);
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('the LOCAL call throws → still redirects', async () => {
    // e.g. localStorage access denied in a locked-down private tab.
    signOutSpy.mockImplementation((opts: { scope: string }) =>
      opts.scope === 'local'
        ? Promise.reject(new Error('localStorage denied'))
        : Promise.resolve({ error: null }),
    );
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('the POST rejects → still redirects, and no unhandled rejection escapes', async () => {
    signOutSpy.mockResolvedValue({ error: null });
    fetchSpy.mockRejectedValue(new Error('offline'));
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('signOut returns an error OBJECT → still redirects (no special handling)', async () => {
    signOutSpy.mockResolvedValue({ error: { message: 'session_not_found' } });
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
  });

  it('fetch missing entirely → still redirects AND still clears locally', async () => {
    // `fetch` can fail SYNCHRONOUSLY, not just reject — absent in an old
    // browser, stubbed away in a test, or throwing on a bad init. A bare
    // .catch() does not cover that, so the dispatch needs its own
    // try/catch: without one the throw skips both signOut calls and the
    // user ends up redirected but still signed in locally. Worse than the
    // bug we started with, and invisible.
    signOutSpy.mockResolvedValue({ error: null });
    vi.stubGlobal('fetch', undefined);
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
    expect(scopesUsed()).toEqual(['global', 'local']);
  });

  it('fetch throwing synchronously → same', async () => {
    signOutSpy.mockResolvedValue({ error: null });
    vi.stubGlobal('fetch', () => { throw new TypeError('Illegal invocation'); });
    await logoutAndRedirect();
    expect(assignSpy).toHaveBeenCalledWith('/login');
    expect(scopesUsed()).toEqual(['global', 'local']);
  });
});
