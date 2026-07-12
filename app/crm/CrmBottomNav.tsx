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
function PipelineIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3"  y="3"  width="5" height="18" rx="1" />
      <rect x="10" y="3"  width="5" height="12" rx="1" />
      <rect x="17" y="3"  width="4" height="7"  rx="1" />
    </svg>
  );
}
function ImportIcon({ active }: { active: boolean }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

const LINKS = [
  { href: '/crm',        label: 'My Day',   Icon: MyDayIcon,    countKey: 'overdueFollowups' as const },
  { href: '/crm/leads',  label: 'Leads',    Icon: LeadsIcon                                          },
  { href: '/crm/board',  label: 'Pipeline', Icon: PipelineIcon                                       },
  { href: '/crm/import', label: 'Import',   Icon: ImportIcon                                         },
];

export default function CrmBottomNav({ counts }: { counts: Counts }) {
  const pathname = usePathname();
  function isActive(href: string) {
    if (href === '/crm') return pathname === '/crm';
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
