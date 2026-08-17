import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { LOGOUT_REVOKE_ENDPOINT, LOGOUT_REVOKE_TIMEOUT_MS } from './logout';

// ─── Server-side revocation, and the bug it must not reintroduce ─────────
//
// WHAT WAS WRONG
//   logoutAndRedirect called signOut({ scope: 'local' }), which clears the
//   browser and makes NO server call. So logging out did not invalidate
//   the refresh token: a token captured before logout kept working. The
//   same was true of a password change — the credential changed and every
//   other session stayed alive, which is the opposite of what a reset is
//   for.
//
// WHY IT WAS LIKE THAT — and why this is a re-derivation, not a flip
//   scope:'local' was a deliberate choice, not an oversight. The default
//   scope:'global' POSTs to Supabase, and an unguarded
//   `await signOut()` before a redirect meant that on a flaky mobile
//   network the call could hang or throw — and since the redirect ran
//   AFTER the await, a throw killed it. React swallows uncaught
//   event-handler errors, so the user tapped Log out and saw nothing
//   happen.
//
//   That reasoning is still correct and must survive. The constraint it
//   implies is not "never call the server", it is:
//
//     THE REDIRECT MUST NOT BE REACHABLE FROM A NETWORK CALL'S RESULT.
//
//   So the tests below pin the SHAPE that satisfies both: revocation
//   happens, and nothing that can hang sits on the path to the redirect.
//   An unbounded `await signOut({ scope: 'global' })` would satisfy the
//   first and break the second — which is exactly the regression this
//   file exists to catch.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

const LOGOUT   = read('lib/auth/logout.ts');
const ROUTE    = read('app/api/auth/logout/route.ts');
const PASSWORD = read('app/update-password/UpdatePasswordForm.tsx');
const PROXY    = read('proxy.ts');

describe('the original bug stays fixed', () => {
  it('the redirect is still in `finally`, still window.location.assign(target)', () => {
    expect(LOGOUT).toMatch(/finally\s*\{[\s\S]*?window\.location\.assign\(target\)/);
  });

  it('there is NO unbounded await of a global signOut', () => {
    // The precise regression. A bare `await supabase.auth.signOut({ scope:
    // 'global' })` — with nothing racing it — puts a hangable network call
    // back on the path to the redirect.
    //
    // Matched as "an await of signOut whose scope is global and which is
    // not inside a Promise.race". Checked structurally below rather than by
    // one clever regex, because a clever regex is how this kind of pin ends
    // up passing for the wrong reason.
    const globalCalls = [...LOGOUT.matchAll(/signOut\(\{\s*scope:\s*'global'\s*\}\)/g)];
    expect(globalCalls.length).toBe(1);

    const idx = globalCalls[0].index!;
    // Walk back to the nearest statement boundary and confirm the call is
    // introduced by Promise.race, not by a bare await.
    const before = LOGOUT.slice(Math.max(0, idx - 200), idx);
    expect(before).toMatch(/Promise\.race\(\[/);
    expect(before).not.toMatch(/await supabase\.auth\.$/);
  });

  it('the global call is time-bounded, and the bound is short', () => {
    expect(LOGOUT).toMatch(/Promise\.race\(\[/);
    expect(LOGOUT).toMatch(/setTimeout\(resolve, LOGOUT_REVOKE_TIMEOUT_MS\)/);
    // Long enough for a healthy round trip, short enough that a hanging
    // one is not mistaken for a dead button.
    expect(LOGOUT_REVOKE_TIMEOUT_MS).toBeGreaterThanOrEqual(500);
    expect(LOGOUT_REVOKE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });

  it('a LOCAL signOut still runs unconditionally after it', () => {
    // signOut({scope:'global'}) clears browser state only on SUCCESS —
    // auth-js does the network call first and removes the local session
    // after. So a hung global call would leave the user signed in locally:
    // the original bug wearing a different hat. The local clear is what
    // makes the race safe.
    const globalAt = LOGOUT.indexOf("scope: 'global'");
    const localAt  = LOGOUT.indexOf("scope: 'local'");
    expect(globalAt).toBeGreaterThan(0);
    expect(localAt).toBeGreaterThan(globalAt);
    expect(LOGOUT).toMatch(/await supabase\.auth\.signOut\(\{ scope: 'local' \}\)/);
  });

  it('the server-side request is never awaited, and keepalive is why that is safe', () => {
    // keepalive tells the browser to finish the request even though the
    // document is navigating away. Without it, fire-and-forget would mean
    // fire-and-cancel and nothing would be revoked.
    expect(LOGOUT).toMatch(/void fetch\(LOGOUT_REVOKE_ENDPOINT/);
    expect(LOGOUT).toMatch(/keepalive:\s*true/);
    expect(LOGOUT).not.toMatch(/await fetch\(/);
  });

  it('every failure path is logged, and none of them can block the redirect', () => {
    expect(LOGOUT).toMatch(/\.catch\(/);
    expect(LOGOUT).toMatch(/console\.error/);
  });

  it('the persisted idle timestamp is dropped on logout', () => {
    // Shared devices: the next person to sign in on this browser must not
    // inherit the previous user's last-activity time.
    expect(LOGOUT).toMatch(/clearStoredActivity\(\)/);
  });
});

describe('the revocation endpoint', () => {
  it('the client and the route agree on the path', () => {
    expect(LOGOUT_REVOKE_ENDPOINT).toBe('/api/auth/logout');
  });

  it('is a POST, not a GET', () => {
    // A GET would be prefetchable and link-triggerable.
    expect(ROUTE).toMatch(/export async function POST\(/);
    expect(ROUTE).not.toMatch(/export async function GET\(/);
    expect(LOGOUT).toMatch(/method:\s*'POST'/);
  });

  it('revokes GLOBALLY — every refresh token for the user', () => {
    expect(ROUTE).toMatch(/signOut\(\{\s*scope:\s*'global'\s*\}\)/);
  });

  it('uses the cookie-bound server client, so signOut can see the session', () => {
    expect(ROUTE).toMatch(/from '@\/lib\/supabase\/server'/);
    expect(ROUTE).toMatch(/await createClient\(\)/);
  });

  it('reports failure rather than swallowing it', () => {
    // The client cannot read this response — it is already navigating — so
    // the status exists purely so a systematic failure is visible instead
    // of silently degrading every logout to local-only.
    expect(ROUTE).toMatch(/status:\s*502/);
    expect(ROUTE).toMatch(/console\.error/);
  });

  it('handles both an error RESULT and a thrown error', () => {
    // supabase-js returns { error } for API failures and throws for
    // transport ones. Missing either leaves an unhandled rejection.
    expect(ROUTE).toMatch(/if \(error\)/);
    expect(ROUTE).toMatch(/catch \(err\)/);
  });
});

describe('password change revokes other sessions', () => {
  it('signs out OTHER sessions after a successful change', () => {
    // The usual reason to reset a password is that somebody else may hold
    // a session. Before this, the reset changed the credential and left
    // them signed in.
    expect(PASSWORD).toMatch(/signOut\(\{\s*scope:\s*'others'\s*\}\)/);
  });

  it("uses 'others', not 'global' — this browser stays signed in", () => {
    // The user is about to be sent to /dashboard, and they just proved
    // control of the account here.
    expect(PASSWORD).not.toMatch(/signOut\(\{\s*scope:\s*'global'\s*\}\)/);
  });

  it('runs only on the SUCCESS path, after updateUser', () => {
    const updateAt = PASSWORD.indexOf('updateUser({ password })');
    const revokeAt = PASSWORD.indexOf("scope: 'others'");
    const errorAt  = PASSWORD.indexOf('if (supErr)');
    expect(updateAt).toBeGreaterThan(0);
    expect(errorAt).toBeGreaterThan(updateAt);
    expect(revokeAt).toBeGreaterThan(errorAt);
  });

  it('runs BEFORE the redirect, so it cannot be cut short by navigation', () => {
    const revokeAt   = PASSWORD.indexOf("scope: 'others'");
    const redirectAt = PASSWORD.indexOf("window.location.href = '/dashboard'");
    expect(redirectAt).toBeGreaterThan(revokeAt);
  });

  it('a revocation failure does not tell the user their password failed', () => {
    // It didn't — updateUser succeeded. Logged, not surfaced.
    const idx = PASSWORD.indexOf("scope: 'others'");
    const scope = PASSWORD.slice(idx, idx + 400);
    expect(scope).toMatch(/console\.error/);
    expect(scope).not.toMatch(/setError\(/);
  });
});

describe('all four revocation surfaces exist', () => {
  it('logout, the endpoint, the password change, and the absolute cap', () => {
    // Enumerated so a future removal of any one of them is visible as a
    // failing test rather than as a quiet gap.
    expect(LOGOUT).toMatch(/scope: 'global'/);      // client, raced
    expect(ROUTE).toMatch(/scope: 'global'/);       // server, keepalive POST
    expect(PASSWORD).toMatch(/scope: 'others'/);    // password change
    expect(PROXY).toMatch(/scope: 'global'/);       // absolute cap
  });

  it('an access token is still a stateless JWT and none of this revokes it mid-life', () => {
    // Documented in the code rather than asserted about behaviour, because
    // it is a property of the token format and not of our choices: up to
    // one token lifetime of validity survives every logout. Revocation
    // bounds the REFRESH token, which is the part that would otherwise
    // last 400 days.
    const raw = readFileSync(resolve(ROOT, 'lib/auth/logout.ts'), 'utf8');
    expect(raw).toMatch(/stateless JWT/);
  });
});
