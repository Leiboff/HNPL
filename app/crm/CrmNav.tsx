'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

// Desktop sidebar for /crm. Four sections: Today / Leads / Accounts /
// Settings. Counts (overdue follow-ups today) come from the layout.
//
// Collapsible to an icon-only rail so the leads table (and other wide
// surfaces) can use the full screen width — state persists in
// localStorage so it survives navigation/reload. Lazy useState
// initializer (not useEffect+setState) per house convention for
// one-time synchronous localStorage reads.

const STORAGE_KEY = 'crm-nav-collapsed';

type Counts = {
  overdueFollowups: number;
};

type NavLink = { href: string; label: string; countKey?: keyof Counts; adminOnly?: boolean; Icon: (p: { active: boolean }) => React.ReactNode };

function TodayIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function LeadsIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
    </svg>
  );
}
function AccountsIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2" />
      <line x1="2" y1="10" x2="22" y2="10" />
    </svg>
  );
}
function SettingsIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.25 : 1.75} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function CollapseIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      style={{ transform: collapsed ? 'rotate(180deg)' : undefined }}>
      <polyline points="11 17 6 12 11 7" />
      <polyline points="18 17 13 12 18 7" />
    </svg>
  );
}

// Collapsed to four sections (Phase 3, 3.1): Today / Leads (List · Board ·
// Map switcher lives INSIDE the Leads surface, not as separate top-level
// nav items) / Accounts / Settings (Gmail, signature, import all live
// there now — see app/crm/settings/page.tsx).
const NAV_LINKS: NavLink[] = [
  { href: '/crm',                        label: 'Today',    countKey: 'overdueFollowups', Icon: TodayIcon    },
  { href: '/crm/leads',                  label: 'Leads',                                  Icon: LeadsIcon    },
  { href: '/crm/accounts',               label: 'Accounts',                               Icon: AccountsIcon },
  { href: '/crm/settings',               label: 'Settings',                               Icon: SettingsIcon },
];

function readStoredCollapsed(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export default function CrmNav({ counts, isAdmin }: { counts: Counts; isAdmin?: boolean }) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(() => (typeof window === 'undefined' ? false : readStoredCollapsed()));

  function isActive(href: string) {
    if (href === '/crm') return pathname === '/crm';
    // /crm/map is the Map face of the same Leads surface (the switcher
    // lives on the page, not in top-level nav).
    if (href === '/crm/leads') return pathname.startsWith('/crm/leads') || pathname.startsWith('/crm/map');
    return pathname.startsWith(href);
  }

  function toggleCollapsed() {
    setCollapsed(prev => {
      const next = !prev;
      try { window.localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* private-mode storage — ignore */ }
      return next;
    });
  }

  return (
    <nav
      className={[
        'bg-white shrink-0',
        'hidden',
        'md:flex md:flex-col md:border-r md:border-gray-200',
        collapsed ? 'md:w-14' : 'md:w-56',
        'md:sticky md:top-16 md:self-start md:min-h-[calc(100vh-4rem)]',
        'transition-[width] duration-150',
      ].join(' ')}
      data-testid="crm-nav"
      data-collapsed={collapsed}
    >
      <div className={collapsed ? 'flex justify-center p-3 pb-1' : 'flex justify-end p-3 pb-1'}>
        <button
          type="button"
          onClick={toggleCollapsed}
          className="flex items-center justify-center rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          data-testid="crm-nav-collapse-toggle"
          aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          title={collapsed ? 'Expand' : 'Collapse'}
        >
          <CollapseIcon collapsed={collapsed} />
        </button>
      </div>
      <div className={'flex flex-col p-3 pt-0 space-y-0.5 flex-1'}>
        {NAV_LINKS.filter(l => !l.adminOnly || isAdmin).map(({ href, label, countKey, Icon }) => {
          const active = isActive(href);
          const count  = countKey ? counts[countKey] : 0;
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={[
                'relative flex items-center gap-2 py-2 text-sm font-medium rounded-lg transition-colors',
                collapsed ? 'justify-center px-1' : 'justify-between px-3',
                active
                  ? 'bg-[#13294B]/10 text-[#13294B]'
                  : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
              ].join(' ')}
            >
              <span className="flex items-center gap-2 min-w-0">
                <Icon active={active} />
                {!collapsed && <span className="truncate">{label}</span>}
              </span>
              {count > 0 && (
                collapsed ? (
                  <span className="absolute top-0.5 right-0.5 inline-flex items-center justify-center rounded-full text-[9px] font-bold px-1 py-0.5 min-w-[1rem] tabular-nums bg-red-100 text-red-800">
                    {count}
                  </span>
                ) : (
                  <span className="inline-flex items-center justify-center rounded-full text-xs font-bold px-1.5 py-0.5 min-w-[1.25rem] tabular-nums bg-red-100 text-red-800">
                    {count}
                  </span>
                )
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
