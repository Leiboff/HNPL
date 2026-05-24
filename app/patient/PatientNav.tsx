'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const NAV_LINKS = [
  { href: '/patient',                 label: 'Dashboard'       },
  { href: '/patient/orders',          label: 'Orders'          },
  { href: '/patient/payment-methods', label: 'Payment Methods' },
  { href: '/patient/profile',         label: 'Profile'         },
];

export default function PatientNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === '/patient' ? pathname === '/patient' : pathname.startsWith(href);
  }

  return (
    <nav
      className={[
        'bg-white shrink-0',
        // Mobile: horizontal scrollable bar below top bar
        'flex flex-row overflow-x-auto border-b border-gray-200',
        // Desktop: vertical sidebar
        'md:flex-col md:overflow-visible md:w-56 md:border-b-0 md:border-r md:border-gray-200',
        'md:sticky md:top-14 md:self-start md:min-h-[calc(100vh-3.5rem)]',
      ].join(' ')}
    >
      <div className="flex flex-row md:flex-col md:p-3 md:space-y-0.5">
        {NAV_LINKS.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              className={[
                'shrink-0 px-4 py-3 md:px-3 md:py-2 text-sm font-medium whitespace-nowrap transition-colors',
                // Mobile active: blue bottom border
                'border-b-2 md:border-b-0',
                // Desktop active: blue pill background
                'md:rounded-lg',
                active
                  ? 'border-blue-600 text-blue-700 md:border-0 md:bg-blue-50 md:text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700 md:text-gray-600 md:hover:bg-gray-100 md:hover:text-gray-900',
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
