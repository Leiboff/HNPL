'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getPracticeManagerLinks, getBrandExitLink } from './practiceManagerLinks';

// ─── Practice sidebar nav ────────────────────────────────────────────
//
// An optional exit link, the everyday links, and two conditional links
// gated on manager-tier authority:
//
//   ← All practices   — /brand                       (brand-admin with
//                         2+ practices in the brand only)
//   Dashboard         — /practice
//   Team              — /practice/members
//   Till devices       — /practice/pos/devices?practiceId={id}  (manager
//                         or brand-admin only)
//   Practice details  — /practice/details?practiceId={id}  (brand-admin
//                         only)
//
// "Practice details" used to deep-link into /brand/branch/{id}, because
// that was then the ONLY place with a working practice-edit UI. That
// route was doing double duty — a multi-branch performance view AND the
// de-facto settings page — so it now pivots into the practice dashboard
// and the settings moved to /practice/details, inside this shell. The
// write path did not fork: /practice/details renders the same two forms
// against the same updateBranchDetails / updateBranchBanking actions.
//
// The gate is unchanged. A non-brand-admin (e.g. a practice_admin
// invited into a branch of someone else's brand) doesn't see the link at
// all — /practice/details notFound()s them exactly as the brand route
// did, since brand-admin of the practice's group is the authority both
// save actions enforce.
//
// "Till devices" was previously reachable ONLY by typing the URL
// directly — there was no link to it anywhere (single-practice sidebar
// or the brand branch strip). canManageTill is can_manage_practice OR
// isBrandAdmin — the exact same two-way authority
// app/practice/pos/devices/actions.ts's guardTillManager() now checks,
// so a visible link and a working destination always agree. The
// destination re-verifies server-side regardless (this is a visibility
// gate, not the authorization boundary).
//
// The two CONDITIONAL links (Till devices, Practice details) come from
// getPracticeManagerLinks (./practiceManagerLinks) — the SAME function
// PracticeHeader's mobile menu uses — rather than being hand-repeated
// here. That's what fixed the original bug (Till devices reaching
// desktop but not mobile): a link added to one hand-maintained array
// and not the other. Dashboard/Team stay this component's own base
// list — their labels already differ from PracticeHeader's mobile
// wording ("Manage Practice") by design, which was never the bug.
//
// The `?practiceId=` scope forwards onto /practice + /practice/members
// + /practice/pos/devices so a brand-admin with N≥2 branches keeps
// their current-branch context when navigating between sidebar entries.
// Solo callers (isBrandAdmin=true, N=1) get the same URLs without the
// query suffix — page-level fallback resolves the same practice.

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

  const scopeSuffix = practiceId
    ? `?practiceId=${encodeURIComponent(practiceId)}`
    : '';

  // "← All practices" sits ABOVE the base list — it exits upward to the
  // brand view rather than being a peer of Dashboard/Team. Comes from the
  // same shared source as the conditional links (getBrandExitLink) so it
  // isn't hand-written on either surface.
  const exitLink = getBrandExitLink({ isBrandAdmin, brandPracticeCount });

  const links: Array<{ href: string; label: string }> = [
    ...(exitLink ? [exitLink] : []),
    { href: `/practice${scopeSuffix}`,         label: 'Dashboard'       },
    { href: `/practice/members${scopeSuffix}`, label: 'Team'            },
    ...getPracticeManagerLinks({ practiceId, canManageTill, isBrandAdmin }),
  ];

  function isActive(href: string) {
    const path = href.split('?')[0];
    return path === '/practice' ? pathname === '/practice' : pathname.startsWith(path);
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
                  ? 'bg-[#13294B]/10 text-[#13294B]'
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
