import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import PracticeHeader from './PracticeHeader';

// ─── PracticeHeader — Till devices / Practice details in the mobile menu ──
//
// Mirrors PracticeNav.test.tsx's coverage for the desktop sidebar — same
// canManageTill/isBrandAdmin gating, now also wired into the mobile
// hamburger menu (see practiceManagerLinks.ts for the shared source).

vi.mock('next/navigation', () => ({ usePathname: () => '/practice' }));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
}

describe('PracticeHeader mobile menu — Till devices link visibility', () => {
  it('a practice manager (canManageTill) sees Till devices, scoped to practiceId', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    const link = screen.getByRole('link', { name: 'Till devices' });
    expect(link.getAttribute('href')).toBe('/practice/pos/devices?practiceId=practice-1');
  });

  it('plain staff (canManageTill false, not brand-admin) does NOT see Till devices', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" />);
    openMenu();
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
  });

  it('a brand-admin overseeing this practice sees Till devices even without a practice_members row', () => {
    // canManageTill is computed upstream as can_manage_practice ||
    // isBrandAdmin — a pure brand-admin passes canManageTill=true here.
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill isBrandAdmin />);
    openMenu();
    expect(screen.getByRole('link', { name: 'Till devices' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Practice details' }).getAttribute('href'))
      .toBe('/practice/details?practiceId=practice-1');
  });

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

  it('the base Dashboard / Manage Practice links and Sign out are still present', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    openMenu();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Manage Practice' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('the menu is closed by default — no links visible until the hamburger is clicked', () => {
    render(<PracticeHeader practiceName="Test Practice" practiceId="practice-1" canManageTill />);
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
  });
});
