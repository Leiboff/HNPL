'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Desktop sidebar for /crm. Four sections: Today / Leads / Accounts /
// Settings. Counts (overdue follow-ups today) come from the layout.

type Counts = {
  overdueFollowups: number;
};

type NavLink = { href: string; label: string; countKey?: keyof Counts; adminOnly?: boolean };

// Collapsed to four sections (Phase 3, 3.1): Today / Leads (List · Board ·
// Map switcher lives INSIDE the Leads surface, not as separate top-level
// nav items) / Accounts / Settings (Gmail, signature, import all live
// there now — see app/crm/settings/page.tsx).
const NAV_LINKS: NavLink[] = [
  { href: '/crm',                        label: 'Today',    countKey: 'overdueFollowups' },
  { href: '/crm/leads',                  label: 'Leads'                                   },
  { href: '/crm/accounts',               label: 'Accounts'                                },
  { href: '/crm/settings',               label: 'Settings'                                },
];

export default function CrmNav({ counts, isAdmin }: { counts: Counts; isAdmin?: boolean }) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === '/crm') return pathname === '/crm';
    // /crm/map is the Map face of the same Leads surface (the switcher
    // lives on the page, not in top-level nav).
    if (href === '/crm/leads') return pathname.startsWith('/crm/leads') || pathname.startsWith('/crm/map');
    return pathname.startsWith(href);
  }

  return (
    <nav
      className={[
        'bg-white shrink-0',
        'hidden',
        'md:flex md:flex-col md:w-56 md:border-r md:border-gray-200',
        'md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)]',
      ].join(' ')}
    >
      <div className="flex flex-col p-3 space-y-0.5">
        {NAV_LINKS.filter(l => !l.adminOnly || isAdmin).map(({ href, label, countKey }) => {
          const active = isActive(href);
          const count  = countKey ? counts[countKey] : 0;
          return (
            <Link
              key={href}
              href={href}
              className={[
                'flex items-center justify-between gap-2 px-3 py-2 text-sm font-medium rounded-lg transition-colors',
                active
                  ? 'bg-[#13294B]/10 text-[#13294B]'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              ].join(' ')}
            >
              <span>{label}</span>
              {count > 0 && (
                <span className="inline-flex items-center justify-center rounded-full text-xs font-bold px-1.5 py-0.5 min-w-[1.25rem] tabular-nums bg-red-100 text-red-800">
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
