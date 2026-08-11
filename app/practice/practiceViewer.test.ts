import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolvePracticeViewer } from './practiceViewer';

// ─── Which practice, and by what authority ─────────────────────────────
//
// /brand/branch/[practiceId] now pivots into /practice, so a brand-admin
// clicking into a branch lands in that practice's ordinary dashboard.
// This resolver is what makes that land on the RIGHT practice with the
// RIGHT authority, and the constraint it has to honour is that "as if
// it's their only practice" means VISUALLY identical — NOT that a
// brand-admin is treated as a practice member.
//
// So the two paths must stay distinguishable, and the adversarial cases
// are the point of this file:
//   • a brand-admin with NO practice_members row still resolves;
//   • a brand-admin of a DIFFERENT group gets nothing;
//   • a deactivated brand-group row gets nothing;
//   • brand authority never becomes canManagePractice.

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n');

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};
/** Every table the SERVICE-ROLE fake was asked to read. */
let serviceReads: string[] = [];

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

function makeClient(onRead?: (table: string) => void, bypassRls = false) {
  return {
    from(table: string) {
      onRead?.(table);
      // Service-role sees ground truth; the caller's own client sees only
      // what clientFor() narrowed `practices` down to.
      const source = bypassRls && table === 'practices' ? '__allPractices' : table;
      const filters: Array<[string, unknown]> = [];
      const rows = () => (state[source] ?? []).filter((r) => matches(r, filters));
      const b: Record<string, unknown> = {};
      b.select = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.order = () => b;
      b.limit = () => b;
      b.maybeSingle = async () => ({ data: rows()[0] ?? null });
      b.then = (onFulfilled: (v: { data: Row[] }) => unknown) =>
        Promise.resolve({ data: rows() }).then(onFulfilled);
      return b;
    },
  };
}

const own = () => makeClient();
const svc = () => makeClient((t) => serviceReads.push(t), true);

/**
 * The caller's own client can only SEE what RLS lets it see. That is
 * load-bearing for this resolver — the brand path's first read is
 * `practices.group_id` on the caller's own client, and 0061's
 * brand_admin_select_branches is what makes it visible at all. So the
 * fake mirrors RLS: a practices row is only visible to a member of it or
 * to an active brand-admin of its group.
 */
function visiblePracticesFor(userId: string): Row[] {
  const all = state.__allPractices ?? [];
  return all.filter((p) => {
    const isMember = (state.practice_members ?? []).some(
      (m) => m.practice_id === p.id && m.user_id === userId && m.active === true,
    );
    const isBrandAdmin = !!p.group_id && (state.practice_group_members ?? []).some(
      (g) => g.group_id === p.group_id && g.user_id === userId && g.active === true,
    );
    return isMember || isBrandAdmin;
  });
}

function clientFor(userId: string) {
  state.practices = visiblePracticesFor(userId);
  return own();
}

beforeEach(() => {
  serviceReads = [];
  state = {
    // Ground truth; `practices` is derived per-caller to mimic RLS.
    __allPractices: [
      { id: 'branch-a', group_id: 'g1', name: 'Branch A', fee_percent: 10 },
      { id: 'branch-b', group_id: 'g1', name: 'Branch B', fee_percent: 12 },
      { id: 'rival',    group_id: 'g2', name: 'Rival Co', fee_percent: 8  },
      { id: 'solo',     group_id: null, name: 'Solo',     fee_percent: 6  },
    ],
    practice_members: [
      // A practice's own manager on branch-a.
      { practice_id: 'branch-a', user_id: 'staff-a', active: true, can_manage_practice: true,
        created_at: '2026-01-01', practices: { name: 'Branch A', fee_percent: 10 } },
      // A biller on branch-a — member, but not a manager.
      { practice_id: 'branch-a', user_id: 'biller', active: true, can_manage_practice: false,
        created_at: '2026-01-02', practices: { name: 'Branch A', fee_percent: 10 } },
      // The mainline brand owner: createBranch gives them an admin row on
      // every branch they create.
      { practice_id: 'branch-a', user_id: 'owner', active: true, can_manage_practice: true,
        created_at: '2026-01-03', practices: { name: 'Branch A', fee_percent: 10 } },
      { practice_id: 'branch-b', user_id: 'owner', active: true, can_manage_practice: true,
        created_at: '2026-01-04', practices: { name: 'Branch B', fee_percent: 12 } },
    ],
    practice_group_members: [
      { group_id: 'g1', user_id: 'owner',        active: true  },
      // The edge case: brand authority with no practice_members row.
      { group_id: 'g1', user_id: 'invited-ba',   active: true  },
      { group_id: 'g1', user_id: 'ex-ba',        active: false },
      { group_id: 'g2', user_id: 'rival-ba',     active: true  },
    ],
  };
});

describe('member path — unchanged behaviour for a practice\'s own staff', () => {
  it('with no ?practiceId= it picks the oldest membership', async () => {
    const r = await resolvePracticeViewer(clientFor('owner'), svc(), 'owner');
    expect(r).toEqual({
      kind: 'ok',
      scope: {
        practiceId: 'branch-a', practiceName: 'Branch A', feePercent: 10,
        canManagePractice: true, viaBrandAdmin: false, membershipCount: 2,
      },
    });
  });

  it('an explicit ?practiceId= the caller IS a member of wins', async () => {
    const r = await resolvePracticeViewer(clientFor('owner'), svc(), 'owner', 'branch-b');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.scope.practiceId).toBe('branch-b');
    expect(r.scope.viaBrandAdmin).toBe(false);
  });

  it('the member path never touches the service-role client', async () => {
    await resolvePracticeViewer(clientFor('staff-a'), svc(), 'staff-a', 'branch-a');
    expect(serviceReads).toEqual([]);
  });

  it('canManagePractice comes from the row — a biller stays a biller', async () => {
    const r = await resolvePracticeViewer(clientFor('biller'), svc(), 'biller', 'branch-a');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.scope.canManagePractice).toBe(false);
  });

  it('no memberships and no explicit practice → the signup flow', async () => {
    const r = await resolvePracticeViewer(clientFor('nobody'), svc(), 'nobody');
    expect(r).toEqual({ kind: 'setup' });
  });
});

describe('brand-admin path — real authority, not membership', () => {
  it('ADVERSARIAL: a brand-admin with NO practice_members row resolves the branch', async () => {
    const r = await resolvePracticeViewer(clientFor('invited-ba'), svc(), 'invited-ba', 'branch-b');
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.scope.practiceId).toBe('branch-b');
    expect(r.scope.practiceName).toBe('Branch B');
    expect(r.scope.viaBrandAdmin).toBe(true);
    expect(r.scope.membershipCount).toBe(0);
  });

  it('ADVERSARIAL: brand authority is NOT converted into a practice-member capability', async () => {
    const r = await resolvePracticeViewer(clientFor('invited-ba'), svc(), 'invited-ba', 'branch-b');
    if (r.kind !== 'ok') throw new Error('expected ok');
    // The whole point of the constraint: visually identical dashboard,
    // but canManagePractice is a practice_members fact and this caller
    // has no such row. It must stay false.
    expect(r.scope.canManagePractice).toBe(false);
  });

  it('ADVERSARIAL: a brand-admin of a DIFFERENT group gets nothing', async () => {
    const r = await resolvePracticeViewer(clientFor('rival-ba'), svc(), 'rival-ba', 'branch-a');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('ADVERSARIAL: a DEACTIVATED brand-group row gets nothing', async () => {
    const r = await resolvePracticeViewer(clientFor('ex-ba'), svc(), 'ex-ba', 'branch-a');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('ADVERSARIAL: a stranger with no authority at all gets nothing', async () => {
    const r = await resolvePracticeViewer(clientFor('stranger'), svc(), 'stranger', 'branch-a');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('ADVERSARIAL: a practice member of ANOTHER practice cannot borrow that membership', async () => {
    // staff-a is an active manager on branch-a. Asking for branch-b must
    // not fall back to branch-a (the old silent-fallback bug) and must
    // not authorise branch-b either.
    const r = await resolvePracticeViewer(clientFor('staff-a'), svc(), 'staff-a', 'branch-b');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('THE OLD BUG: an unmatched explicit practiceId no longer silently resolves a DIFFERENT practice', async () => {
    const r = await resolvePracticeViewer(clientFor('biller'), svc(), 'biller', 'rival');
    expect(r.kind).not.toBe('ok');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('a standalone practice (group_id null) can never be reached by the brand path', async () => {
    // is_brand_admin_of_practice returns false for a null group_id, and so
    // does this: there is no group to hold a membership in.
    const r = await resolvePracticeViewer(clientFor('owner'), svc(), 'owner', 'solo');
    expect(r).toEqual({ kind: 'denied' });
  });

  it('the practice is named via service-role ONLY after authority is proven', async () => {
    await resolvePracticeViewer(clientFor('invited-ba'), svc(), 'invited-ba', 'branch-b');
    expect(serviceReads).toEqual(['practices']);

    serviceReads = [];
    await resolvePracticeViewer(clientFor('rival-ba'), svc(), 'rival-ba', 'branch-a');
    expect(serviceReads).toEqual([]);   // denied → nothing elevated ran
  });

  it('the MAINLINE brand owner travels the MEMBER path, not this one', async () => {
    // createBranch inserts an admin practice_members row for the creating
    // brand-admin on every branch, so a brand owner normally resolves as a
    // member and gets byte-identical rendering for free. The brand path is
    // the invited-admin / deactivated-row edge.
    const r = await resolvePracticeViewer(clientFor('owner'), svc(), 'owner', 'branch-b');
    if (r.kind !== 'ok') throw new Error('expected ok');
    expect(r.scope.viaBrandAdmin).toBe(false);
    expect(r.scope.canManagePractice).toBe(true);
    expect(serviceReads).toEqual([]);
  });
});

// ─── How the two consuming screens use it ──────────────────────────────

describe('the dashboard and Team screen consume the resolver correctly', () => {
  const DASHBOARD = read('app/practice/page.tsx');
  const MEMBERS   = read('app/practice/members/page.tsx');

  it.each([
    ['app/practice/page.tsx',         DASHBOARD],
    ['app/practice/members/page.tsx', MEMBERS],
  ])('%s resolves the viewer and honours both rejection outcomes', (_p, src) => {
    expect(src).toMatch(/resolvePracticeViewer\(/);
    expect(src).toMatch(/viewer\.kind === 'setup'/);
    expect(src).toMatch(/viewer\.kind === 'denied'\) notFound\(\)/);
  });

  it.each([
    ['app/practice/page.tsx',         DASHBOARD],
    ['app/practice/members/page.tsx', MEMBERS],
  ])('%s reads practice data with service-role ONLY on the brand path', (_p, src) => {
    // RLS's is_practice_member only recognises practice_members, and 0061
    // deliberately did not widen profiles — so a brand-admin-only caller
    // needs the elevated read, and a practice's own staff must keep
    // reading through RLS exactly as before.
    expect(src).toMatch(/viaBrandAdmin \? svc : supabase/);
    expect(src).toMatch(/reader\s*\n?\s*\.from\(/);
  });

  it('neither screen derives manager rights from brand authority', () => {
    // isManager / canManagePractice come from the resolver, which reports
    // false on the brand path. A literal `|| isBrandAdmin` here would be
    // exactly the flattening the constraint forbids.
    expect(DASHBOARD).not.toMatch(/canManagePractice\s*\|\|\s*isBrandAdmin/);
    expect(MEMBERS).not.toMatch(/isManager\s*=\s*true/);
    expect(MEMBERS).toMatch(/const isManager\s*=\s*canManagePractice/);
  });

  it('the dashboard still bounces a member-less caller to the signup flow', () => {
    expect(DASHBOARD).toMatch(/viewer\.kind === 'setup'\)\s*redirect\('\/practice\/setup'\)/);
  });
});
