import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PracticeNav from './PracticeNav';

// ─── PracticeNav — Till devices entry point ────────────────────────────
//
// Missing-entry-point fix: the single-practice sidebar previously had no
// link to /practice/pos/devices at all. canManageTill gates the new
// link — it's the exact same authority (can_manage_practice OR
// isBrandAdmin) app/practice/pos/devices/actions.ts's guardTillManager()
// now checks server-side, so a visible link and a working destination
// always agree.

vi.mock('next/navigation', () => ({
  usePathname: () => '/practice',
}));

describe('PracticeNav — Till devices link visibility', () => {
  it('shows the Till devices link, scoped to practiceId, when canManageTill is true', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill />);
    const link = screen.getByRole('link', { name: 'Till devices' });
    expect(link.getAttribute('href')).toBe('/practice/pos/devices?practiceId=practice-1');
  });

  it('hides the Till devices link when canManageTill is false (e.g. a biller)', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill={false} />);
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
  });

  it('hides the Till devices link by default when the prop is omitted', () => {
    render(<PracticeNav practiceId="practice-1" />);
    expect(screen.queryByRole('link', { name: 'Till devices' })).toBeNull();
  });

  it('renders Team + Till devices + Practice details together for a manager who is also brand-admin', () => {
    render(<PracticeNav practiceId="practice-1" canManageTill isBrandAdmin />);
    expect(screen.getByRole('link', { name: 'Team' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Till devices' })).toBeTruthy();
    // Practice details now points INSIDE the shell's own tree. It used to
    // deep-link to /brand/branch/{id}, which was doubling as a
    // multi-branch performance view; that route pivots into the practice
    // dashboard now and the settings live at /practice/details.
    expect(screen.getByRole('link', { name: 'Practice details' }).getAttribute('href'))
      .toBe('/practice/details?practiceId=practice-1');
  });
});

// ─── "← All practices" exit link ───────────────────────────────────────
//
// A brand-admin who clicks into a branch lands in that practice's
// ordinary dashboard, so they need a persistent way back to /brand.
// isBrandAdmin alone can't gate it: post-0062 every solo owner is
// auto-brand-admin of their own 1-practice brand and /brand redirects
// n=1 straight back to /practice.

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
