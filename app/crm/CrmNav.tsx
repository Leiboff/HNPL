'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Desktop sidebar for /crm. Mirrors AdminNav layout with a smaller
// section set: My Day / Leads / Board / Import. Counts (overdue
// follow-ups today) come from the layout.

type Counts = {
  overdueFollowups: number;
};

type NavLink = { href: string; label: string; countKey?: keyof Counts; adminOnly?: boolean };

const NAV_LINKS: NavLink[] = [
  { href: '/crm',                        label: 'My Day',   countKey: 'overdueFollowups' },
  { href: '/crm/leads',                  label: 'Leads'                                   },
  { href: '/crm/board',                  label: 'Pipeline'                                },
  { href: '/crm/map',                    label: 'Map'                                     },
  { href: '/crm/import',                 label: 'Import'                                  },
  { href: '/crm/settings',               label: 'Settings'                                },
  { href: '/crm/admin/gmail-accounts',   label: 'Gmail (admin)', adminOnly: true          },
];

export default function CrmNav({ counts, isAdmin }: { counts: Counts; isAdmin?: boolean }) {
  const pathname = usePathname();

  function isActive(href: string) {
    if (href === '/crm') return pathname === '/crm';
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
