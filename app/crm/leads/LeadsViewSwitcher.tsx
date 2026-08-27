'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

// ─── List · Board · Map switcher ───────────────────────────────────────
//
// The whole filter querystring travels verbatim between the three
// routes — that's what makes "single filter state that survives
// switching" true without requiring the three pages to be merged into
// one component. Board/Map decode the same params via
// lib/crm/leadsFilterState.ts and apply them server-side.

const TABS = [
  { view: 'list',  href: '/crm/leads', label: 'List' },
  { view: 'board', href: '/crm/board', label: 'Board' },
  { view: 'map',   href: '/crm/map',   label: 'Map' },
] as const;

export default function LeadsViewSwitcher() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const qs = searchParams.toString();

  return (
    <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-0.5" role="tablist" aria-label="Leads view">
      {TABS.map(({ view, href, label }) => {
        const active = pathname.startsWith(href);
        return (
          <Link
            key={view}
            href={qs ? `${href}?${qs}` : href}
            role="tab"
            aria-selected={active}
            data-testid={`leads-view-switch:${view}`}
            className={
              'px-3 py-1.5 text-xs font-medium rounded-md transition-colors '
              + (active ? 'bg-white text-[#13294B] shadow-sm' : 'text-gray-500 hover:text-gray-700')
            }
          >
            {label}
          </Link>
        );
      })}
    </div>
  );
}
