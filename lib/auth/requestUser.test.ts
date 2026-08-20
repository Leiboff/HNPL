import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { getRequestUser } from './requestUser';

// ─── The layout/page user de-duplication ─────────────────────────────────
//
// /patient and /provider are the only two async area layouts outside admin
// and crm. Each starts with requireConfirmedUser() — one
// `GET /auth/v1/user` — and then the page inside asked the same question
// again. Two identical validation round trips per view, for an answer that
// cannot change mid-request.
//
// What follows pins the three things that make the fix both effective and
// safe, in descending order of how much damage getting them wrong would do:
//
//   1. Every converted call site STILL makes its own authorisation decision.
//      This is the one that matters. De-duplicating the network call is
//      fine; de-duplicating the DECISION would be a hole.
//   2. The memo can actually hit — it takes no arguments.
//   3. Server actions were NOT converted, and are a different request
//      anyway, so nothing about them is claimed.

const ROOT = resolve(process.cwd());
const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

/** Pages under an async area layout that resolves the user themselves. */
const CONVERTED = [
  'app/patient/page.tsx',
  'app/patient/account/page.tsx',
  'app/patient/explore/page.tsx',
  'app/patient/orders/page.tsx',
  'app/patient/orders/[planId]/page.tsx',
  'app/patient/orders/[planId]/confirm/page.tsx',
  'app/patient/practitioner/[memberId]/page.tsx',
  'app/provider/page.tsx',
  'app/provider/profile/page.tsx',
];

const LAYOUTS = ['app/patient/layout.tsx', 'app/provider/layout.tsx'];

describe('the authorisation DECISION is still made at every call site', () => {
  it.each(CONVERTED)('%s still refuses an unauthenticated caller itself', (file) => {
    // THE adversarial case for this change. Sharing the validated user is
    // sound; skipping the check on the strength of "the layout already
    // checked" is not — a page must not become reachable without a session
    // merely because something upstream looked. Each of these still guards.
    const code = read(file);
    expect(code).toMatch(/const user = await getRequestUser\(\);/);
    expect(code).toMatch(/if \(!user\) redirect\('\/login'\);/);
    // And the guard is immediately after the resolution, not somewhere later
    // with reads in between — a page that fetched first and refused second
    // would have already touched data on behalf of a caller it then rejects.
    const marker = 'const user = await getRequestUser();';
    const at     = code.indexOf(marker);
    const guard  = code.indexOf("if (!user) redirect('/login');");
    expect(guard).toBeGreaterThan(at);
    // Measured from the END of the resolution statement: the resolution's own
    // await obviously does not count against it.
    expect(code.slice(at + marker.length, guard)).not.toMatch(/\bawait\b/);
  });

  it.each(CONVERTED)('%s no longer issues its own auth.getUser() round trip', (file) => {
    // Server actions in the same files legitimately keep theirs — they run in
    // their OWN request, where there is nothing to share with. So this asserts
    // absence only within the default-exported component.
    const code = read(file);
    const component = code.slice(code.indexOf('export default async function'));
    expect(component).not.toMatch(/auth\.getUser\(\)/);
  });

  it('the two layouts still run the full gate, unchanged', () => {
    for (const file of LAYOUTS) {
      const code = read(file);
      expect(code, file).toMatch(/await requireConfirmedUser\(/);
      // The role gate and its redirects are the layout's job and still here.
      expect(code, file).toMatch(/redirect\('\/login'\)/);
      expect(code, file).toMatch(/profile\?\.role/);
    }
  });

  it('requireConfirmedUser still redirects on both of its own conditions', () => {
    // The helper now gets its user from the memo, but it is the GATE, and the
    // gate is not memoised: no session still bounces to /login, and an
    // unconfirmed email still bounces to /verify-email. Neither may become
    // conditional on being the first caller.
    const code = read('lib/auth/requireConfirmedUser.ts');
    expect(code).toMatch(/const user = await getRequestUser\(\);/);
    expect(code).toMatch(/if \(!user\) \{\s*redirect\(options\.unauthenticatedRedirect \?\? '\/login'\);/);
    expect(code).toMatch(/if \(!user\.email_confirmed_at\) \{/);
    expect(code).toMatch(/redirect\(`\/verify-email\?\$\{params\.toString\(\)\}`\)/);
    // It is NOT itself wrapped in cache() — `options` differs per caller, so
    // it would key on a fresh object and never hit, and a memoised redirect()
    // throw is not something to introduce on an auth path.
    expect(code).not.toMatch(/cache\(/);
  });
});

describe('the memo is shaped so that it can actually hit', () => {
  it('takes no arguments', () => {
    // cache() keys on argument identity. Passing the caller's Supabase client
    // in would give the layout and the page different keys, every lookup would
    // miss, and the file would be pure overhead — the exact trap documented in
    // lib/patient/requestProfile.ts. Zero arguments means exactly one key.
    expect(getRequestUser.length).toBe(0);
  });

  it('builds its own client rather than accepting one', () => {
    const code = read('lib/auth/requestUser.ts');
    expect(code).toMatch(/cache\(async \(\) => \{/);
    expect(code).toMatch(/const supabase = await createClient\(\);/);
    // Deliberately not memoising the client itself: that would change cookie
    // and refresh behaviour for every caller in the tree and save no round
    // trips, since building a client is not a network call.
    expect(code).not.toMatch(/cache\(async \(\) => createClient/);
  });

  it('validates rather than trusting the cookie', () => {
    // getUser() re-validates the JWT against the auth server; getSession()
    // reads the cookie and believes it. Swapping to the latter would make this
    // file a security regression rather than a latency fix, so it is pinned.
    const code = read('lib/auth/requestUser.ts');
    expect(code).toMatch(/auth\.getUser\(\)/);
    expect(code).not.toMatch(/auth\.getSession\(\)/);
  });
});

describe('server actions were left alone', () => {
  it('app/patient/account/actions.ts keeps auth.getUser() in its server actions', () => {
    // Moved out of the account page during the accordion→screens
    // conversion, into a standalone actions module both the index page
    // (well, now Personal details) and any future caller can import.
    // Still whole-file, not sliced before a default export — this module
    // has no page component at all, it is entirely server actions.
    const code = read('app/patient/account/actions.ts');
    expect(code).toMatch(/auth\.getUser\(\)/);
    expect(code).toMatch(/return \{ error:/);
  });

  it('app/provider/profile/page.tsx keeps auth.getUser() in its server actions', () => {
    // A server action is its own request, so there is no sibling caller to
    // share with and nothing to gain; more to the point, its failure mode
    // differs — it returns an error object rather than redirecting, and
    // that distinction is load-bearing for the form UI.
    const code = read('app/provider/profile/page.tsx');
    const actions = code.slice(0, code.indexOf('export default async function'));
    expect(actions).toMatch(/auth\.getUser\(\)/);
    expect(actions).toMatch(/return \{ error:/);
  });
});
