import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';
import { resolveBrandGroupIds, resolveBrandViewer } from './brandViewer';

// ─── The brand scope read, extracted ────────────────────────────────────────
//
// Five brand screens each inlined the same four lines — "which groups is this
// user an active brand admin of?" — followed by their own
// `length === 0 → redirect('/practice')`. Three of them now call one function.
//
// THIS IS AN EXTRACTION, SO THE TESTS ARE REGRESSION TESTS
// ───────────────────────────────────────────────────────
// The only thing that matters is that nobody's authorisation moved. So the first
// block below reproduces each inlined copy's EXACT query shape and asserts the
// shared function issues the same predicate, and the second asserts per call site
// that its downstream policy (which redirect, whether the n-rule applies) is
// untouched.
//
// WHY THE READ IS SEPARATE FROM resolveBrandViewer
// ────────────────────────────────────────────────
// resolveBrandViewer bundles the scope read with a practices read AND the
// n=0/n=1/n>=2 rule. /brand/revenue and /brand/group deliberately do NOT apply
// that rule — both render for a solo brand admin — so routing them through the
// viewer would have REDIRECTED those callers to /practice. That is a change in
// authorisation outcome, which this task forbids, and it is the reason the scope
// read is its own function rather than everything being folded into one.

type Row = Record<string, unknown>;

/** Records the exact predicate each query applied, so shapes can be compared. */
type Seen = { table: string; select: string; filters: Array<[string, unknown]> };

function makeClient(rows: Row[], seen: Seen[] = []) {
  return {
    seen,
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      let select = '';
      const b: Record<string, unknown> = {
        select: (s: string) => { select = s; return b; },
        eq: (c: string, v: unknown) => { filters.push([c, v]); return b; },
        in: () => b,
        order: () => b,
        then: (onFulfilled: (v: { data: Row[] }) => unknown) => {
          seen.push({ table, select, filters });
          const out = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
          return Promise.resolve({ data: out }).then(onFulfilled);
        },
      };
      return b;
    },
  };
}

const MEMBERSHIPS: Row[] = [
  { group_id: 'g1', user_id: 'me',      active: true  },
  { group_id: 'g2', user_id: 'me',      active: true  },
  { group_id: 'g3', user_id: 'me',      active: false },   // deactivated
  { group_id: 'g9', user_id: 'someone', active: true  },   // someone else's
];

// ─── The predicate is byte-for-byte what every inlined copy used ───────────

describe('the shared read issues exactly the predicate the inlined copies did', () => {
  it('filters on user_id AND active = true, on practice_group_members', async () => {
    const seen: Seen[] = [];
    await resolveBrandGroupIds(makeClient(MEMBERSHIPS, seen), 'me');
    expect(seen).toHaveLength(1);
    expect(seen[0].table).toBe('practice_group_members');
    expect(seen[0].filters).toEqual([['user_id', 'me'], ['active', true]]);
  });

  it('returns only the caller\'s ACTIVE memberships', async () => {
    expect(await resolveBrandGroupIds(makeClient(MEMBERSHIPS), 'me')).toEqual(['g1', 'g2']);
  });

  it('a deactivated membership buys nothing — the rule every copy enforced', async () => {
    const onlyInactive = [{ group_id: 'g3', user_id: 'ex', active: false }];
    expect(await resolveBrandGroupIds(makeClient(onlyInactive), 'ex')).toEqual([]);
  });

  it('another user\'s memberships never leak', async () => {
    expect(await resolveBrandGroupIds(makeClient(MEMBERSHIPS), 'stranger')).toEqual([]);
    expect(await resolveBrandGroupIds(makeClient(MEMBERSHIPS), 'someone')).toEqual(['g9']);
  });

  it('de-duplicates, which the inlined copies did not', async () => {
    // A doubled membership row would otherwise widen an .in() built from the
    // result. It cannot change what that .in() MATCHES, so this is
    // belt-and-braces rather than a fix for an observed bug — but it is a
    // difference from the previous behaviour and is stated as one.
    const doubled = [
      { group_id: 'g1', user_id: 'me', active: true },
      { group_id: 'g1', user_id: 'me', active: true },
    ];
    expect(await resolveBrandGroupIds(makeClient(doubled), 'me')).toEqual(['g1']);
  });

  it('survives a null data payload without throwing', async () => {
    const nullClient = {
      from: () => ({
        select: () => nullClient.from(),
        eq: () => nullClient.from(),
        then: (f: (v: { data: null }) => unknown) => Promise.resolve({ data: null }).then(f),
      }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    expect(await resolveBrandGroupIds(nullClient, 'me')).toEqual([]);
  });

  it('resolveBrandViewer now routes THROUGH it, rather than keeping its own copy', async () => {
    const seen: Seen[] = [];
    const client = makeClient(MEMBERSHIPS, seen);
    await resolveBrandViewer(client, client, 'me');
    // Its first read is still the membership read, with the same predicate.
    expect(seen[0].table).toBe('practice_group_members');
    expect(seen[0].filters).toEqual([['user_id', 'me'], ['active', true]]);
  });

  it('resolveBrandViewer still denies a caller with no active membership', async () => {
    const client = makeClient(MEMBERSHIPS);
    expect(await resolveBrandViewer(client, client, 'stranger')).toEqual({ kind: 'denied' });
  });
});

// ─── Per call site: the downstream policy is untouched ─────────────────────

describe('every call site authorises exactly as it did before the extraction', () => {
  const ROOT = resolve(process.cwd());
  const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

  const SCOPE_READ_SITES = [
    'app/brand/page.tsx',
    'app/brand/revenue/page.tsx',
    'app/brand/group/page.tsx',
  ];

  it.each(SCOPE_READ_SITES)('%s calls the shared read on its OWN client', (rel) => {
    const code = read(rel);
    // The caller's own client, never service-role — that is the half of this
    // that actually gates anything, since RLS is the boundary.
    expect(code).toMatch(/resolveBrandGroupIds\(supabase, user\.id\)/);
    expect(code).not.toMatch(/resolveBrandGroupIds\(s[,)]/);
    expect(code).not.toMatch(/resolveBrandGroupIds\(svc/);
  });

  it.each(SCOPE_READ_SITES)('%s no longer inlines the query', (rel) => {
    expect(read(rel)).not.toMatch(/from\('practice_group_members'\)/);
  });

  it.each(SCOPE_READ_SITES)('%s keeps its own empty-membership redirect', (rel) => {
    // The one authorisation decision each of these pages makes for itself.
    expect(read(rel)).toMatch(/groupIds\.length === 0\) redirect\('\/practice'\)/);
  });

  it.each(SCOPE_READ_SITES)('%s still bounces an unauthenticated caller FIRST', (rel) => {
    const code = read(rel);
    const auth  = code.indexOf('auth.getUser()');
    const login = code.indexOf("redirect('/login')");
    const scope = code.indexOf('resolveBrandGroupIds(supabase');
    expect(auth).toBeGreaterThan(0);
    expect(login).toBeGreaterThan(auth);
    expect(scope).toBeGreaterThan(login);
  });

  it('/brand keeps its n=0 and n=1 redirects — the extraction touched neither', () => {
    const code = read('app/brand/page.tsx');
    expect(code).toMatch(/branchRows\.length === 0\) redirect\('\/practice\/setup'\)/);
    expect(code).toMatch(/branchRows\.length === 1\) redirect\(`\/practice\?practiceId=/);
  });

  it('/brand/revenue and /brand/group still have NO n=1 rule — deliberately', () => {
    // Both render for a solo brand admin. This is the difference that stopped
    // them being routed through resolveBrandViewer, so it is asserted rather
    // than left as an absence somebody might "fix".
    for (const rel of ['app/brand/revenue/page.tsx', 'app/brand/group/page.tsx']) {
      const code = read(rel);
      expect(code, rel).not.toMatch(/redirect\('\/practice\/setup'\)/);
      expect(code, rel).not.toMatch(/length === 1\) redirect/);
    }
  });

  it('/brand/group still scopes to the FIRST group, unchanged', () => {
    // Pre-existing behaviour, documented on the page as a rare support case. The
    // extraction renamed the variable and nothing else.
    expect(read('app/brand/group/page.tsx')).toMatch(/const groupId = groupIds\[0\]/);
  });

  it('/brand/revenue still scopes both data reads by the resolved group ids', () => {
    const code = read('app/brand/revenue/page.tsx');
    expect(code).toMatch(/\.in\('group_id', groupIds\)/);
    expect(code).toMatch(/\.in\('practice_id', practiceIds\)/);
  });
});

// ─── The sites deliberately NOT converted ──────────────────────────────────

describe('the reads that were left alone, and why', () => {
  const ROOT = resolve(process.cwd());
  const read = (p: string) => stripComments(readFileSync(resolve(ROOT, p), 'utf8'));

  it('/brand/new-practice keeps its own read — it needs an embedded projection', () => {
    // Its select is `group_id, practice_groups(name)`: it needs the brand NAME in
    // the same round trip, which a groupIds-only helper cannot provide. Splitting
    // it into two queries would change the query count on a page this cleanup was
    // not asked to restructure, so it stays as it is — the predicate is identical,
    // only the projection differs.
    const code = read('app/brand/new-practice/page.tsx');
    expect(code).toMatch(/from\('practice_group_members'\)/);
    expect(code).toMatch(/practice_groups\(name\)/);
    expect(code).toMatch(/\.eq\('user_id', user\.id\)/);
    expect(code).toMatch(/\.eq\('active', true\)/);
  });

  it('app/brand/actions.ts asks a DIFFERENT question and is already extracted', () => {
    // "Am I a brand admin of THIS group?" — a single-row, group_id-scoped guard,
    // not the caller's-own-groups scope read. It already lives behind three guard
    // functions, so there is nothing here to de-duplicate.
    const code = read('app/brand/actions.ts');
    expect(code).toMatch(/async function guardBrandAdmin\(/);
    expect(code).toMatch(/async function guardBrandAdminOfPractice\(/);
    expect(code).toMatch(/async function guardBrandAdminOfMember\(/);
    // Its reads take a group_id and expect one row — the shape the scope read
    // does not have.
    expect(code).toMatch(/\.eq\('group_id', groupId\)[\s\S]{0,120}?\.maybeSingle\(\)/);
  });

  it('the same single-row guard shape lives on the practice side too, untouched', () => {
    // practiceViewer, practiceShellAuthority and pos/devices/actions all ask the
    // group_id-scoped question. Listed so the difference between the two shapes is
    // recorded rather than rediscovered.
    for (const rel of [
      'app/practice/practiceViewer.ts',
      'app/practice/practiceShellAuthority.ts',
      'app/practice/pos/devices/actions.ts',
    ]) {
      const code = read(rel);
      expect(code, rel).toMatch(/from\('practice_group_members'\)/);
      expect(code, rel).toMatch(/\.eq\('group_id'/);
    }
  });

  it('/dashboard keeps its own limit(1) existence check', () => {
    // Same predicate, but it only asks "any?" for a routing decision and uses
    // .limit(1) to say so. Outside app/brand, and swapping it would drop that
    // optimisation for no gain.
    const code = read('app/dashboard/page.tsx');
    expect(code).toMatch(/from\('practice_group_members'\)/);
    expect(code).toMatch(/\.limit\(1\)/);
  });
});
