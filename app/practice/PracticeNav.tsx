'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getPracticeNavLinks } from './practiceManagerLinks';

// ─── Practice sidebar nav ────────────────────────────────────────────
//
// An optional exit link, then the tabs:
//
//   ← All practices   — /brand                    (brand-admin with 2+
//                         practices in the brand only)
//   Dashboard         — /practice
//   Bills             — /practice/bills
//   Payouts           — /practice/payouts
//   Team              — /practice/members
//   Settings          — /practice/settings        (anyone with at least
//                         one visible Settings section)
//
// "Till devices" and "Practice details" used to be two separate entries
// here. They are SECTIONS of Settings now, each keeping the authority
// its own screen enforced — brand-admin for details and banking,
// can_manage_practice-or-brand-admin for the till. Settings appears when
// at least one of those is visible, which is why the gate is a shared
// helper (./settings/settingsSections) rather than a condition written
// out here: a visible nav item and a page that will serve you must not
// be able to disagree.
//
// Payouts is a BASE link, not a gated one: both tables behind it are
// readable by any active member (0090/0092). See practiceManagerLinks.
//
// EVERY link, base and conditional, comes from getPracticeNavLinks
// (./practiceManagerLinks) — the SAME function PracticeHeader's mobile
// menu calls. Nothing is spliced by hand here. That is what fixed the
// original bug (Till devices reaching desktop but not mobile: a link
// added to one hand-maintained array and not the other), and moving the
// BASE links in there too is what stops "Bills" repeating it.
//
// The one intentional difference between the surfaces is the Team
// label — "Team" here, "Manage Practice" on mobile. It predates all of
// this and was never the bug, so it is passed in as a parameter rather
// than being a second list.
//
// The `?practiceId=` scope forwards onto every entry so a brand-admin
// with N≥2 branches keeps their current-branch context. Solo callers
// (isBrandAdmin=true, N=1) get the same URLs without the query suffix —
// page-level fallback resolves the same practice.

type Props = {
  practiceId?:          string;
  isBrandAdmin?:        boolean;
  canManageTill?:       boolean;
  brandPracticeCount?:  number;
};

export default function PracticeNav({
  practiceId,
  isBrandAdmin = false,
  canManageTill = false,
  brandPracticeCount = 0,
}: Props) {
  const pathname = usePathname();

  const links = getPracticeNavLinks({
    practiceId, canManageTill, isBrandAdmin, brandPracticeCount,
    teamLabel: 'Team',
  });

  function isActive(href: string) {
    const path = href.split('?')[0];
    // Exact match for the two routes that are prefixes of others:
    //   /practice        is a prefix of every practice route
    //   /practice/bills  is a prefix of /practice/bills/new
    // A startsWith test would light up Bills while the caller is on the
    // new-bill form, which is a different screen with its own heading.
    if (path === '/practice' || path === '/practice/bills') return pathname === path;
    return pathname.startsWith(path);
  }

  return (
    <nav className="hidden md:flex md:flex-col md:w-56 md:border-r md:border-gray-200 bg-white md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)] shrink-0">
      <div className="flex flex-col p-3 space-y-0.5">
        {links.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={[
                'px-3 py-2 text-sm font-medium rounded-lg transition-colors',
                active
                  ? 'bg-[var(--portal-ink)]/10 text-[var(--portal-ink)]'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              ].join(' ')}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
