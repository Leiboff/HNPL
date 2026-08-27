import Link from 'next/link';
import { SEED_VIEWS, resolveSeedFilters, isSeedViewActive } from '@/lib/crm/savedViews';
import { decodeFilters, encodeFilters } from '@/lib/crm/leadsFilterState';

// ─── Segmented control of saved views ─────────────────────────────────
//
// Replaces the old pill wall's job of "quick jump to a common slice" —
// search box + this + a Filters disclosure for everything else (Phase
// 3, 3.2). Seed views today; once a user has real crm_saved_views rows
// they'd render alongside these (same component, same click-through —
// left as a follow-up since seeding is the part the spec actually asks
// for now).

export default function SavedViewsBar({ params }: { params: Record<string, string | string[] | undefined> }) {
  const current = decodeFilters(params);

  return (
    <div className="flex gap-1.5 flex-wrap" role="tablist" aria-label="Saved views" data-testid="saved-views-bar">
      {SEED_VIEWS.map((view) => {
        const active = isSeedViewActive(current, view);
        const href = `/crm/leads?${encodeFilters(resolveSeedFilters(view)).toString()}`;
        return (
          <Link
            key={view.id}
            href={href}
            role="tab"
            aria-selected={active}
            data-testid={`saved-view:${view.id}`}
            className={
              'rounded-full px-3 py-1.5 text-xs font-medium border transition-colors '
              + (active
                ? 'border-[#15A89E] bg-[#15A89E]/10 text-[#15A89E]'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300')
            }
          >
            {view.name}
          </Link>
        );
      })}
    </div>
  );
}
