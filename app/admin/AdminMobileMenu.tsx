'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { logoutAndRedirect } from '@/lib/auth/logout';
import { getAdminNavLinks, isAdminNavActive, adminLinkCount, type AdminCounts } from './adminNavLinks';

// ─── The admin portal's phone navigation ───────────────────────────────
//
// Replaces the old five-slot floating bottom bar (AdminBottomNav). That
// bar could only ever carry five destinations across a 375px screen, so
// CRM, Sales team, Audit log and Risk were unreachable from a phone
// except by typing the URL — including the platform kill switches, which
// is the one control an operator might genuinely need in a hurry.
//
// A hamburger has no such ceiling, so this renders the SAME list as the
// desktop sidebar, from the same source (./adminNavLinks). Badges come
// through unchanged, so the counts an operator scans for are still on
// the closed-menu button as a single dot — see `totalBadges` below.
//
// Shape and behaviour deliberately mirror ../practice/PracticeHeader's
// menu: dropdown under the sticky top bar, closes on route change, on
// outside click, and on Escape, with Sign out at the foot (the header's
// Log out button is desktop-only, so this is the phone's way out).

// ─── Why the panel is remounted per URL ────────────────────────────────
//
// The panel's openness must not survive a navigation, and the layout
// keeps this component mounted across every /admin route change — so
// something has to discard it. Keying the panel on the current URL is
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
export default function AdminMobileMenu({ counts }: { counts: AdminCounts }) {
  const pathname = usePathname();
  const query    = useSearchParams().toString();

  return (
    <AdminMobileMenuPanel
      key={query ? `${pathname}?${query}` : pathname}
      counts={counts}
      pathname={pathname}
    />
  );
}

function AdminMobileMenuPanel({ counts, pathname }: { counts: AdminCounts; pathname: string }) {
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
    <div className="md:hidden" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        aria-controls="admin-mobile-menu"
        className="relative rounded-lg p-2 text-gray-500 hover:bg-gray-100 transition-colors"
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

      {/* Dropdown. Anchored to the sticky header, scrollable so the full
          list stays usable on a short screen in landscape. */}
      {open && (
        <div
          id="admin-mobile-menu"
          className="absolute left-0 right-0 top-full border-t border-gray-100 bg-white shadow-lg px-3 pb-3 pt-2 space-y-0.5 max-h-[calc(100vh-8rem)] overflow-y-auto"
        >
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
          <div className="pt-1 border-t border-gray-100 mt-1">
            <button
              type="button"
              onClick={() => logoutAndRedirect()}
              className="flex w-full px-3 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 rounded-lg transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
