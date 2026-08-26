import { DEFAULT_FILTERS, type LeadsFilters } from './leadsFilterState';

// ─── Seed saved views ───────────────────────────────────────────────
//
// Shown in the segmented control before a user has saved any real
// crm_saved_views rows (or alongside them, always available). Each
// is a filter patch merged onto DEFAULT_FILTERS — comparing a lead's
// filters against these is how the UI highlights which one is active.

export type SeedView = {
  id: string;
  name: string;
  filters: Partial<LeadsFilters>;
};

export const SEED_VIEWS: SeedView[] = [
  { id: 'seed-my-day',     name: 'My day',              filters: { owner: 'me', overdue: true, sort: 'follow-up' } },
  { id: 'seed-first-call', name: 'Needs a first call',   filters: { stage: 'new', sort: 'created-desc' } },
  { id: 'seed-waiting',    name: 'Waiting on me',        filters: { owner: 'me', sort: 'priority' } },
  { id: 'seed-high-value', name: 'High value',           filters: { sort: 'value' } },
  { id: 'seed-everything', name: 'Everything',           filters: {} },
];

export function resolveSeedFilters(seed: SeedView): LeadsFilters {
  return { ...DEFAULT_FILTERS, ...seed.filters };
}

/** True when `current` matches `seed`'s filters on every field the seed actually constrains (fields the seed leaves at default are ignored, so "Everything" — which constrains nothing — matches only when every filter is untouched). */
export function isSeedViewActive(current: LeadsFilters, seed: SeedView): boolean {
  const keys = Object.keys(seed.filters) as Array<keyof LeadsFilters>;
  if (keys.length === 0) {
    // "Everything"-shaped seed: active only when current is the untouched default (q aside).
    return (Object.keys(DEFAULT_FILTERS) as Array<keyof LeadsFilters>).every((key) => {
      if (key === 'q') return true;
      return current[key] === DEFAULT_FILTERS[key];
    });
  }
  return keys.every((key) => {
    const a = current[key];
    const b = seed.filters[key];
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every(v => b.includes(v));
    return a === b;
  });
}
