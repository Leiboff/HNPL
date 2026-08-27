import { describe, it, expect } from 'vitest';
import { SEED_VIEWS, resolveSeedFilters, isSeedViewActive } from './savedViews';
import { applyLeadFilters, DEFAULT_FILTERS, type FilterableLead } from './leadsFilterState';

const FIXTURE: FilterableLead[] = [
  { id: 'new-mine',       practice_name: 'New Mine',       stage: 'new',       source: 'other', specialty: null, city: null, suburb: null, owner_user_id: 'me', tags: [], archived_at: null, next_follow_up_at: null },
  { id: 'new-theirs',     practice_name: 'New Theirs',     stage: 'new',       source: 'other', specialty: null, city: null, suburb: null, owner_user_id: 'them', tags: [], archived_at: null, next_follow_up_at: null },
  { id: 'contacted-mine', practice_name: 'Contacted Mine', stage: 'contacted', source: 'other', specialty: null, city: null, suburb: null, owner_user_id: 'me', tags: [], archived_at: null, next_follow_up_at: null },
  { id: 'archived-new',   practice_name: 'Archived New',   stage: 'new',       source: 'other', specialty: null, city: null, suburb: null, owner_user_id: 'me', tags: [], archived_at: '2026-01-01T00:00:00Z', next_follow_up_at: null },
];

describe('3. each seeded saved view returns the expected set against a seeded fixture', () => {
  it('"Needs a first call" returns exactly the non-archived stage=new leads', () => {
    const view = SEED_VIEWS.find(v => v.id === 'seed-first-call')!;
    const filters = resolveSeedFilters(view);
    const result = applyLeadFilters(FIXTURE, filters, 'me');
    expect(result.map(r => r.id).sort()).toEqual(['new-mine', 'new-theirs']); // archived-new excluded, contacted-mine excluded
  });

  it('"My day" scopes to owner=me', () => {
    const view = SEED_VIEWS.find(v => v.id === 'seed-my-day')!;
    const filters = resolveSeedFilters(view);
    const result = applyLeadFilters(FIXTURE, filters, 'me');
    expect(result.every(r => r.owner_user_id === 'me')).toBe(true);
    expect(result.map(r => r.id)).not.toContain('new-theirs');
  });

  it('"Everything" returns every non-archived lead with no other constraint', () => {
    const view = SEED_VIEWS.find(v => v.id === 'seed-everything')!;
    const filters = resolveSeedFilters(view);
    const result = applyLeadFilters(FIXTURE, filters, 'me');
    expect(result.map(r => r.id).sort()).toEqual(['contacted-mine', 'new-mine', 'new-theirs']);
  });

  it('every seed view resolves to a full, valid LeadsFilters object (every field present)', () => {
    for (const view of SEED_VIEWS) {
      const resolved = resolveSeedFilters(view);
      expect(Object.keys(resolved).sort()).toEqual(Object.keys(DEFAULT_FILTERS).sort());
    }
  });
});

describe('isSeedViewActive', () => {
  it('flags the matching seed active and the others inactive', () => {
    const current = { ...DEFAULT_FILTERS, stage: 'new', sort: 'created-desc' };
    const flags = SEED_VIEWS.map(v => [v.id, isSeedViewActive(current, v)] as const);
    expect(flags.find(([id]) => id === 'seed-first-call')?.[1]).toBe(true);
    expect(flags.filter(([, active]) => active)).toHaveLength(1);
  });

  it('"Everything" is active only on the untouched default state', () => {
    const everything = SEED_VIEWS.find(v => v.id === 'seed-everything')!;
    expect(isSeedViewActive(DEFAULT_FILTERS, everything)).toBe(true);
    expect(isSeedViewActive({ ...DEFAULT_FILTERS, stage: 'new' }, everything)).toBe(false);
  });
});
