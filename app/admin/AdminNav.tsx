'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { getAdminNavLinks, isAdminNavActive, adminLinkCount, type AdminCounts } from './adminNavLinks';

// Mirrors the patient portal's PatientNav: desktop-only vertical sidebar
// (md+). On mobile AdminMobileMenu — the hamburger in the top bar —
// renders the SAME links from ./adminNavLinks, so the two cannot diverge.
//
// Badge counts are server-fetched once at the layout level and passed
// down so every page under /admin shares the same numbers without
// re-querying.

export default function AdminNav({ counts }: { counts: AdminCounts }) {
  const pathname = usePathname();
  const links    = getAdminNavLinks();

  return (
    <nav
      className={[
        'bg-white shrink-0',
        // Mobile: hidden — the header's hamburger menu covers it.
        'hidden',
        // Desktop: vertical sidebar matching patient portal width / styling.
        'md:flex md:flex-col md:w-56 md:border-r md:border-gray-200',
        'md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)]',
      ].join(' ')}
    >
      <div className="flex flex-col p-3 space-y-0.5">
        {links.map((link) => {
          const active = isAdminNavActive(link.href, pathname);
          const count  = adminLinkCount(link, counts);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={[
                'flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors',
                active
                  ? 'bg-[#13294B]/10 text-[#13294B]'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              ].join(' ')}
            >
              <span>{link.label}</span>
              {count > 0 && (
                <span
                  className={[
                    'inline-flex items-center justify-center rounded-full text-xs font-bold px-1.5 py-0.5 min-w-[1.25rem] tabular-nums',
                    'bg-amber-100 text-amber-800',
                  ].join(' ')}
                >
                  {count}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
