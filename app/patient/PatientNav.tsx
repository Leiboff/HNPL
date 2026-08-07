'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// ─── PatientNav — desktop sidebar (md+) ──────────────────────────────────
//
// Labels mirror the mobile bottom nav so the same route reads the same in
// both viewports. v4 collapsed five tabs to four: Home / Plans / Find care
// / Account. Cards and Profile merged into Account; the standalone
// /patient/payment-methods and /patient/profile routes redirect there.
const NAV_LINKS = [
  { href: '/patient',         label: 'Home'      },
  { href: '/patient/orders',  label: 'Plans'     },
  { href: '/patient/explore', label: 'Find care' },
  { href: '/patient/account', label: 'Account'   },
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
        'md:sticky md:top-0 md:self-start md:min-h-screen',
      ].join(' ')}
    >
      <Link
        href="/patient"
        className="px-4 py-4 text-lg font-semibold tracking-tight"
        style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}
      >
        <span style={{ color: '#13294B' }}>better</span>
        <span style={{ color: '#15A89E' }}>now</span>
      </Link>
      <div className="flex flex-col p-3 space-y-0.5">
        {NAV_LINKS.map(({ href, label }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              // Full-row tap target: explicit block-level flex box (not
              // relying on implicit flex-item stretch), w-full so the whole
              // row width is clickable, min-h-[44px] so the padding + label
              // form one ≥44px hit area (was ~36px, content-height only).
              className={[
                'flex items-center w-full min-h-[44px] px-3 text-sm font-medium rounded-lg transition-colors',
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
