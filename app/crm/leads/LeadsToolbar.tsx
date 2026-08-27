'use client';

import { useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import LeadsFilterDropdowns from './LeadsFilterDropdowns';

// ─── Sort / Filter buttons — retail-style ──────────────────────────────
//
// Two buttons instead of a wall of always-visible chips + dropdowns:
// "Sort" and "Filter (n)", each opening a sheet with the actual
// options. Matches the fixed-inset sheet pattern already used
// throughout this app (LogSheet, ScheduleSheet, MoveStageSheet).
// Distance-from-me lives in the Sort sheet alongside the other five —
// it's a sort, and burying it as a clickable table-column-header was
// not discoverable.

const SORTS = ['follow-up', 'updated', 'created-desc', 'value', 'priority'] as const;
const SORT_LABEL: Record<(typeof SORTS)[number], string> = {
  'follow-up':    'Next follow-up',
  'updated':      'Recently updated',
  'created-desc': 'Newest first',
  'value':        'Value',
  'priority':     'Priority',
};

export default function LeadsToolbar({
  specialties, cities, owners, isAdmin, currentUserId,
  distanceSortActive, locating, onSelectDistanceSort,
}: {
  specialties: readonly string[];
  cities: string[];
  owners: Array<{ id: string; name: string }>;
  isAdmin: boolean;
  currentUserId: string;
  distanceSortActive: boolean;
  locating: boolean;
  onSelectDistanceSort: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [openSheet, setOpenSheet] = useState<'sort' | 'filter' | null>(null);

  const currentSort = (SORTS as readonly string[]).includes(searchParams.get('sort') ?? '')
    ? (searchParams.get('sort') as (typeof SORTS)[number])
    : 'follow-up';
  const sortLabel = distanceSortActive ? 'Distance from me' : SORT_LABEL[currentSort];

  const activeFilterCount = ['stage', 'source', 'specialty', 'city', 'owner'].filter(k => searchParams.get(k)).length
    + (searchParams.get('overdue') === 'true' ? 1 : 0);

  function selectSort(key: (typeof SORTS)[number]) {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sort', key);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
    setOpenSheet(null);
  }

  function selectDistanceSort() {
    onSelectDistanceSort();
    setOpenSheet(null);
  }

  return (
    <div className="flex items-center gap-2" data-testid="leads-toolbar">
      <button
        type="button"
        onClick={() => setOpenSheet('sort')}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-gray-300"
        data-testid="open-sort-sheet"
      >
        <SortIcon />
        Sort: {sortLabel}
      </button>
      <button
        type="button"
        onClick={() => setOpenSheet('filter')}
        className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-gray-300"
        data-testid="open-filter-sheet"
      >
        <FilterIcon />
        Filter
        {activeFilterCount > 0 && (
          <span className="inline-flex items-center justify-center rounded-full bg-[#15A89E] text-white text-[10px] font-bold px-1.5 py-0.5 min-w-[1.1rem]">
            {activeFilterCount}
          </span>
        )}
      </button>

      {openSheet === 'sort' && (
        <Sheet title="Sort by" onClose={() => setOpenSheet(null)}>
          <div className="space-y-1">
            {SORTS.map(s => (
              <SheetOption
                key={s}
                label={SORT_LABEL[s]}
                active={!distanceSortActive && s === currentSort}
                onClick={() => selectSort(s)}
                testId={`sort-option:${s}`}
              />
            ))}
            <SheetOption
              label={locating ? 'Getting your location…' : 'Distance from me'}
              active={distanceSortActive}
              onClick={selectDistanceSort}
              disabled={locating}
              testId="sort-option:distance"
              icon={<LocationIcon />}
            />
          </div>
        </Sheet>
      )}

      {openSheet === 'filter' && (
        <Sheet title="Filter" onClose={() => setOpenSheet(null)}>
          <LeadsFilterDropdowns
            specialties={specialties}
            cities={cities}
            owners={owners}
            isAdmin={isAdmin}
            currentUserId={currentUserId}
            layout="stacked"
          />
          {activeFilterCount > 0 && (
            <button
              type="button"
              onClick={() => { router.push(pathname); setOpenSheet(null); }}
              className="mt-3 text-xs font-medium text-gray-500 hover:text-gray-700"
              data-testid="clear-all-filters"
            >
              Clear all filters
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true">
      <div className="bg-white rounded-t-2xl sm:rounded-2xl border border-gray-200 shadow-lg w-full sm:max-w-sm max-h-[80vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 sticky top-0 bg-white">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} className="text-xs text-gray-500" data-testid="close-sheet">Done</button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

function SheetOption({ label, active, onClick, disabled, testId, icon }: {
  label: string; active: boolean; onClick: () => void; disabled?: boolean; testId: string; icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className={
        'w-full flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-left disabled:opacity-60 '
        + (active ? 'bg-[#15A89E]/10 text-[#15A89E] font-medium' : 'text-gray-700 hover:bg-gray-50')
      }
    >
      {icon}
      <span className="flex-1">{label}</span>
      {active && <CheckIcon />}
    </button>
  );
}

function SortIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M6 12h12M10 18h4" />
    </svg>
  );
}
function FilterIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 3H2l8 9.46V19l4 2v-8.54L22 3z" />
    </svg>
  );
}
function LocationIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
function CheckIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
