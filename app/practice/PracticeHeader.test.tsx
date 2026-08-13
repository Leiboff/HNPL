import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PracticeHeader from './PracticeHeader';

// ─── PracticeHeader — the mobile hamburger menu ────────────────────────────
//
// Mirrors PracticeNav.test.tsx's coverage for the desktop sidebar: same
// gating, same tabs, rendered from the same shared source
// (practiceManagerLinks → getPracticeNavLinks). "Till devices" and "Practice
// details" are sections of the Settings tab now; what those entries protected
// — a visible link always having a destination that will serve you — is what
// is tested here.
//
// ./practiceNavParity.test.tsx proves the two surfaces agree link-for-link.
// This file exists separately because the mobile menu has its own behaviour
// around it: it must be closed until the hamburger is clicked, it keeps its
// own "Manage Practice" wording, and it carries Sign out.

vi.mock('next/navigation', () => ({ usePathname: () => '/practice' }));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
}

describe('PracticeHeader mobile menu — Settings link visibility', () => {
  it('a practice manager (canManageTill) sees Settings, scoped to practiceId', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    const link = screen.getByRole('link', { name: 'Settings' });
    expect(link.getAttribute('href')).toBe('/practice/settings?practiceId=practice-1');
  });

  it('plain staff (canManageTill false, not brand-admin) does NOT see Settings', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" />);
    openMenu();
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
  });

  it('a brand-admin sees Settings even without a practice_members row', () => {
    // canManageTill is computed upstream as can_manage_practice ||
    // isBrandAdmin — a pure brand-admin passes canManageTill=true here, and
    // gets the details and banking sections from isBrandAdmin as well.
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill isBrandAdmin />);
    openMenu();
    expect(screen.getAllByRole('link', { name: 'Settings' })).toHaveLength(1);
  });

  it('no longer offers Till devices or Practice details as top-level entries', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill isBrandAdmin />);
    openMenu();
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Practice details' })).toBeNull();
  });
});

describe('PracticeHeader mobile menu — the tabs', () => {
  it('renders Dashboard · Bills · Manage Practice · Settings, in that order', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    expect(screen.getAllByRole('link').map((el) => el.textContent))
      .toEqual(['Dashboard', 'Bills', 'Manage Practice', 'Settings']);
  });

  it('keeps its own "Manage Practice" wording where desktop says "Team"', () => {
    // Predates the shared source and was never the bug it exists to fix — it
    // is now a parameter rather than a second hand-written list.
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    expect(screen.getByRole('link', { name: 'Manage Practice' }).getAttribute('href'))
      .toBe('/practice/members?practiceId=practice-1');
    expect(screen.queryByRole('link', { name: 'Team' })).toBeNull();
  });

  it('scopes EVERY link, including the base ones', () => {
    // The bug the restructure fixed: Dashboard and Manage Practice were
    // hardcoded here without ?practiceId=, so a brand-admin viewing one
    // branch on a phone lost their branch scope the moment they tapped either.
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    for (const el of screen.getAllByRole('link')) {
      expect(el.getAttribute('href')).toContain('?practiceId=practice-1');
    }
  });

  it('offers no Payouts entry while the route does not exist', () => {
    render(
      <PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill isBrandAdmin brandPracticeCount={3} />,
    );
    openMenu();
    expect(screen.queryByRole('link', { name: 'Payouts' })).toBeNull();
  });

  it('keeps Sign out below the links', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('the menu is closed by default — no links visible until the hamburger is clicked', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    expect(screen.queryByRole('link', { name: 'Settings' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });
});

describe('PracticeHeader mobile menu — brand exit link', () => {
  it('shows "← All practices" for a brand-admin with 2+ practices, above the base list', () => {
    render(
      <PracticeHeader practiceName="Test Practice" practiceId="practice-1" isBrandAdmin brandPracticeCount={4} />,
    );
    openMenu();
    expect(screen.getByRole('link', { name: '← All practices' }).getAttribute('href')).toBe('/brand');
    const labels = screen.getAllByRole('link').map((el) => el.textContent);
    expect(labels[0]).toBe('← All practices');
  });

  it('hides "← All practices" from a solo owner and from a practice\'s own staff', () => {
    const { unmount } = render(
      <PracticeHeader practiceName="Test Practice" practiceId="practice-1" isBrandAdmin brandPracticeCount={1} />,
    );
    openMenu();
    expect(screen.queryByRole('link', { name: '← All practices' })).toBeNull();
    unmount();

    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill brandPracticeCount={9} />);
    openMenu();
    expect(screen.queryByRole('link', { name: '← All practices' })).toBeNull();
  });
});
