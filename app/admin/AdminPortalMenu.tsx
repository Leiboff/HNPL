'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { logoutAndRedirect } from '@/lib/auth/logout';
import { getAdminNavLinks, isAdminNavActive, adminLinkCount, type AdminCounts } from './adminNavLinks';

// ─── The admin portal's menu ───────────────────────────────────────────
//
// Renders the SAME list as the desktop sidebar, from the same source
// (./adminNavLinks), behind a hamburger button. Two shells use it:
//
//   • /admin, on a phone (the default props). Replaces the old five-slot
//     floating bottom bar, which could only ever carry five destinations
//     across a 375px screen — CRM, Sales team, Audit log and Risk were
//     unreachable from a phone except by typing the URL, including the
//     platform kill switches, the one control an operator might genuinely
//     need in a hurry. A hamburger has no such ceiling. On desktop the
//     sidebar covers the same links, so the button hides at md+.
//
//   • /crm, AT EVERY WIDTH, for admins (className="", align="right").
//     The CRM is its own shell with its own nav, so walking into it from
//     the admin nav's CRM link used to strand an admin there: no sidebar,
//     no hamburger, no link back to /admin at any width. Rendering this
//     menu in the CRM header keeps the whole portal one tap away, and
//     because both shells render getAdminNavLinks(), the way back cannot
//     drift from the way in. See app/crm/layout.tsx.
//
// Behaviour mirrors ../practice/PracticeHeader's menu: dropdown under the
// sticky top bar, closes on route change, on outside click, and on Escape.
//
// Badges come through unchanged, so the counts an operator scans for are
// still on the closed button as a single dot — see `totalBadges` below.

export type AdminPortalMenuProps = {
  counts: AdminCounts;
  /**
   * Widths the button shows at. Defaults to the /admin shape — hidden at
   * md+, where the sidebar renders the same links. A shell with no admin
   * sidebar of its own (the CRM) passes "" so admins keep it everywhere.
   */
  className?: string;
  /**
   * Where the open panel hangs. 'full' spans the sticky header, which is
   * the right shape for a phone; 'right' is a narrow dropdown under the
   * button, which is what a desktop-width header wants.
   */
  align?: 'full' | 'right';
  /**
   * Sign out at the foot of the panel. /admin's header hides its Log out
   * button on a phone, so the menu is the way out there; a shell that
   * shows Log out at every width (the CRM) passes false.
   */
  showSignOut?: boolean;
  /**
   * Names the menu when it is not the shell's own nav — "Open Admin
   * portal" beside the CRM's nav, rather than an unqualified "Open menu".
   * Also captions the open panel.
   */
  heading?: string;
};

// ─── Why the panel is remounted per URL ────────────────────────────────
//
// The panel's openness must not survive a navigation, and the layout
// keeps this component mounted across every route change within a shell —
// so something has to discard it. Keying the panel on the current URL is
// what does: React throws the old instance away the moment the URL
// changes, taking `open` with it.
//
// Two cheaper-looking versions are both wrong, and a review caught the
// second one here:
//
//   • `useEffect(() => setOpen(false), [pathname])` sets state inside an
//     effect to describe something already knowable during render. It
//     costs a cascading re-render, and it is what the react-hooks
//     compiler rule flags (this repo has 20 of those already).
//   • Deriving `open` from a stored "which URL was this opened on" token
//     closes the panel on the way OUT, but the token OUTLIVES the trip:
//     open the menu on /admin/payouts, go to /admin/customers, come
//     back, and the token matches again — the menu reopens by itself
//     over a page the operator did not open it on.
//
// The key covers the query string too, not just the pathname: on
// /admin/practices?status=pending a Back that only swaps ?status is a
// real navigation to a re-rendered page, and usePathname alone cannot
// see it. (The old bottom bar had no state to get this wrong; this is
// the cost of a menu, and it is paid here rather than in each consumer.)
export default function AdminPortalMenu({
  counts,
  className   = 'md:hidden',
  align       = 'full',
  showSignOut = true,
  heading,
}: AdminPortalMenuProps) {
  const pathname = usePathname();
  const query    = useSearchParams().toString();

  return (
    <AdminPortalMenuPanel
      key={query ? `${pathname}?${query}` : pathname}
      counts={counts}
      pathname={pathname}
      className={className}
      align={align}
      showSignOut={showSignOut}
      heading={heading}
    />
  );
}

function AdminPortalMenuPanel({
  counts, pathname, className, align, showSignOut, heading,
}: Required<Omit<AdminPortalMenuProps, 'heading'>> & { pathname: string; heading?: string }) {
  const [open, setOpen] = useState(false);
  const menuRef         = useRef<HTMLDivElement>(null);

  const links       = getAdminNavLinks();
  const totalBadges = links.reduce((n, link) => n + adminLinkCount(link, counts), 0);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className={className} ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? `Close ${heading ?? 'menu'}` : `Open ${heading ?? 'menu'}`}
        aria-expanded={open}
        aria-controls="admin-portal-menu"
        className="relative rounded-lg p-2 text-gray-500 hover:bg-gray-100 transition-colors"
        data-testid="admin-portal-menu-button"
      >
        {open ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
            <path d="M3 12h18M3 6h18M3 18h18" />
          </svg>
        )}
        {/* One dot for "something in here needs you" — the per-queue
            numbers are on the entries themselves once the menu is open. */}
        {!open && totalBadges > 0 && (
          <span
            className="absolute top-1 right-1 h-2 w-2 rounded-full bg-amber-500"
            aria-label={`${totalBadges} items need attention`}
          />
        )}
      </button>

      {/* Dropdown. Anchored to the sticky header — which is the containing
          block, since it is positioned — and scrollable so the full list
          stays usable on a short screen in landscape. */}
      {open && (
        <div
          id="admin-portal-menu"
          className={[
            'absolute top-full bg-white shadow-lg px-3 pb-3 pt-2 space-y-0.5',
            'max-h-[calc(100vh-8rem)] overflow-y-auto',
            align === 'right'
              ? 'right-2 w-64 rounded-b-xl border border-t-0 border-gray-200'
              : 'left-0 right-0 border-t border-gray-100',
          ].join(' ')}
        >
          {heading && (
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {heading}
            </p>
          )}
          {links.map((link) => {
            const active = isAdminNavActive(link.href, pathname);
            const count  = adminLinkCount(link, counts);
            return (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={[
                  'flex w-full items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors',
                  active
                    ? 'bg-[#13294B]/10 text-[#13294B]'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')}
              >
                <span>{link.label}</span>
                {count > 0 && (
                  <span className="inline-flex items-center justify-center rounded-full text-xs font-bold px-1.5 py-0.5 min-w-[1.25rem] tabular-nums bg-amber-100 text-amber-800">
                    {count}
                  </span>
                )}
              </Link>
            );
          })}
          {showSignOut && (
            <div className="pt-1 border-t border-gray-100 mt-1">
              <button
                type="button"
                onClick={() => logoutAndRedirect()}
                className="flex w-full px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
