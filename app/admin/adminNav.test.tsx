import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AdminNav from './AdminNav';
import AdminMobileMenu from './AdminMobileMenu';
import { isAdminNavActive } from './adminNavLinks';

// ─── Admin nav: the hamburger, and its parity with the sidebar ─────────
//
// The phone nav used to be a five-slot bottom bar with its own
// hand-written link array. Two things were wrong with that, and both are
// what this file guards:
//
//   • REACH. Four of the portal's destinations — CRM, Sales team, Audit
//     log, Risk — had no link at all on a phone, and Settings (#92,
//     merged in from master) would have been a fifth. The kill switches
//     behind /admin/risk were reachable only by typing the URL.
//   • DIVERGENCE. Two independently-maintained arrays, the exact shape of
//     the bug that produced ../practice/practiceManagerLinks.ts. Both
//     surfaces render getAdminNavLinks() now, so they cannot diverge by
//     construction — but this compares the RENDERED OUTPUT, which holds
//     even if one of them stops consuming that source correctly.
//
// Verified this catches the bug class rather than just describing today's
// code: re-adding a five-entry hand-written array to the mobile surface
// fails the parity test with the four missing destinations named.

vi.mock('next/navigation', () => ({
  usePathname:     () => mockPathname(),
  useSearchParams: () => new URLSearchParams(mockQuery()),
}));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

let pathname = '/admin';
let query    = '';
const mockPathname = () => pathname;
const mockQuery    = () => query;

const COUNTS = { pendingPractices: 3, overdueCollections: 7, pendingPayouts: 0 };
const ZERO   = { pendingPractices: 0, overdueCollections: 0, pendingPayouts: 0 };

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /open menu/i }));
}

beforeEach(() => { pathname = '/admin'; query = ''; });

describe('AdminMobileMenu — the hamburger', () => {
  it('renders nothing but the button until it is opened', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByRole('button', { name: /open menu/i })).toBeTruthy();
  });

  it('opens on tap and closes again on a second tap', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /close menu/i }));
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('closes when a link is tapped, so the destination is not covered', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    fireEvent.click(screen.getByRole('link', { name: 'Customers' }));
    expect(screen.queryByRole('link', { name: 'Customers' })).toBeNull();
  });

  it('closes on Escape and on an outside click', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();

    openMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('closes itself when the route changes under it (e.g. the back button)', () => {
    // A navigation this menu did not initiate still dismisses it — the
    // panel is keyed on the URL, so React discards the open instance.
    const { rerender } = render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    expect(screen.getByRole('link', { name: 'Dashboard' })).toBeTruthy();

    pathname = '/admin/payouts';
    rerender(<AdminMobileMenu counts={ZERO} />);
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(screen.getByRole('button', { name: /open menu/i })).toBeTruthy();
  });

  it('closes on a query-only navigation, which usePathname cannot see', () => {
    // /admin/practices?status=pending → ?status=active is a real
    // navigation to a re-rendered page, and the pathname does not move.
    // Keying on the pathname alone would leave the panel hanging over it.
    pathname = '/admin/practices';
    query    = 'status=pending';
    const { rerender } = render(<AdminMobileMenu counts={ZERO} />);
    openMenu();

    query = 'status=active';
    rerender(<AdminMobileMenu counts={ZERO} />);
    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
  });

  it('does not reopen itself when you navigate away and come back', () => {
    // The state must be DISCARDED on the way out, not merely out-matched
    // by the current route: the shared /admin layout keeps this component
    // mounted, so a token comparison would match again on return and pop
    // the menu open over a page nobody opened it on. Caught in review.
    pathname = '/admin/payouts';
    const { rerender } = render(<AdminMobileMenu counts={ZERO} />);
    openMenu();

    pathname = '/admin/customers';
    rerender(<AdminMobileMenu counts={ZERO} />);
    pathname = '/admin/payouts';
    rerender(<AdminMobileMenu counts={ZERO} />);

    expect(screen.queryByRole('link', { name: 'Dashboard' })).toBeNull();
    expect(screen.getByRole('button', { name: /open menu/i })).toBeTruthy();
  });

  it('carries Sign out — the header Log out button is desktop-only', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });

  it('reaches the destinations the old bottom bar could not fit', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    for (const label of ['CRM', 'Sales team', 'Audit log', 'Risk', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
  });

  it('shows each queue count inside, and one dot on the closed button', () => {
    render(<AdminMobileMenu counts={COUNTS} />);
    // Closed: a single "something needs you" dot, labelled with the total.
    expect(screen.getByLabelText('10 items need attention')).toBeTruthy();

    openMenu();
    expect(screen.getByRole('link', { name: /Practices/ }).textContent).toContain('3');
    expect(screen.getByRole('link', { name: /Collections/ }).textContent).toContain('7');
    // A zero count renders no badge at all, on either surface.
    expect(screen.getByRole('link', { name: 'Payouts' }).textContent).toBe('Payouts');
  });

  it('has no dot when every queue is clear', () => {
    render(<AdminMobileMenu counts={ZERO} />);
    expect(screen.queryByLabelText(/items need attention/)).toBeNull();
  });
});

describe('desktop / mobile parity', () => {
  it('renders the same links, in the same order, with the same hrefs', () => {
    const desktop = render(<AdminNav counts={COUNTS} />);
    const desktopLinks = Array.from(desktop.container.querySelectorAll('a'))
      .map((a) => [a.getAttribute('href'), a.textContent]);
    desktop.unmount();

    const mobile = render(<AdminMobileMenu counts={COUNTS} />);
    openMenu();
    const mobileLinks = Array.from(mobile.container.querySelectorAll('a'))
      .map((a) => [a.getAttribute('href'), a.textContent]);

    expect(mobileLinks).toEqual(desktopLinks);
    expect(desktopLinks.length).toBe(10);
  });
});

describe('isAdminNavActive', () => {
  it('matches /admin exactly — it is a prefix of every other admin route', () => {
    expect(isAdminNavActive('/admin', '/admin')).toBe(true);
    expect(isAdminNavActive('/admin', '/admin/payouts')).toBe(false);
  });

  it('keeps a child route under its parent tab', () => {
    expect(isAdminNavActive('/admin/practices?status=pending', '/admin/practices')).toBe(true);
    expect(isAdminNavActive('/admin/practices?status=pending', '/admin/practices/abc')).toBe(true);
  });

  it('lights the tab for the current route in both surfaces', () => {
    pathname = '/admin/risk';
    const { container } = render(<AdminMobileMenu counts={ZERO} />);
    openMenu();
    const risk = screen.getByRole('link', { name: 'Risk' });
    expect(risk.className).toContain('bg-[#13294B]/10');
    expect(container.querySelector('a[href="/admin"]')!.className).not.toContain('bg-[#13294B]/10');
  });
});
