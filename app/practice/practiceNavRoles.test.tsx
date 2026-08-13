import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import PracticeNav from './PracticeNav';
import { resolvePracticeShellAuthority } from './practiceShellAuthority';

// ─── Every sidebar item, for every kind of viewer ──────────────────────────
//
// The nav is Dashboard · Bills · Payouts · Team · Settings, and Settings folds three
// previously separate, differently-gated screens. So the question this file
// answers is the one the fold created: does each item still appear only for
// someone who can actually use it?
//
// DRIVEN THROUGH THE REAL RESOLVER, not through flags typed out by hand. The
// chain under test is role → practice_members / practice_group_members rows →
// resolvePracticeShellAuthority → getPracticeNavLinks → rendered sidebar. If
// the flags were asserted from literals, this would prove that the nav agrees
// with my belief about each role rather than with the resolver's answer, and
// the interesting failure — the resolver's definition of canManageTill
// changing — would go unnoticed.
//
// The four viewers are the real ones off the roster:
//
//   practice manager    an active practice_members row with
//                       can_manage_practice. Not a brand-admin.
//   reception admin     an active member with can_manage_practice FALSE.
//                       This is the viewer the fold could most easily have
//                       over-served, since Settings is one item where there
//                       used to be two they never saw.
//   brand admin         an active practice_group_members row for the
//                       practice's brand and NO practice_members row —
//                       which is why canManagePractice is false for them
//                       (practiceViewer reports it false on the brand path,
//                       deliberately, and never converts brand authority
//                       into a member capability).
//   provider            an active member, role='provider', no manage flag.

vi.mock('next/navigation', () => ({ usePathname: () => '/practice' }));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

type Row = Record<string, unknown>;
let state: Record<string, Row[]> = {};

function matches(row: Row, filters: Array<[string, unknown]>): boolean {
  return filters.every(([c, v]) => row[c] === v);
}

// Thenable builder — the resolver awaits a head+count query directly (no
// .maybeSingle()), so the fake has to resolve like a real PostgrestBuilder or
// the brandPracticeCount assertions would pass for the wrong reason.
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
    // Two practices in one brand, so a brand-admin clears the >= 2 threshold
    // the exit link needs.
    practices: [
      { id: 'p1', group_id: 'g1' },
      { id: 'p2', group_id: 'g1' },
    ],
    practice_group_members: [
      { group_id: 'g1', user_id: 'brand-admin', active: true },
    ],
  };
});

/** role → the flags the resolver actually produces → the rendered sidebar. */
async function navFor(userId: string, canManagePractice: boolean): Promise<string[]> {
  const { isBrandAdmin, canManageTill, brandPracticeCount } =
    await resolvePracticeShellAuthority(makeClient(), userId, 'p1', canManagePractice);

  const { unmount } = render(
    <PracticeNav
      practiceId="p1"
      isBrandAdmin={isBrandAdmin}
      canManageTill={canManageTill}
      brandPracticeCount={brandPracticeCount}
    />,
  );
  const labels = screen.getAllByRole('link').map((el) => el.textContent ?? '');
  unmount();
  return labels;
}

// ─── The four viewers ─────────────────────────────────────────────────────

describe('a practice manager (can_manage_practice, not a brand-admin)', () => {
  it('gets Dashboard, Bills, Team and Settings', () => {
    return navFor('manager', true).then((labels) => {
      expect(labels).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team', 'Settings']);
    });
  });

  it('gets Settings because the till section is genuinely theirs', async () => {
    // guardTillManager accepts can_manage_practice, so there is real content
    // behind the item — it is not a courtesy link.
    const { canManageTill, isBrandAdmin } =
      await resolvePracticeShellAuthority(makeClient(), 'manager', 'p1', true);
    expect(canManageTill).toBe(true);
    expect(isBrandAdmin).toBe(false);
  });

  it('gets no brand exit link — they are not a brand-admin', async () => {
    expect(await navFor('manager', true)).not.toContain('← All practices');
  });
});

describe('a reception-level admin WITHOUT can_manage_practice', () => {
  it('gets Dashboard, Bills and Team — and no Settings', async () => {
    // The viewer the fold could most easily have over-served: Settings is one
    // item where they previously saw neither "Till devices" nor "Practice
    // details", and the page notFound()s them, so an item here would be a
    // link to a 404.
    expect(await navFor('reception', false)).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team']);
  });

  it('still gets Bills — finding a bill is not a manager privilege', async () => {
    // They can create bills; refusing them the list would mean they cannot
    // find the one they just created.
    expect(await navFor('reception', false)).toContain('Bills');
  });
});

describe('a brand admin with NO practice_members row on this practice', () => {
  it('gets the exit link plus every tab', async () => {
    expect(await navFor('brand-admin', false)).toEqual([
      '← All practices', 'Dashboard', 'Bills', 'Payouts', 'Team', 'Settings',
    ]);
  });

  it('gets Settings from brand authority, not from a manager flag', async () => {
    // canManagePractice is FALSE for them — practiceViewer reports it false
    // on the brand path by design. canManageTill comes out true anyway
    // because the resolver defines it as can_manage_practice OR isBrandAdmin,
    // which is exactly what guardTillManager checks.
    const r = await resolvePracticeShellAuthority(makeClient(), 'brand-admin', 'p1', false);
    expect(r.isBrandAdmin).toBe(true);
    expect(r.canManageTill).toBe(true);
  });

  it('loses the exit link when the brand holds only this one practice', async () => {
    // The solo-owner rule, unchanged by the restructure: /brand bounces n=1
    // straight back to /practice.
    state.practices = [{ id: 'p1', group_id: 'g1' }];
    const labels = await navFor('brand-admin', false);
    expect(labels).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team', 'Settings']);
  });
});

describe('a provider', () => {
  it('gets Dashboard, Bills and Team — no Settings', async () => {
    // role='provider' grants neither flag. Same nav as reception, which is
    // correct: the difference between them is what they may DO with bills,
    // not what configuration they may edit.
    expect(await navFor('provider', false)).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team']);
  });
});

// ─── Cross-cutting ────────────────────────────────────────────────────────

describe('across all four viewers', () => {
  const VIEWERS: Array<[string, boolean]> = [
    ['manager',     true],
    ['reception',   false],
    ['brand-admin', false],
    ['provider',    false],
  ];

  it('everyone who reaches the practice area gets Dashboard, Bills, Payouts and Team', async () => {
    for (const [user, manage] of VIEWERS) {
      const labels = await navFor(user, manage);
      for (const base of ['Dashboard', 'Bills', 'Payouts', 'Team']) {
        expect(labels, `${user} should see ${base}`).toContain(base);
      }
    }
  });

  it('EVERYONE is offered Payouts, reception and a provider included', async () => {
    // The inverse of the assertion this replaced. Not a courtesy link: 0090
    // makes payout_batches readable by any active member and 0092 widened
    // payouts to match — deliberately, so the plan breakdown behind a batch
    // total is visible to whoever can see the total. Gating this on
    // can_manage_practice would hide a page the database is happy to serve,
    // and reception is often exactly who reconciles the bank account.
    for (const [user, manage] of VIEWERS) {
      expect(await navFor(user, manage), user).toContain('Payouts');
    }
  });

  it('nobody is offered Till devices or Practice details as top-level items', async () => {
    // They are sections of Settings now. Their routes still resolve, as
    // redirects, so nothing that linked to them broke.
    for (const [user, manage] of VIEWERS) {
      const labels = await navFor(user, manage);
      expect(labels, user).not.toContain('Till devices');
      expect(labels, user).not.toContain('Practice details');
    }
  });

  it('a deactivated brand membership buys nothing', async () => {
    state.practice_group_members = [
      { group_id: 'g1', user_id: 'ex-admin', active: false },
    ];
    expect(await navFor('ex-admin', false)).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team']);
  });

  it('brand-admin of a DIFFERENT brand gets nothing here', async () => {
    state.practices.push({ id: 'p-other', group_id: 'g2' });
    state.practice_group_members = [
      { group_id: 'g2', user_id: 'other-brand', active: true },
    ];
    expect(await navFor('other-brand', false)).toEqual(['Dashboard', 'Bills', 'Payouts', 'Team']);
  });
});
