import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CrmNav from './CrmNav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/crm/leads',
}));

// ─── Desktop nav collapse — full-width leads table ask ────────────────
//
// "can the nav menu on desktop be collapsed so that the table has the
// full width of the screen." Collapsing swaps the labeled 56-wide rail
// for a 14-wide icon-only one; state persists across mounts via
// localStorage so it survives navigation.

const COUNTS = { overdueFollowups: 3 };

beforeEach(() => {
  window.localStorage.clear();
});

describe('CrmNav — collapsible desktop sidebar', () => {
  it('starts expanded (labels visible, wide rail) with nothing stored', () => {
    render(<CrmNav counts={COUNTS} />);
    expect(screen.getByTestId('crm-nav').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText('Leads')).toBeTruthy();
  });

  it('clicking the toggle collapses the rail, hides labels, and persists the choice', () => {
    render(<CrmNav counts={COUNTS} />);
    fireEvent.click(screen.getByTestId('crm-nav-collapse-toggle'));
    expect(screen.getByTestId('crm-nav').getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByText('Leads')).toBeNull();
    expect(window.localStorage.getItem('crm-nav-collapsed')).toBe('true');
  });

  it('renders collapsed on mount when a prior collapse was stored', () => {
    window.localStorage.setItem('crm-nav-collapsed', 'true');
    render(<CrmNav counts={COUNTS} />);
    expect(screen.getByTestId('crm-nav').getAttribute('data-collapsed')).toBe('true');
    expect(screen.queryByText('Leads')).toBeNull();
  });

  it('toggling back to expanded restores labels and updates storage', () => {
    window.localStorage.setItem('crm-nav-collapsed', 'true');
    render(<CrmNav counts={COUNTS} />);
    fireEvent.click(screen.getByTestId('crm-nav-collapse-toggle'));
    expect(screen.getByTestId('crm-nav').getAttribute('data-collapsed')).toBe('false');
    expect(screen.getByText('Leads')).toBeTruthy();
    expect(window.localStorage.getItem('crm-nav-collapsed')).toBe('false');
  });

  it('still shows the overdue-followups count badge when collapsed', () => {
    window.localStorage.setItem('crm-nav-collapsed', 'true');
    render(<CrmNav counts={COUNTS} />);
    expect(screen.getByText('3')).toBeTruthy();
  });
});
