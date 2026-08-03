'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Mirrors the patient portal's PatientNav: desktop-only vertical sidebar
// (md+). On mobile the AdminBottomNav handles navigation.
//
// Badge counts are server-fetched once at the layout level and passed
// down so every page under /admin shares the same numbers without
// re-querying.

type Counts = {
  pendingPractices:    number;
  overdueCollections:  number;
  pendingPayouts:      number;
};

const NAV_LINKS = [
  { href: '/admin',                            label: 'Dashboard'                                                            },
  { href: '/admin/practices?status=pending',   label: 'Practices',   countKey: 'pendingPractices'    as const                },
  { href: '/admin/customers',                  label: 'Customers'                                                            },
  { href: '/admin/collections?chip=overdue',   label: 'Collections', countKey: 'overdueCollections'  as const                },
  { href: '/admin/payouts',                    label: 'Payouts',     countKey: 'pendingPayouts'      as const                },
  { href: '/crm',                              label: 'CRM'                                                                  },
  { href: '/admin/sales-team',                 label: 'Sales team'                                                           },
];

export default function AdminNav({ counts }: { counts: Counts }) {
  const pathname = usePathname();

  function isActive(href: string) {
    const path = href.split('?')[0];
    if (path === '/admin') return pathname === '/admin';
    return pathname.startsWith(path);
  }

  return (
    <nav
      className={[
        'bg-white shrink-0',
        // Mobile: hidden — AdminBottomNav covers it.
        'hidden',
        // Desktop: vertical sidebar matching patient portal width / styling.
        'md:flex md:flex-col md:w-56 md:border-r md:border-gray-200',
        'md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)]',
      ].join(' ')}
    >
      <div className="flex flex-col p-3 space-y-0.5">
        {NAV_LINKS.map(({ href, label, countKey }) => {
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
