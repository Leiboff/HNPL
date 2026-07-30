'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// ─── Practice sidebar nav ────────────────────────────────────────────
//
// Two everyday links + one conditional link for brand-admins:
//
//   Dashboard         — /practice
//   Team              — /practice/members
//   Practice details  — /brand/branch/{practiceId}   (brand-admin only)
//
// Why the "Practice details" link points into /brand/branch/{id}:
//   That's the ONLY place with a working practice-edit UI (address +
//   banking) and matching server actions. Adding a second edit
//   surface on the /practice side would fork the write path and
//   drift from the brand-admin edit form. Instead the sidebar
//   surfaces the existing edit page as a first-class nav item for
//   brand-admins of the current practice's brand — the exact set
//   of users who can actually SAVE those changes.
//
// A non-brand-admin (e.g. a practice_admin invited into a branch of
// someone else's brand) doesn't see this link at all — the /brand
// route would notFound() them, and hiding a dead link is friendlier
// than surfacing one.
//
// The `?practiceId=` scope forwards onto /practice + /practice/members
// so a brand-admin with N≥2 branches keeps their current-branch
// context when navigating between sidebar entries. Solo callers
// (isBrandAdmin=true, N=1) get the same URLs without the query
// suffix — page-level fallback resolves the same practice.

type Props = {
  practiceId?:   string;
  isBrandAdmin?: boolean;
};

export default function PracticeNav({ practiceId, isBrandAdmin = false }: Props) {
  const pathname = usePathname();

  const scopeSuffix = practiceId
    ? `?practiceId=${encodeURIComponent(practiceId)}`
    : '';

  const links: Array<{ href: string; label: string }> = [
    { href: `/practice${scopeSuffix}`,         label: 'Dashboard'       },
    { href: `/practice/members${scopeSuffix}`, label: 'Team'            },
  ];
  if (isBrandAdmin && practiceId) {
    links.push({ href: `/brand/branch/${practiceId}`, label: 'Practice details' });
  }

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
