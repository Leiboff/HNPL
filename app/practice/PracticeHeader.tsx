'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { logoutAndRedirect } from '@/lib/auth/logout';
import { getPracticeNavLinks } from './practiceManagerLinks';

// This surface no longer keeps a link list of its own. It used to hold a
// hand-written base list (Dashboard + Manage Practice) beside the shared
// conditional links, and that half-and-half arrangement is what let
// "Bills" have to be added in two places — the same shape as the original
// bug, where "Till devices" reached desktop and not here.
//
// The ONE intentional difference survives as a parameter: this menu says
// "Manage Practice" where the desktop sidebar says "Team". That wording
// predates the fix and was never the bug, so it is preserved exactly.
//
// It also picks up a fix for free: the old hardcoded base hrefs carried
// no ?practiceId=, so a brand-admin viewing one branch on mobile lost
// their branch scope the moment they tapped Dashboard or Manage Practice.
// One source cannot emit two different href sets.
const TEAM_LABEL_MOBILE = 'Manage Practice';

type Props = {
  practiceName:         string;
  practiceId?:          string;
  isBrandAdmin?:        boolean;
  canManageTill?:       boolean;
  brandPracticeCount?:  number;
};

export default function PracticeHeader({
  practiceName,
  practiceId,
  isBrandAdmin  = false,
  canManageTill = false,
  brandPracticeCount = 0,
}: Props) {
  const [open, setOpen]   = useState(false);
  const pathname          = usePathname();
  const menuRef           = useRef<HTMLDivElement>(null);

  const links = getPracticeNavLinks({
    practiceId, canManageTill, isBrandAdmin, brandPracticeCount,
    teamLabel: TEAM_LABEL_MOBILE,
  });

  // Close on route change
  useEffect(() => { setOpen(false); }, [pathname]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Logout uses the shared helper — see lib/auth/logout for why the
  // redirect must run unconditionally on flaky mobile networks.

  // Same rule as the desktop sidebar: exact match for the two routes that
  // are prefixes of others (/practice, and /practice/bills vs its own
  // /new child), startsWith for the rest.
  function isActive(href: string) {
    const path = href.split('?')[0];
    if (path === '/practice' || path === '/practice/bills') return pathname === path;
    return pathname.startsWith(path);
  }

  return (
    <header className="bg-white border-b border-gray-200 sticky top-0 z-20" ref={menuRef}>
      <div className="px-4 sm:px-6 py-3.5 flex items-center justify-between">
        {/* Logo + practice name */}
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="text-lg font-semibold tracking-tight"
            style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
          >
            <span style={{ color: 'var(--portal-ink)' }}>better</span>
            <span style={{ color: 'var(--portal-accent)' }}>now</span>
          </span>
        </div>

        {/* Desktop: logout */}
        <button
          onClick={() => logoutAndRedirect()}
          className="hidden md:inline-flex rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Log out
        </button>

        {/* Mobile: hamburger */}
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-label={open ? 'Close menu' : 'Open menu'}
          className="md:hidden rounded-lg p-2 text-gray-500 hover:bg-gray-100 transition-colors"
        >
          {open ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile dropdown menu */}
      {open && (
        <div className="md:hidden border-t border-gray-100 bg-white px-3 pb-3 pt-2 space-y-0.5">
          {links.map(({ href, label }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className={[
                  'flex w-full px-3 py-2.5 text-sm font-medium rounded-lg transition-colors',
                  active
                    ? 'bg-[var(--portal-ink)]/10 text-[var(--portal-ink)]'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')}
              >
                {label}
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
    </header>
  );
}
