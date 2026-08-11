import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PracticeNav from './PracticeNav';
import PracticeHeader from './PracticeHeader';

// ─── Desktop/mobile nav parity — the actual regression guard ──────────
//
// The bug: "Till devices" was added to PracticeNav (desktop sidebar)
// but PracticeHeader's mobile hamburger menu was never touched — two
// independently-maintained link arrays that silently diverged. Both
// components now splice getPracticeManagerLinks() onto their own base
// list (see practiceManagerLinks.ts), so they can't diverge by
// construction — but this test guards the RENDERED OUTPUT directly,
// independent of whether both components keep consuming that shared
// function correctly. It derives the expected conditional-link set
// ONCE per permission combination and asserts BOTH surfaces render
// exactly that set — not two hand-written expectations that happen to
// agree with each other today.
//
// Verified this test actually catches the bug class it's meant to
// catch (not just confirming today's code is correct): temporarily
// reverting PracticeHeader to its pre-fix hand-written LINKS array
// (dropping the getPracticeManagerLinks splice) fails every combo
// where canManageTill or isBrandAdmin is true, with a clear
// mobile-vs-desktop mismatch — then reverting the change back to the
// shared-function version makes the suite pass again.

vi.mock('next/navigation', () => ({ usePathname: () => '/practice' }));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

type Combo = {
  practiceId?: string;
  canManageTill: boolean;
  isBrandAdmin: boolean;
  brandPracticeCount?: number;
};

// Every combination that produces a DIFFERENT conditional-link set —
// including the practiceId-omitted case, since Practice details drops
// out but Till devices doesn't, and both sides of the brandPracticeCount
// threshold that gates the "← All practices" exit link (a solo owner is
// brand-admin of their own 1-practice brand, so isBrandAdmin alone does
// not decide it).
const COMBOS: Combo[] = [
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: false },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: false },
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: true  },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true  },
  { practiceId: undefined,    canManageTill: true,  isBrandAdmin: true  },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true,  brandPracticeCount: 1 },
  { practiceId: 'practice-1', canManageTill: true,  isBrandAdmin: true,  brandPracticeCount: 3 },
  { practiceId: 'practice-1', canManageTill: false, isBrandAdmin: false, brandPracticeCount: 3 },
];

type Link = { href: string; label: string };

// Only the CONDITIONAL links are compared — Dashboard/Team vs. Dashboard/
// Manage Practice are each surface's own base wording by design, not
// part of what diverged. "← All practices" is included: it's
// permission-gated and spliced onto both surfaces from the same shared
// source, so it's exactly the class of link that diverged before.
const CONDITIONAL_LABELS = new Set(['Till devices', 'Practice details', '← All practices']);

function conditionalLinks(): Link[] {
  return screen.getAllByRole('link')
    .map((el) => ({ href: el.getAttribute('href') ?? '', label: el.textContent ?? '' }))
    .filter((l) => CONDITIONAL_LABELS.has(l.label));
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
  const links = conditionalLinks();
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
  const links = conditionalLinks();
  unmount();
  return links;
}

describe('PracticeNav (desktop) and PracticeHeader (mobile) render an identical conditional link set', () => {
  COMBOS.forEach((combo, i) => {
    it(`combo ${i}: ${JSON.stringify(combo)}`, () => {
      const desktop = desktopLinksFor(combo);
      const mobile  = mobileLinksFor(combo);
      expect(mobile).toEqual(desktop);
    });
  });

  it('a manager sees Till devices on both surfaces (sanity — not just an empty-set match)', () => {
    const combo: Combo = { practiceId: 'practice-1', canManageTill: true, isBrandAdmin: false };
    expect(desktopLinksFor(combo)).toEqual([{ href: '/practice/pos/devices?practiceId=practice-1', label: 'Till devices' }]);
    expect(mobileLinksFor(combo)).toEqual([{ href: '/practice/pos/devices?practiceId=practice-1', label: 'Till devices' }]);
  });
});
