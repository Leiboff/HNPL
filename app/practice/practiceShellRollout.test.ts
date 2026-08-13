import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── The nav shell on EVERY authenticated practice screen ─────────────
//
// Before: only /practice and /practice/members rendered PracticeShell.
// /practice/pos/devices and /practice/bills/new rendered a slim
// "← Back to dashboard" header with no sidebar, so from Till devices you
// could not reach Team or Practice details without going back first.
//
// The set changed with the nav restructure. /practice/details and
// /practice/pos/devices are no longer shell screens — they are thin
// redirects into /practice/settings, which now hosts their content as
// sections. /practice/settings and /practice/bills took their place. The
// two stubs are pinned as redirects in
// app/practice/details/practiceDetails.test.ts, so their absence from the
// list below is asserted somewhere rather than being a silent hole.
//
// Three things are pinned here:
//   1. Which screens render the shell (source-level, because the shell is
//      composed in async server components).
//   2. That the permission inputs are RESOLVED per screen — never
//      hardcoded — via the one shared resolver, so the sidebar keeps
//      reflecting real authority everywhere.
//   3. That the shell's inputs reach it unmodified.

function read(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

// Every authenticated /practice/** screen. /practice/setup is excluded on
// purpose: it redirects to /practice the moment a membership exists, so it
// only ever runs pre-practice — there is no practice to build a shell for.
// /practice/pos and /practice/pos/register are device-credential routes with
// no user session at all.
const SHELL_SCREENS = [
  'app/practice/page.tsx',
  'app/practice/bills/page.tsx',
  'app/practice/bills/new/page.tsx',
  'app/practice/members/page.tsx',
  'app/practice/settings/page.tsx',
] as const;

// The two routes that used to be in the list above and are now redirects.
// Kept named here so "why is /practice/details not a shell screen any more"
// has an answer in this file rather than only in the other one.
const REDIRECT_STUBS = [
  'app/practice/details/page.tsx',
  'app/practice/pos/devices/page.tsx',
] as const;

describe('every authenticated practice screen renders the shared nav shell', () => {
  it.each(SHELL_SCREENS)('%s renders PracticeShell', (path) => {
    const src = read(path);
    expect(src).toMatch(/import PracticeShell from/);
    expect(src).toMatch(/<PracticeShell/);
    expect(src).toMatch(/<\/PracticeShell>/);
  });

  it.each(SHELL_SCREENS)('%s resolves its permission inputs instead of hardcoding them', (path) => {
    const src = read(path);
    expect(src).toMatch(/resolvePracticeShellAuthority\(/);
    // The failure mode this bans: literal true/false on any of the
    // permission-gated props, which would make the nav stop reflecting
    // real authority.
    expect(src).not.toMatch(/canManageTill=\{(true|false)\}/);
    expect(src).not.toMatch(/isBrandAdmin=\{(true|false)\}/);
    expect(src).not.toMatch(/brandPracticeCount=\{\d+\}/);
  });

  it.each(SHELL_SCREENS)('%s passes the resolver output straight through', (path) => {
    const src = read(path);
    expect(src).toMatch(/isBrandAdmin=\{isBrandAdmin\}/);
    expect(src).toMatch(/canManageTill=\{canManageTill\}/);
    expect(src).toMatch(/brandPracticeCount=\{brandPracticeCount\}/);
  });

  it('no screen hand-rolls its own back-link header — the shell supplies navigation', () => {
    for (const path of SHELL_SCREENS) {
      expect(read(path)).not.toMatch(/← Back to dashboard/);
    }
  });

  it('nobody hand-writes a second nav link list — the shared source stays the only one', () => {
    // getPracticeNavLinks is the single source for EVERY nav link now (base
    // links included, since the restructure); the desktop/mobile parity
    // guard depends on that staying true.
    //
    // Comments are stripped first: these files legitimately DISCUSS the nav
    // in prose (that's how the gates document themselves). What must not
    // exist is a hand-built link — i.e. a nav label as a quoted string in
    // actual code, or an href to a nav destination.
    // LINE comments first, then block comments. The order is load-bearing:
    // these files discuss route globs like `/practice/*` and
    // `app/practice/pos/devices/**` inside `//` prose, and a `/*` in there
    // reads as the start of a block comment — so stripping blocks first
    // deletes everything up to the next `*/` (in a .tsx file, the first
    // `{/* … */}` in the JSX) and makes the absence assertions below pass on
    // a source that is mostly missing.
    const stripComments = (s: string) =>
      s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

    for (const path of SHELL_SCREENS) {
      const code = stripComments(read(path));
      expect(code, path).not.toMatch(/['"`]← All practices['"`]/);
      expect(code, path).not.toMatch(/['"`]Manage Practice['"`]/);
    }
    // NOTE deliberately not asserted:
    //   • the dashboard's own inline "See all my practices (N)" link to
    //     /brand. That predates the nav exit link, is worded and gated
    //     differently (membership count, not brand size), and is a page
    //     element rather than a nav entry.
    //   • the Settings page's in-page jump list, and its "Till devices"
    //     section heading. Those are anchors and a heading WITHIN one
    //     screen, built from ./settings/settingsSections — not a second
    //     copy of the sidebar.
    //   • the recent-bills card's "See all →". A page element pointing at
    //     one tab, not a nav list.
  });

  it('/practice/setup is deliberately shell-less (it runs only before a practice exists)', () => {
    const src = read('app/practice/setup/page.tsx');
    expect(src).not.toMatch(/<PracticeShell/);
    // Proof of the reason, so this exclusion can't silently become wrong:
    // it bounces to /practice as soon as an active membership is found.
    expect(src).toMatch(/if \(membership\) \{\s*\n?\s*redirect\('\/practice'\)/);
  });

  it('every shell screen keeps its existing auth gate (regression)', () => {
    for (const path of SHELL_SCREENS) {
      expect(read(path)).toMatch(/requireConfirmedUser/);
    }
  });

  it('the two ex-shell routes are redirects, which is why they left the list', () => {
    // Without this, dropping a screen from SHELL_SCREENS would be a way to
    // silently exempt it from every assertion above.
    for (const path of REDIRECT_STUBS) {
      const src = read(path);
      expect(src, path).toMatch(/redirect\(`\/practice\/settings/);
      expect(src, path).not.toMatch(/<PracticeShell/);
      // They still require a login — a redirect is not a reason to widen the
      // anon-reachable set (see practice-routes-auth.test.ts).
      expect(src, path).toMatch(/requireConfirmedUser/);
    }
  });

  it('PracticeShell threads brandPracticeCount to BOTH nav surfaces', () => {
    const shell = read('app/practice/PracticeShell.tsx');
    expect(shell).toMatch(/<PracticeHeader[\s\S]{0,240}brandPracticeCount=\{brandPracticeCount\}/);
    expect(shell).toMatch(/<PracticeNav[\s\S]{0,240}brandPracticeCount=\{brandPracticeCount\}/);
  });
});

// ─── The shared resolver's own behaviour ──────────────────────────────────

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

// Thenable builder — resolvePracticeShellAuthority now awaits a
// head+count query directly (no .maybeSingle()), so the fake has to
// resolve like a real PostgrestBuilder does or the count assertions
// below would pass for the wrong reason.
function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const rows = () => (state[table] ?? []).filter((r) => matches(r, filters));
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.maybeSingle = async () => ({ data: rows()[0] ?? null });
      b.then = (onFulfilled: (v: { data: Row[]; count: number }) => unknown) =>
        Promise.resolve({ data: rows(), count: rows().length }).then(onFulfilled);
      return b;
    },
  };
}

beforeEach(() => {
  state = {
    practices: [
      { id: 'p1',       group_id: 'g1' },
      { id: 'p2',       group_id: 'g1' },
      { id: 'p-orphan', group_id: null },
    ],
    practice_group_members: [
      { group_id: 'g1', user_id: 'brand-admin', active: true },
      { group_id: 'g1', user_id: 'ex-admin',    active: false },
    ],
  };
});

describe('resolvePracticeShellAuthority', () => {
  it('an active brand-admin row grants isBrandAdmin, and canManageTill follows', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p1', false);
    expect(r.isBrandAdmin).toBe(true);
    expect(r.canManageTill).toBe(true);
  });

  it('can_manage_practice alone grants canManageTill without brand-admin', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'plain-manager', 'p1', true);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: true, brandPracticeCount: 0 });
  });

  it('a non-manager, non-brand-admin gets neither — the reduced nav set', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'biller', 'p1', false);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: false, brandPracticeCount: 0 });
  });

  it('a DEACTIVATED brand-group membership does not count', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'ex-admin', 'p1', false);
    expect(r.isBrandAdmin).toBe(false);
    expect(r.brandPracticeCount).toBe(0);
  });

  it('a practice with no group_id resolves to not-brand-admin without throwing', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p-orphan', false);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: false, brandPracticeCount: 0 });
  });

  it('brand-admin of a DIFFERENT group gets nothing on this practice', async () => {
    state.practices.push({ id: 'p-other', group_id: 'g2' });
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p-other', false);
    expect(r.isBrandAdmin).toBe(false);
  });

  // ── brandPracticeCount — gates the "← All practices" exit link ──────
  it('counts the practices in the brand for a brand-admin', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p1', false);
    expect(r.brandPracticeCount).toBe(2);   // p1 + p2 share g1
  });

  it('reports 1 for a solo owner — brand-admin of their own single-practice brand', async () => {
    state.practices = [{ id: 'p1', group_id: 'g1' }];
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p1', false);
    expect(r.isBrandAdmin).toBe(true);          // still a brand-admin…
    expect(r.brandPracticeCount).toBe(1);       // …but the exit link stays hidden
  });

  it('does not count for a non-brand-admin — the query is never even run', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'plain-manager', 'p1', true);
    expect(r.brandPracticeCount).toBe(0);
  });
});
