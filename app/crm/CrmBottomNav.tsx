'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

type Counts = { overdueFollowups: number };

function MyDayIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function LeadsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  );
}
function AccountsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}
function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

const LINKS = [
  { href: '/crm',           label: 'Today',    Icon: MyDayIcon,     countKey: 'overdueFollowups' as const },
  { href: '/crm/leads',     label: 'Leads',    Icon: LeadsIcon                                            },
  { href: '/crm/accounts',  label: 'Accounts', Icon: AccountsIcon                                         },
  { href: '/crm/settings',  label: 'Settings', Icon: SettingsIcon                                         },
];

export default function CrmBottomNav({ counts }: { counts: Counts }) {
  const pathname = usePathname();
  function isActive(href: string) {
    if (href === '/crm') return pathname === '/crm';
    if (href === '/crm/leads') return pathname.startsWith('/crm/leads') || pathname.startsWith('/crm/map');
    return pathname.startsWith(href);
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
                    className="absolute -top-1 -right-2 inline-flex items-center justify-center rounded-full bg-red-500 text-white text-[9px] font-bold px-1 py-0.5 min-w-[1rem] tabular-nums"
                    aria-label={`${count} overdue`}
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
