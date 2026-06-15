'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

// Mobile-only fixed bottom nav for the admin portal. Mirrors the
// PatientBottomNav blur/glass treatment for visual consistency.

type Counts = {
  pendingPractices: number;
  outstandingRefunds: number;
};

function OperationsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3"  width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function PracticesIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21V9l9-6 9 6v12" />
      <path d="M9 21v-7h6v7" />
    </svg>
  );
}

function RefundsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <polyline points="3 3 3 9 9 9" />
    </svg>
  );
}

const LINKS = [
  { href: '/admin',                          label: 'Ops',       Icon: OperationsIcon                                },
  { href: '/admin/practices?status=pending', label: 'Practices', Icon: PracticesIcon, countKey: 'pendingPractices' as const },
  { href: '/admin/refunds',                  label: 'Refunds',   Icon: RefundsIcon,   countKey: 'outstandingRefunds' as const },
];

export default function AdminBottomNav({ counts }: { counts: Counts }) {
  const pathname = usePathname();

  function isActive(href: string) {
    const path = href.split('?')[0];
    if (path === '/admin') return pathname === '/admin';
    return pathname.startsWith(path);
  }

  return (
    <div
      className="fixed bottom-0 inset-x-0 z-30 md:hidden px-4"
      style={{ paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}
    >
      <nav
        className="flex h-15.5 rounded-2xl overflow-hidden"
        style={{
          background: 'rgba(255,255,255,0.93)',
          backdropFilter: 'blur(20px)',
          WebkitBackdropFilter: 'blur(20px)',
          border: '1px solid rgba(19,41,75,0.10)',
          boxShadow: '0 8px 32px -6px rgba(19,41,75,0.18), 0 2px 8px -2px rgba(19,41,75,0.08)',
        }}
      >
        {LINKS.map(({ href, label, Icon, countKey }) => {
          const active = isActive(href);
          const count  = countKey ? counts[countKey] : 0;
          return (
            <Link
              key={href}
              href={href}
              className="relative flex-1 flex flex-col items-center justify-center gap-1"
              style={{ color: active ? '#15A89E' : '#94a3b8', transition: 'color 0.15s' }}
            >
              <div className="relative">
                <Icon active={active} />
                {count > 0 && (
                  <span
                    className="absolute -top-1 -right-2 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[9px] font-bold px-1 py-0.5 min-w-[1rem] tabular-nums"
                    aria-label={`${count} pending`}
                  >
                    {count}
                  </span>
                )}
              </div>
              <span
                className="text-[10px] leading-none font-semibold"
                style={{ color: active ? '#13294B' : '#94a3b8', transition: 'color 0.15s' }}
              >
                {label}
              </span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
