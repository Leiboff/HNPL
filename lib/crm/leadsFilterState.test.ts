import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FILTERS, decodeFilters, encodeFilters, switchViewHref, applyLeadFilters,
  type LeadsFilters, type FilterableLead,
} from './leadsFilterState';

function paramsToRecord(params: URLSearchParams): Record<string, string> {
  return Object.fromEntries(params.entries());
}

describe('1. filter state survives List → Map → List with no loss', () => {
  it('round-trips every field through switchViewHref across both views', () => {
    const f: LeadsFilters = {
      q: 'dental', stage: 'contacted', source: 'referral', specialty: 'Dentistry',
      tags: ['hot', 'follow-up'], city: 'Cape Town', suburb: 'Rondebosch',
      owner: 'me', overdue: true, sort: 'value', view: 'list',
    };
    const toMap = switchViewHref(f, 'map');
    expect(toMap).toContain('/crm/map?');
    const mapParams = new URLSearchParams(toMap.split('?')[1]);
    const afterMap = decodeFilters(paramsToRecord(mapParams));

    const toList = switchViewHref(afterMap, 'list');
    const listParams = new URLSearchParams(toList.includes('?') ? toList.split('?')[1] : '');
    const afterList = decodeFilters(paramsToRecord(listParams));

    // Every field except `view` (which lives in the path, not the query) must survive.
    expect({ ...afterList, view: 'list' }).toEqual({ ...f, view: 'list' });
  });
});

describe('2. a filtered URL opened cold in a new session reproduces it exactly', () => {
  it('decode(encode(f)) is a fixed point', () => {
    const f: LeadsFilters = {
      q: 'acme', stage: 'demo_done', source: 'event', specialty: '',
      tags: ['vip'], city: '', suburb: 'Sandton', owner: 'user-123',
      overdue: false, sort: 'updated', view: 'map',
    };
    const decoded = decodeFilters(paramsToRecord(encodeFilters(f)));
    expect(decoded).toEqual(f);
  });

  it('an empty/default filter state encodes to an empty querystring', () => {
    const params = encodeFilters(DEFAULT_FILTERS);
    expect(params.toString()).toBe('');
  });

  it('decoding garbage input never throws and falls back to defaults', () => {
    expect(() => decodeFilters({ view: 'nonsense', overdue: 'yes-please', sort: undefined })).not.toThrow();
    const decoded = decodeFilters({ view: 'nonsense' as string });
    expect(decoded.view).toBe('list');
  });

  it('decoding an array-valued param (Next.js searchParams shape) takes the first value', () => {
    const decoded = decodeFilters({ stage: ['contacted', 'lost'] });
    expect(decoded.stage).toBe('contacted');
  });
});

describe('4. adversarial — a saved view referencing a deleted tag degrades gracefully', () => {
  const LEADS: FilterableLead[] = [
    { id: '1', practice_name: 'Acme Dental', stage: 'new', source: 'other', specialty: null, city: null, suburb: null, owner_user_id: 'u1', tags: ['hot'], archived_at: null, next_follow_up_at: null },
  ];

  it('a tag filter matching no lead returns an empty result, not a throw', () => {
    const filters = { ...DEFAULT_FILTERS, tags: ['this-tag-was-deleted'] };
    expect(() => applyLeadFilters(LEADS, filters, null)).not.toThrow();
    expect(applyLeadFilters(LEADS, filters, null)).toEqual([]);
  });
});

describe('5. result counts match the underlying filter, and exclude archived leads', () => {
  const LEADS: FilterableLead[] = [
    { id: '1', practice_name: 'A Dental',  stage: 'new',       source: 'other', specialty: null, city: 'CT', suburb: null, owner_user_id: 'u1', tags: [], archived_at: null, next_follow_up_at: null },
    { id: '2', practice_name: 'B Dental',  stage: 'contacted', source: 'other', specialty: null, city: 'CT', suburb: null, owner_user_id: 'u2', tags: [], archived_at: null, next_follow_up_at: null },
    { id: '3', practice_name: 'C Dental',  stage: 'new',       source: 'other', specialty: null, city: 'CT', suburb: null, owner_user_id: 'u1', tags: [], archived_at: '2026-01-01T00:00:00Z', next_follow_up_at: null },
  ];

  it('excludes archived leads even when they would otherwise match', () => {
    const result = applyLeadFilters(LEADS, { ...DEFAULT_FILTERS, stage: 'new' }, null);
    expect(result.map(r => r.id)).toEqual(['1']); // lead 3 is archived AND matches stage='new', but is excluded
  });

  it('owner=me scopes to the current user', () => {
    const result = applyLeadFilters(LEADS, { ...DEFAULT_FILTERS, owner: 'me' }, 'u1');
    expect(result.map(r => r.id).sort()).toEqual(['1']);
  });
});
