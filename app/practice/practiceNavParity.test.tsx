import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PracticeNav from './PracticeNav';
import PracticeHeader from './PracticeHeader';

// ─── Desktop/mobile nav parity — the actual regression guard ──────────
//
// The bug: "Till devices" was added to PracticeNav (desktop sidebar) but
// PracticeHeader's mobile hamburger menu was never touched — two
// independently-maintained link arrays that silently diverged. Both
// components now render getPracticeNavLinks() (see practiceManagerLinks.ts)
// and splice nothing of their own, so they cannot diverge by construction —
// but this test guards the RENDERED OUTPUT directly, independent of whether
// both components keep consuming that shared function correctly.
//
// WIDENED BY THE RESTRUCTURE. It used to compare only the three conditional
// labels, because the base list (Dashboard / Team) was each surface's own
// hand-written array and therefore expected to differ. Now the base links
// come from the shared source too, so this compares EVERY link — which is
// what makes adding the next tab safe. Two things it caught immediately:
//
//   • "Bills" is a base link, so under the old arrangement it would have
//     had to be added to two arrays. Exactly the original bug's shape.
//   • the mobile base hrefs carried no ?practiceId=, while desktop's did —
//     a real scope-loss bug for a brand-admin on a phone, invisible to a
//     test that only compared conditional links.
//
// The ONE difference that is intentional: the Team entry reads "Team" on
// desktop and "Manage Practice" on mobile. That predates all of this and was
// never the bug. It is normalised for the comparison AND asserted on its own
// below, so the normalisation cannot hide a surface quietly changing wording.
//
// Verified this test catches the bug class it is meant to catch (not just
// confirming today's code is correct): re-adding a hand-written base LINKS
// array to PracticeHeader — the pre-fix shape — fails every combo, with a
// clear mobile-vs-desktop mismatch on both the Bills entry and the missing
// ?practiceId= scope.

vi.mock('next/navigation', () => ({ usePathname: () => '/practice' }));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

type Combo = {
  practiceId?: string;
  canManageTill: boolean;
  isBrandAdmin: boolean;
  brandPracticeCount?: number;
};

// Every combination that produces a DIFFERENT link set — including the
// practiceId-omitted case (the scope suffix disappears from every entry) and
// both sides of the brandPracticeCount threshold that gates the "← All
// practices" exit link (a solo owner is brand-admin of their own 1-practice
// brand, so isBrandAdmin alone does not decide it).
const COMBOS: Combo[] = [
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: false },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: false },
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: true  },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true  },
  { practiceId: undefined,    canManageTill: true,  isBrandAdmin: true  },
  { practiceId: undefined,    canManageTill: false, isBrandAdmin: false },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true,  brandPracticeCount: 1 },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true,  brandPracticeCount: 3 },
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: false, brandPracticeCount: 3 },
];

type Link = { href: string; label: string };

/**
 * The mobile menu says "Manage Practice" where the sidebar says "Team" — the
 * one intentional difference. Normalised here so everything else can be
 * compared exactly; asserted separately below so this cannot mask a change.
 */
const TEAM_ALIASES = new Set(['Team', 'Manage Practice']);
const normalise = (l: Link): Link =>
  TEAM_ALIASES.has(l.label) ? { ...l, label: 'Team' } : l;

function renderedLinks(): Link[] {
  return screen.getAllByRole('link')
    .map((el) => ({ href: el.getAttribute('href') ?? '', label: el.textContent ?? '' }));
}

function desktopLinksFor(combo: Combo): Link[] {
  const { unmount } = render(
    <PracticeNav
      practiceId={combo.practiceId}
      canManageTill={combo.canManageTill}
      isBrandAdmin={combo.isBrandAdmin}
      brandPracticeCount={combo.brandPracticeCount}
    />,
  );
  const links = renderedLinks();
  unmount();
  return links;
}

function mobileLinksFor(combo: Combo): Link[] {
  const { unmount } = render(
    <PracticeHeader
      practiceName="Test Practice"
      practiceId={combo.practiceId}
      canManageTill={combo.canManageTill}
      isBrandAdmin={combo.isBrandAdmin}
      brandPracticeCount={combo.brandPracticeCount}
    />,
  );
  // The mobile menu only renders once the hamburger is opened.
  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
  const links = renderedLinks();
  unmount();
  return links;
}

describe('PracticeNav (desktop) and PracticeHeader (mobile) render an identical link set', () => {
  COMBOS.forEach((combo, i) => {
    it(`combo ${i}: ${JSON.stringify(combo)}`, () => {
      const desktop = desktopLinksFor(combo);
      const mobile  = mobileLinksFor(combo);

      // Every href, in order, identical — no normalisation applied.
      expect(mobile.map((l) => l.href)).toEqual(desktop.map((l) => l.href));
      // Every label too, once the intentional Team wording is normalised.
      expect(mobile.map(normalise)).toEqual(desktop.map(normalise));
    });
  });

  it('a manager sees the full tab set on both surfaces (sanity — not an empty-set match)', () => {
    const combo: Combo = { practiceId: 'practice-1', canManageTill: true, isBrandAdmin: false };
    const expected = [
      { href: '/practice?practiceId=practice-1',          label: 'Dashboard' },
      { href: '/practice/bills?practiceId=practice-1',    label: 'Bills'     },
      { href: '/practice/payouts?practiceId=practice-1',  label: 'Payouts'   },
      { href: '/practice/members?practiceId=practice-1',  label: 'Team'      },
      { href: '/practice/settings?practiceId=practice-1', label: 'Settings'  },
    ];
    expect(desktopLinksFor(combo)).toEqual(expected);
    expect(mobileLinksFor(combo).map(normalise)).toEqual(expected);
  });

  it('keeps the intentional Team wording difference, on both sides', () => {
    // Guards the normalisation above: if mobile silently adopted "Team", or
    // desktop adopted "Manage Practice", the comparison would still pass and
    // this would not.
    const combo: Combo = { practiceId: 'practice-1', canManageTill: true, isBrandAdmin: false };
    expect(desktopLinksFor(combo).map((l) => l.label)).toContain('Team');
    expect(desktopLinksFor(combo).map((l) => l.label)).not.toContain('Manage Practice');
    expect(mobileLinksFor(combo).map((l) => l.label)).toContain('Manage Practice');
    expect(mobileLinksFor(combo).map((l) => l.label)).not.toContain('Team');
  });

  it('scopes every link on BOTH surfaces when a practiceId is present', () => {
    // The mobile scope-loss bug the restructure fixed: Dashboard and Manage
    // Practice used to be hardcoded without it.
    const combo: Combo = { practiceId: 'practice-1', canManageTill: true, isBrandAdmin: true, brandPracticeCount: 1 };
    for (const links of [desktopLinksFor(combo), mobileLinksFor(combo)]) {
      for (const l of links) {
        expect(l.href).toContain('?practiceId=practice-1');
      }
    }
  });

  it('BOTH surfaces offer Payouts, identically — the newest tab through the shared source', () => {
    // The inverse of the assertion this replaced. It is also the real test of
    // the guard's purpose: Payouts is the first tab added since the base links
    // moved into the shared source, and under the OLD arrangement it would
    // have had to be written into two arrays — the original bug's exact shape.
    // Nothing was touched in either component to make this pass.
    const combo: Combo = { practiceId: 'practice-1', canManageTill: true, isBrandAdmin: true, brandPracticeCount: 3 };
    for (const links of [desktopLinksFor(combo), mobileLinksFor(combo)]) {
      const payouts = links.filter((l) => l.label === 'Payouts');
      expect(payouts).toHaveLength(1);
      expect(payouts[0].href).toBe('/practice/payouts?practiceId=practice-1');
    }
  });
});
