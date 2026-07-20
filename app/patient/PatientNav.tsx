'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Desktop sidebar labels are aligned with PatientBottomNav so the same
// route reads the same in both viewports — the mobile tab is "Cards",
// so the desktop entry is too. Previously "Payment Methods" on desktop
// while mobile said "Cards" — visually the desktop link looked absent
// to anyone scanning for the "Cards" affordance.
const NAV_LINKS = [
  { href: '/patient',                 label: 'Dashboard'       },
  { href: '/patient/orders',          label: 'Orders'          },
  { href: '/patient/explore',         label: 'Find a Practice' },
  { href: '/patient/payment-methods', label: 'Cards'           },
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
        // Hidden on mobile — bottom nav handles mobile navigation
        'hidden',
        // Desktop: vertical sidebar
        'md:flex md:flex-col md:w-56 md:border-r md:border-gray-200',
        'md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)]',
      ].join(' ')}
    >
      <div className="flex flex-col p-3 space-y-0.5">
        {NAV_LINKS.map(({ href, label }) => {
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
