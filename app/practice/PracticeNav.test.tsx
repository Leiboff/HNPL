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
    expect(screen.getByRole('link', { name: 'Practice details' }).getAttribute('href')).toBe('/brand/branch/practice-1');
  });
});
