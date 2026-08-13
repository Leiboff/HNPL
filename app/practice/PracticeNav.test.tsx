import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PracticeNav from './PracticeNav';

// ─── PracticeNav — the desktop sidebar's permission-gated entry ─────────
//
// This file used to be about the "Till devices" entry point, added to fix a
// sidebar with no link to /practice/pos/devices at all. That entry — and
// "Practice details" beside it — are SECTIONS of the Settings tab now.
//
// The invariant they existed to protect is unchanged and is what is tested
// here: a visible nav entry and a destination that will serve you must always
// agree. Settings appears exactly when the viewer has at least one visible
// section, which is:
//
//   canManageTill   can_manage_practice OR isBrandAdmin — what
//                   app/practice/pos/devices/actions.ts's guardTillManager
//                   checks, and what gates the till section
//   isBrandAdmin    an active practice_group_members row — what
//                   guardBrandAdminOfPractice checks, and what gates the
//                   details and banking sections
//
// Per-viewer coverage across the real roster (manager, reception, brand-admin,
// provider), driven through the actual authority resolver rather than through
// props, lives in ./practiceNavRoles.test.tsx. Desktop/mobile agreement lives
// in ./practiceNavParity.test.tsx.

vi.mock('next/navigation', () => ({
  usePathname: () => '/practice',
}));

describe('PracticeNav — Settings link visibility', () => {
  it('shows Settings, scoped to practiceId, when canManageTill is true', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill />);
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link.getAttribute('href')).toBe('/practice/settings?practiceId=practice-1');
  });

  it('shows Settings for a brand-admin — details and banking are theirs', () => {
    render(<PracticeNav practiceId="practice-1" isBrandAdmin />);
    expect(screen.getByRole('link', { name: 'Settings' }).getAttribute('href'))
      .toBe('/practice/settings?practiceId=practice-1');
  });

  it('hides Settings when the viewer has no section behind it (e.g. a biller)', () => {
    // The page notFound()s them, so an entry here would be a link to a 404.
    render(<PracticeNav practiceId="practice-1" canManageTill={false} />);
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('hides Settings by default when the props are omitted', () => {
    render(<PracticeNav practiceId="practice-1" />);
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('shows it ONCE for a manager who is also brand-admin, not twice', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill isBrandAdmin />);
    expect(screen.getAllByRole('link', { name: 'Settings' })).toHaveLength(1);
  });

  it('no longer offers Till devices or Practice details as top-level entries', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill isBrandAdmin />);
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Practice details' })).toBeNull();
  });
});

// ─── The tab order ─────────────────────────────────────────────────────

describe('PracticeNav — the tabs', () => {
  it('renders Dashboard · Bills · Team · Settings, in that order', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill isBrandAdmin />);
    expect(screen.getAllByRole('link').map((el) => el.textContent))
      .toEqual(['Dashboard', 'Bills', 'Team', 'Settings']);
  });

  it('keeps Dashboard, Bills and Team for a viewer with no Settings', () => {
    render(<PracticeNav practiceId="practice-1" />);
    expect(screen.getAllByRole('link').map((el) => el.textContent))
      .toEqual(['Dashboard', 'Bills', 'Team']);
  });

  it('scopes every tab to the practice', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill />);
    for (const el of screen.getAllByRole('link')) {
      expect(el.getAttribute('href')).toContain('?practiceId=practice-1');
    }
  });

  it('offers no Payouts entry while the route does not exist', () => {
    // A nav entry pointing at nothing is worse than a missing one. This fails
    // the day /practice/payouts lands, which is when it should appear.
    render(<PracticeNav practiceId="practice-1" canManageTill isBrandAdmin brandPracticeCount={3} />);
    expect(screen.queryByRole('link', { name: 'Payouts' })).toBeNull();
  });
});

// ─── "← All practices" exit link ───────────────────────────────────────
//
// A brand-admin who clicks into a branch lands in that practice's
// ordinary dashboard, so they need a persistent way back to /brand.
// isBrandAdmin alone can't gate it: post-0062 every solo owner is
// auto-brand-admin of their own 1-practice brand and /brand redirects
// n=1 straight back to /practice. Unchanged by the restructure.

describe('PracticeNav — brand exit link', () => {
  it('shows "← All practices" for a brand-admin with 2+ practices in the brand', () => {
    render(<PracticeNav practiceId="practice-1" isBrandAdmin brandPracticeCount={3} />);
    expect(screen.getByRole('link', { name: '← All practices' }).getAttribute('href')).toBe('/brand');
  });

  it('hides it for a SOLO owner — brand-admin of their own 1-practice brand', () => {
    render(<PracticeNav practiceId="practice-1" isBrandAdmin brandPracticeCount={1} />);
    expect(screen.queryByRole('link', { name: '← All practices' })).toBeNull();
  });

  it("hides it from a practice's OWN staff, even a manager", () => {
    render(<PracticeNav practiceId="practice-1" canManageTill brandPracticeCount={5} />);
    expect(screen.queryByRole('link', { name: '← All practices' })).toBeNull();
  });

  it('hides it by default when the props are omitted', () => {
    render(<PracticeNav practiceId="practice-1" />);
    expect(screen.queryByRole('link', { name: '← All practices' })).toBeNull();
  });

  it('renders it ABOVE Dashboard — it exits upward, it is not a peer', () => {
    render(<PracticeNav practiceId="practice-1" isBrandAdmin brandPracticeCount={2} />);
    const labels = screen.getAllByRole('link').map((el) => el.textContent);
    expect(labels[0]).toBe('← All practices');
    expect(labels[1]).toBe('Dashboard');
  });
});
