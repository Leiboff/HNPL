import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AdminPortalMenu from '@/app/admin/AdminPortalMenu';

// ─── An admin does not lose the admin menu inside the CRM ─────────────
//
// The admin nav carries a CRM link, and following it swaps the whole
// shell: /crm has its own layout, its own sidebar and its own bottom bar.
// Before this, that meant the admin nav simply vanished — the hamburger
// on a phone, the sidebar on desktop — and nothing in the CRM linked back
// to /admin at any width. An admin who walked in could only get out by
// typing a URL.
//
// The fix renders the SAME menu component in the CRM header for admins,
// off the SAME link source (app/admin/adminNavLinks.ts), so the way back
// cannot drift from the way in. This file pins both halves: the props the
// CRM shell passes, and the fact that it passes them only for admins.

vi.mock('next/navigation', () => ({
  usePathname:     () => mockPathname(),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/auth/logout', () => ({ logoutAndRedirect: vi.fn() }));

let pathname = '/crm/leads';
const mockPathname = () => pathname;

const ZERO = { pendingPractices: 0, overdueCollections: 0, pendingPayouts: 0 };

function read(p: string): string { return readFileSync(resolve(process.cwd(), p), 'utf8'); }

/** Exactly how app/crm/layout.tsx mounts it. */
function renderCrmMenu(counts = ZERO) {
  return render(
    <AdminPortalMenu counts={counts} className="" align="right" showSignOut={false} heading="Admin portal" />,
  );
}

beforeEach(() => { pathname = '/crm/leads'; });

describe('the admin menu as the CRM header mounts it', () => {
  it('reaches every admin destination from inside the CRM', () => {
    renderCrmMenu();
    fireEvent.click(screen.getByRole('button', { name: /open admin portal/i }));
    for (const label of ['Dashboard', 'Practices', 'Customers', 'Collections', 'Payouts', 'Sales team', 'Audit log', 'Risk', 'Settings']) {
      expect(screen.getByRole('link', { name: label })).toBeTruthy();
    }
    // The way back is the point: /admin is one tap away.
    expect(screen.getByRole('link', { name: 'Dashboard' }).getAttribute('href')).toBe('/admin');
  });

  it('stays visible at desktop width — this shell has no admin sidebar to fall back on', () => {
    const { container } = renderCrmMenu();
    expect(container.firstElementChild!.className).not.toContain('md:hidden');
  });

  it('omits Sign out — the CRM header shows Log out at every width', () => {
    renderCrmMenu();
    fireEvent.click(screen.getByRole('button', { name: /open admin portal/i }));
    expect(screen.queryByRole('button', { name: 'Sign out' })).toBeNull();
  });

  it('captions the panel, so a nav that is not this shell\'s own says whose it is', () => {
    renderCrmMenu();
    fireEvent.click(screen.getByRole('button', { name: /open admin portal/i }));
    expect(screen.getByText('Admin portal')).toBeTruthy();
  });

  it('lights the CRM entry while you are in the CRM', () => {
    renderCrmMenu();
    fireEvent.click(screen.getByRole('button', { name: /open admin portal/i }));
    expect(screen.getByRole('link', { name: 'CRM' }).className).toContain('bg-[#13294B]/10');
  });

  it('hangs the panel off the button rather than across a desktop-wide header', () => {
    renderCrmMenu();
    fireEvent.click(screen.getByRole('button', { name: /open admin portal/i }));
    const panel = document.getElementById('admin-portal-menu')!;
    expect(panel.className).toContain('right-2');
    expect(panel.className).toContain('w-64');
  });
});

describe('the CRM shell wires it up for admins only', () => {
  const LAYOUT = read('app/crm/layout.tsx');

  it('renders AdminPortalMenu in the CRM header', () => {
    expect(LAYOUT).toMatch(/import AdminPortalMenu from '@\/app\/admin\/AdminPortalMenu'/);
    expect(LAYOUT).toMatch(/<AdminPortalMenu/);
  });

  it('gates it on the admin role, and pays for the badge counts only then', () => {
    // A sales user has no /admin to reach — the admin layout's own gate
    // would bounce them — so they get neither the menu nor its queries.
    expect(LAYOUT).toMatch(/isAdmin \? getAdminNavCounts\(supabase\) : Promise\.resolve\(null\)/);
    expect(LAYOUT).toMatch(/\{adminCounts && \(/);
  });

  it('takes the counts from the shared helper, not a second hand-copied query', () => {
    expect(LAYOUT).toMatch(/getAdminNavCounts/);
    expect(LAYOUT).not.toMatch(/from\('payouts'\)/);
    expect(read('app/admin/layout.tsx')).toMatch(/getAdminNavCounts\(supabase\)/);
  });
});
