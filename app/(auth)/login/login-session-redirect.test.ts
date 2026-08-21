import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── An already-signed-in visitor to /login is sent to their dashboard ────
//
// Before this, neither /login nor proxy.ts checked for an existing session,
// so a signed-in patient landing here (an old bookmark, the marketing
// header's session-unaware "Sign in" link) saw the login FORM again rather
// than being sent to /dashboard.
//
// Source-level, like every other test touching this file (see
// app/google-oauth.test.ts, app/password-reset-flow.test.ts, etc.) — the
// page pulls in usePasskeySignIn, ContinueWithGoogleButton and
// InstallCallout, and none of those tests render it either.

const ROOT = resolve(process.cwd());
const LOGIN = stripComments(
  readFileSync(resolve(ROOT, 'app/(auth)/login/page.tsx'), 'utf8').replace(/\r\n/g, '\n'),
);

describe('an existing session skips the form', () => {
  it('checks for a session and redirects when one exists', () => {
    expect(LOGIN).toMatch(/auth\.getSession\(\)/);
    expect(LOGIN).toMatch(/if\s*\([^)]*session\)\s*window\.location\.href\s*=/);
  });

  it('uses getSession, not getUser — this is a UX shortcut, not the security boundary', () => {
    // The real gate is server-side: nextPath's own destination re-checks via
    // requireConfirmedUser/getRequestUser and bounces back here if the
    // session turns out to be stale. A getUser() round trip here would only
    // slow down the common case (a visitor who is NOT signed in) for no
    // safety gained.
    const sessionCheckBlock = LOGIN.slice(LOGIN.indexOf('auth.getSession()') - 200, LOGIN.indexOf('auth.getSession()') + 200);
    expect(sessionCheckBlock).not.toMatch(/auth\.getUser\(\)/);
  });

  it('runs in its own effect, not folded into the ?next=/?message= parsing effect', () => {
    // That effect sets nextPath via setState; reading it back in the SAME
    // tick to redirect would race the update. The session check re-parses
    // ?next= itself instead of depending on that state.
    const notice   = LOGIN.indexOf("params.get('message')");
    const session  = LOGIN.indexOf('auth.getSession()');
    const between  = LOGIN.slice(notice, session);
    // They are different effects if a new `useEffect(() => {` opens between
    // the notice-parsing code and the session check.
    expect(between).toMatch(/}, \[\]\);[\s\S]*useEffect\(\(\) => \{/);
  });

  it('honours ?next= for the redirect, via the same safeNextParam allow-list', () => {
    const session = LOGIN.indexOf('auth.getSession()');
    const before   = LOGIN.slice(Math.max(0, session - 300), session);
    expect(before).toMatch(/safeNextParam\(params\.get\('next'\)\)/);
  });

  it('guards against a redirect firing after the component has unmounted', () => {
    const session = LOGIN.indexOf('auth.getSession()');
    const nearby   = LOGIN.slice(session, session + 200);
    expect(nearby).toMatch(/cancelled/);
  });
});
