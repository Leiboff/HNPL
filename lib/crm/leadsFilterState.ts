// ─── Leads filter state — single source of truth, URL-serializable ────
//
// List and Map share ONE filter shape. It round-trips through the URL
// so a filtered view is linkable and survives switching between the
// two — that's the whole point of the switcher (Phase 3, 3.1/3.2).
// Encode/decode are pure and tolerant: decode NEVER throws on garbage
// input (a stale bookmark, a saved view referencing a deleted tag) —
// it just falls back to the default for whatever field is malformed.

export type LeadsView = 'list' | 'map';

export type LeadsFilters = {
  q: string;
  stage: string;        // '' = all stages
  source: string;
  specialty: string;
  tags: string[];        // AND-matched
  city: string;
  suburb: string;
  owner: string;         // '' = all (admin) | 'me' | a specific owner id
  overdue: boolean;
  interest: string;      // '' = all | 'unknown' | 'cold' | 'warm' | 'hot' — derived, see lib/crm/interest.ts
  hpcsaMatch: boolean;   // practitioner also appears at an onboarded lead — see lib/crm/hpcsa.ts
  sort: string;
  view: LeadsView;
};

export const DEFAULT_FILTERS: LeadsFilters = {
  q: '', stage: '', source: '', specialty: '', tags: [],
  city: '', suburb: '', owner: '', overdue: false, interest: '', hpcsaMatch: false,
  sort: 'follow-up', view: 'list',
};

const VALID_VIEWS: readonly LeadsView[] = ['list', 'map'];
const VIEW_PATH: Record<LeadsView, string> = {
  list: '/crm/leads', map: '/crm/map',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Reads a plain string-keyed record (as Next.js hands page components) into LeadsFilters. Never throws. */
export function decodeFilters(params: Record<string, string | string[] | undefined>): LeadsFilters {
  const get = (k: string): string => {
    const v = params[k];
    return Array.isArray(v) ? (v[0] ?? '') : str(v);
  };
  const view = get('view');
  return {
    q:        get('q').slice(0, 60),
    stage:    get('stage'),
    source:   get('source'),
    specialty: get('specialty'),
    tags:     get('tags') ? get('tags').split(',').map(t => t.trim()).filter(Boolean) : [],
    city:     get('city'),
    suburb:   get('suburb'),
    owner:    get('owner'),
    overdue:  get('overdue') === 'true',
    interest: get('interest'),
    hpcsaMatch: get('hpcsaMatch') === 'true',
    sort:     get('sort') || DEFAULT_FILTERS.sort,
    view:     (VALID_VIEWS as readonly string[]).includes(view) ? (view as LeadsView) : DEFAULT_FILTERS.view,
  };
}

/** Encodes LeadsFilters (or a partial patch merged onto defaults) to a URLSearchParams — omits fields at their default so URLs stay short. */
export function encodeFilters(filters: Partial<LeadsFilters>): URLSearchParams {
  const f = { ...DEFAULT_FILTERS, ...filters };
  const params = new URLSearchParams();
  if (f.q)         params.set('q', f.q);
  if (f.stage)      params.set('stage', f.stage);
  if (f.source)     params.set('source', f.source);
  if (f.specialty)  params.set('specialty', f.specialty);
  if (f.tags.length) params.set('tags', f.tags.join(','));
  if (f.city)       params.set('city', f.city);
  if (f.suburb)     params.set('suburb', f.suburb);
  if (f.owner)      params.set('owner', f.owner);
  if (f.overdue)    params.set('overdue', 'true');
  if (f.interest)   params.set('interest', f.interest);
  if (f.hpcsaMatch) params.set('hpcsaMatch', 'true');
  if (f.sort && f.sort !== DEFAULT_FILTERS.sort) params.set('sort', f.sort);
  if (f.view && f.view !== DEFAULT_FILTERS.view) params.set('view', f.view);
  return params;
}

/** href for switching to another view while preserving every other filter. */
export function switchViewHref(current: LeadsFilters, view: LeadsView): string {
  const params = encodeFilters({ ...current, view: view === 'list' ? DEFAULT_FILTERS.view : view });
  // view itself is encoded into the PATH for list/board/map (they're
  // separate routes), not the querystring — drop it from params.
  params.delete('view');
  const qs = params.toString();
  return qs ? `${VIEW_PATH[view]}?${qs}` : VIEW_PATH[view];
}

export type FilterableLead = {
  id: string;
  practice_name: string;
  contact_first_name?: string;
  contact_last_name?: string;
  stage: string;
  source: string;
  specialty: string | null;
  city: string | null;
  suburb: string | null;
  owner_user_id: string | null;
  tags: string[];
  archived_at: string | null;
  next_follow_up_at: string | null;
  interest?: string;   // derived (lib/crm/interest.ts) — absent means "not computed by this caller", treated as unfiltered
  hasOnboardedHpcsaMatch?: boolean;  // derived (lib/crm/hpcsa.ts) — same "absent = unfiltered" contract as interest
};

/** Applies LeadsFilters to an in-memory lead list. Pure — no DB, no clock (overdue is evaluated by the caller passing pre-computed `now`-relative data if needed; here `overdue` just means "has a next_follow_up_at at all" is left to callers that already bucket by date). Generic so callers can pass a richer row shape (extra display columns) without a lossy cast. */
export function applyLeadFilters<T extends FilterableLead>(
  leads: T[],
  filters: LeadsFilters,
  currentUserId: string | null,
): T[] {
  const q = filters.q.trim().toLowerCase();
  return leads.filter((l) => {
    if (l.archived_at) return false;
    if (filters.stage && l.stage !== filters.stage) return false;
    if (filters.source && l.source !== filters.source) return false;
    if (filters.specialty && l.specialty !== filters.specialty) return false;
    if (filters.city && l.city !== filters.city) return false;
    if (filters.suburb && l.suburb !== filters.suburb) return false;
    if (filters.owner === 'me' && l.owner_user_id !== currentUserId) return false;
    if (filters.owner && filters.owner !== 'me' && l.owner_user_id !== filters.owner) return false;
    if (filters.tags.length && !filters.tags.every(t => l.tags.includes(t))) return false;
    if (filters.interest && l.interest !== undefined && l.interest !== filters.interest) return false;
    if (filters.hpcsaMatch && l.hasOnboardedHpcsaMatch !== undefined && !l.hasOnboardedHpcsaMatch) return false;
    if (q) {
      const hay = `${l.practice_name} ${l.contact_first_name ?? ''} ${l.contact_last_name ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
