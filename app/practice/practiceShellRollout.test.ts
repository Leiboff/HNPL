import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Part 2: the nav shell on EVERY authenticated practice screen ─────────
//
// Before: only /practice and /practice/members rendered PracticeShell.
// /practice/pos/devices and /practice/bills/new rendered a slim
// "← Back to dashboard" header with no sidebar, so from Till devices you
// could not reach Team or Practice details without going back first.
//
// Two things are pinned here:
//   1. Which screens render the shell (source-level, because the shell is
//      composed in async server components).
//   2. That the permission inputs are RESOLVED per screen — never
//      hardcoded — via the one shared resolver, so the sidebar keeps
//      reflecting real authority everywhere.

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
  'app/practice/members/page.tsx',
  'app/practice/pos/devices/page.tsx',
  'app/practice/bills/new/page.tsx',
] as const;

describe('every authenticated practice screen renders the shared nav shell', () => {
  it.each(SHELL_SCREENS)('%s renders PracticeShell', (path) => {
    const src = read(path);
    expect(src).toMatch(/import PracticeShell from/);
    expect(src).toMatch(/<PracticeShell/);
    expect(src).toMatch(/<\/PracticeShell>/);
  });

  it.each(SHELL_SCREENS)('%s resolves both permission inputs instead of hardcoding them', (path) => {
    const src = read(path);
    expect(src).toMatch(/resolvePracticeShellAuthority\(/);
    // The failure mode this bans: literal true/false on either prop, which
    // would make the sidebar stop reflecting real authority.
    expect(src).not.toMatch(/canManageTill=\{(true|false)\}/);
    expect(src).not.toMatch(/isBrandAdmin=\{(true|false)\}/);
  });

  it.each(SHELL_SCREENS)('%s passes the resolver output straight through', (path) => {
    const src = read(path);
    expect(src).toMatch(/isBrandAdmin=\{isBrandAdmin\}/);
    expect(src).toMatch(/canManageTill=\{canManageTill\}/);
  });

  it('the two former slim-header screens no longer hand-roll their own back-link header', () => {
    for (const path of ['app/practice/pos/devices/page.tsx', 'app/practice/bills/new/page.tsx']) {
      const src = read(path);
      // The shell's own header/nav supplies navigation now.
      expect(src).not.toMatch(/← Back to dashboard/);
    }
  });

  it('nobody hand-writes a second nav link list — the shared source stays the only one', () => {
    // getPracticeManagerLinks is the single source for the conditional
    // links; the desktop/mobile parity guard depends on that staying true.
    //
    // Comments are stripped first: these files legitimately DISCUSS the
    // "Practice details" link in prose (that's how the brand-admin gate
    // documents itself). What must not exist is a hand-built link — i.e.
    // the label as a quoted string in actual code, or an href to the route.
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

    for (const path of SHELL_SCREENS) {
      const code = stripComments(read(path));
      expect(code).not.toMatch(/['"`]Till devices['"`]/);
      expect(code).not.toMatch(/['"`]Practice details['"`]/);
      expect(code).not.toMatch(/href=["'`]\/brand\/branch\//);
    }
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
});

// ─── The shared resolver's own behaviour ──────────────────────────────────

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

function makeClient() {
  return {
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.maybeSingle = async () => ({
        data: (state[table] ?? []).find((r) => matches(r, filters)) ?? null,
      });
      return b;
    },
  };
}

beforeEach(() => {
  state = {
    practices: [
      { id: 'p1', group_id: 'g1' },
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
    expect(r).toEqual({ isBrandAdmin: true, canManageTill: true });
  });

  it('can_manage_practice alone grants canManageTill without brand-admin', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'plain-manager', 'p1', true);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: true });
  });

  it('a non-manager, non-brand-admin gets neither — the reduced nav set', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'biller', 'p1', false);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: false });
  });

  it('a DEACTIVATED brand-group membership does not count', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'ex-admin', 'p1', false);
    expect(r.isBrandAdmin).toBe(false);
  });

  it('a practice with no group_id resolves to not-brand-admin without throwing', async () => {
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p-orphan', false);
    expect(r).toEqual({ isBrandAdmin: false, canManageTill: false });
  });

  it('brand-admin of a DIFFERENT group gets nothing on this practice', async () => {
    state.practices.push({ id: 'p-other', group_id: 'g2' });
    const { resolvePracticeShellAuthority } = await import('./practiceShellAuthority');
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p-other', false);
    expect(r.isBrandAdmin).toBe(false);
  });
});

// ─── Part 3: branch page content is conditional on branch count ───────────

describe('Part 3 — /brand/branch/[practiceId] adapts to branch count', () => {
  const SRC = read('app/brand/branch/[practiceId]/page.tsx');

  it('counts the brand\'s branches from practices.group_id', () => {
    expect(SRC).toMatch(/from\('practices'\)[\s\S]{0,120}count: 'exact'[\s\S]{0,80}\.eq\('group_id', groupId\)/);
    expect(SRC).toMatch(/const isMultiBranch = branchCount > 1/);
  });

  it('a null group_id is treated as a single branch, not a crash', () => {
    expect(SRC).toMatch(/let branchCount = 1/);
    expect(SRC).toMatch(/if \(groupId\) \{/);
  });

  it('the revenue rollup renders ONLY for a multi-branch brand', () => {
    expect(SRC).toMatch(/\{isMultiBranch && \([\s\S]{0,200}<BranchPerformance/);
  });

  it('details + banking are unconditional — never hidden from either audience', () => {
    expect(SRC).toMatch(/<BranchDetailsForm/);
    expect(SRC).toMatch(/<BranchBankingForm/);
    // Neither is wrapped in a branch-count condition.
    expect(SRC).not.toMatch(/isMultiBranch && \([\s\S]{0,200}<BranchDetailsForm/);
    expect(SRC).not.toMatch(/isMultiBranch && \([\s\S]{0,200}<BranchBankingForm/);
  });

  it('single-branch order puts details/banking ABOVE team; multi-branch keeps team above details', () => {
    const perfIdx    = SRC.indexOf('<BranchPerformance');
    const teamMulti  = SRC.indexOf('{isMultiBranch && (\n        <TeamSection');
    const detailsIdx = SRC.indexOf('<BranchDetailsForm');
    const teamSingle = SRC.indexOf('{!isMultiBranch && (');
    expect(perfIdx).toBeGreaterThan(-1);
    expect(teamMulti).toBeGreaterThan(perfIdx);      // multi: performance → team
    expect(detailsIdx).toBeGreaterThan(teamMulti);   // multi: team → details
    expect(teamSingle).toBeGreaterThan(detailsIdx);  // single: details/banking → team
  });

  it('the page\'s permission gating is untouched (regression)', () => {
    // Still brand-group membership or notFound(), on the user's own client.
    expect(SRC).toMatch(/from\('practice_group_members'\)/);
    expect(SRC).toMatch(/if \(!membership\) notFound\(\)/);
  });
});
