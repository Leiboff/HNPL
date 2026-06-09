'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/practice',         label: 'Dashboard'        },
  { href: '/practice/members', label: 'Manage Practice'  },
];

export default function PracticeNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    return href === '/practice' ? pathname === '/practice' : pathname.startsWith(href);
  }

  return (
    <nav className="hidden md:flex md:flex-col md:w-56 md:border-r md:border-gray-200 bg-white md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)] shrink-0">
      <div className="flex flex-col p-3 space-y-0.5">
        {LINKS.map(({ href, label }) => {
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
