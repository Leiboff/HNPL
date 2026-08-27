import { describe, it, expect } from 'vitest';
import {
  normaliseAddress, normaliseUnit, normaliseLandline, buildAddressMatchKey,
  matchAddress, rankAddressMatches, orderedLeadPair, excludeDismissed,
  type LeadForAddressMatch,
} from './addressMatch';

function lead(overrides: Partial<LeadForAddressMatch> & { id: string; practice_name: string }): LeadForAddressMatch {
  return {
    building_name: null, unit: null, landline: null,
    street_address: null, formatted_address: null, suburb: null,
    latitude: null, longitude: null,
    ...overrides,
  };
}

describe('normaliseAddress', () => {
  it('lowercases and strips punctuation', () => {
    expect(normaliseAddress('123 Main St.')).toBe('123 main street');
  });

  it('expands common street abbreviations', () => {
    expect(normaliseAddress('5 Oak Rd')).toBe('5 oak road');
    expect(normaliseAddress('Cnr Smith Dr & Jones Ave')).toBe('corner smith drive jones avenue');
  });

  it('strips noise words so "X Hospital" matches "X"', () => {
    expect(normaliseAddress('Life Fourways Hospital')).toBe('life fourways');
    expect(normaliseAddress('Life Fourways')).toBe('life fourways');
  });

  it('strips "Medical Centre"/"Medical Center" as noise', () => {
    expect(normaliseAddress('Sandton Medical Centre')).toBe('sandton');
    expect(normaliseAddress('Sandton Medical Center')).toBe('sandton');
  });

  it('returns empty string for null/undefined/blank', () => {
    expect(normaliseAddress(null)).toBe('');
    expect(normaliseAddress(undefined)).toBe('');
    expect(normaliseAddress('   ')).toBe('');
  });
});

describe('normaliseUnit — all five input forms collapse to the same value', () => {
  const forms = ['Suite 204', 'Ste 204', 'Unit 204', '#204', '204'];
  it.each(forms)('%s -> "204"', (input) => {
    expect(normaliseUnit(input)).toBe('204');
  });

  it('returns null for blank input', () => {
    expect(normaliseUnit(null)).toBeNull();
    expect(normaliseUnit('')).toBeNull();
    expect(normaliseUnit('   ')).toBeNull();
  });
});

describe('normaliseLandline', () => {
  it('folds 011-prefixed and +2711-prefixed forms to the same value', () => {
    const a = normaliseLandline('011 234 5678');
    const b = normaliseLandline('0112345678');
    const c = normaliseLandline('27112345678');
    const d = normaliseLandline('+27 11 234 5678');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(c).toBe(d);
    expect(a).toBe('27112345678');
  });

  it('returns null for blank input', () => {
    expect(normaliseLandline(null)).toBeNull();
    expect(normaliseLandline('')).toBeNull();
  });
});

describe('buildAddressMatchKey', () => {
  it('combines normalised street + suburb', () => {
    expect(buildAddressMatchKey({ street_address: '5 Oak Rd', suburb: 'Sandton', formatted_address: null }))
      .toBe('5 oak road|sandton');
  });

  it('falls back to formatted_address when street_address is missing', () => {
    expect(buildAddressMatchKey({ street_address: null, formatted_address: '5 Oak Rd, Sandton', suburb: null }))
      .toBe('5 oak road sandton');
  });
});

describe('matchAddress — signals and confidence', () => {
  it('same building + same unit -> HIGH, duplicate_practice', () => {
    const a = lead({ id: 'a', practice_name: 'A', building_name: 'Life Fourways', unit: 'Suite 204' });
    const b = lead({ id: 'b', practice_name: 'B', building_name: 'Life Fourways', unit: '204' });
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('high');
    expect(r?.kind).toBe('duplicate_practice');
  });

  it('same landline -> HIGH, duplicate_practice, regardless of building', () => {
    const a = lead({ id: 'a', practice_name: 'A', landline: '011 234 5678' });
    const b = lead({ id: 'b', practice_name: 'B', landline: '0112345678' });
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('high');
    expect(r?.kind).toBe('duplicate_practice');
    expect(r?.reason).toMatch(/landline/i);
  });

  it('same street address, no building on either side -> MEDIUM, duplicate_practice', () => {
    const a = lead({ id: 'a', practice_name: 'A', street_address: '5 Oak Rd', suburb: 'Sandton' });
    const b = lead({ id: 'b', practice_name: 'B', street_address: '5 Oak Road', suburb: 'Sandton' });
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('medium');
    expect(r?.kind).toBe('duplicate_practice');
  });

  it('same building, one side missing a unit -> MEDIUM ("verify unit"), duplicate_practice', () => {
    const a = lead({ id: 'a', practice_name: 'A', building_name: 'Netcare Sunninghill', unit: '204' });
    const b = lead({ id: 'b', practice_name: 'B', building_name: 'Netcare Sunninghill', unit: null });
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('medium');
    expect(r?.kind).toBe('duplicate_practice');
    expect(r?.reason).toMatch(/verify unit/i);
  });

  it('CRITICAL: same building, DIFFERENT unit -> LOW, prospecting_hint — never a duplicate', () => {
    const a = lead({ id: 'a', practice_name: 'Dr A', building_name: 'Morningside Mediclinic', unit: '101' });
    const b = lead({ id: 'b', practice_name: 'Dr B', building_name: 'Morningside Mediclinic', unit: '305' });
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('low');
    expect(r?.kind).toBe('prospecting_hint');
    expect(r?.kind).not.toBe('duplicate_practice');
  });

  it('within 50m by lat/lng, nothing else in common -> LOW, prospecting_hint ("nearby only")', () => {
    const a = lead({ id: 'a', practice_name: 'A', latitude: -26.10000, longitude: 28.05000 });
    const b = lead({ id: 'b', practice_name: 'B', latitude: -26.10030, longitude: 28.05000 }); // ~33m
    const r = matchAddress(a, b);
    expect(r?.confidence).toBe('low');
    expect(r?.kind).toBe('prospecting_hint');
  });

  it('beyond 50m with nothing else in common -> no match', () => {
    const a = lead({ id: 'a', practice_name: 'A', latitude: -26.1000, longitude: 28.0500 });
    const b = lead({ id: 'b', practice_name: 'B', latitude: -26.2000, longitude: 28.0500 }); // ~11km
    expect(matchAddress(a, b)).toBeNull();
  });

  it('no signal at all -> null', () => {
    const a = lead({ id: 'a', practice_name: 'A' });
    const b = lead({ id: 'b', practice_name: 'B' });
    expect(matchAddress(a, b)).toBeNull();
  });

  it('a building match beats a weaker street-only match (high/medium/low priority is inherent to the branch order)', () => {
    const a = lead({ id: 'a', practice_name: 'A', building_name: 'Life Fourways', unit: '1', street_address: '1 Main Rd' });
    const b = lead({ id: 'b', practice_name: 'B', building_name: 'Life Fourways', unit: '1', street_address: '1 Main Rd' });
    const r = matchAddress(a, b);
    expect(r?.reason).toMatch(/building/i);
  });
});

describe('rankAddressMatches', () => {
  const me = lead({ id: 'me', practice_name: 'Me', landline: '0112345678', latitude: -26.10, longitude: 28.05 });

  it('ranks high before medium before low and caps at 3', () => {
    const candidates: LeadForAddressMatch[] = [
      lead({ id: 'low1',  practice_name: 'Low1',  latitude: -26.10003, longitude: 28.05000 }),
      lead({ id: 'high1', practice_name: 'High1', landline: '011 234 5678' }),
      lead({ id: 'med1',  practice_name: 'Med1',  street_address: '9 Nowhere', suburb: null }),
      lead({ id: 'low2',  practice_name: 'Low2',  latitude: -26.10004, longitude: 28.05000 }),
    ];
    const ranked = rankAddressMatches(me, candidates);
    expect(ranked.length).toBeLessThanOrEqual(3);
    expect(ranked[0].confidence).toBe('high');
    expect(ranked[0].otherLeadId).toBe('high1');
  });

  it('excludes the lead itself from its own candidate list', () => {
    const ranked = rankAddressMatches(me, [me]);
    expect(ranked).toHaveLength(0);
  });
});

describe('orderedLeadPair', () => {
  it('always returns the lower UUID first, regardless of call order', () => {
    expect(orderedLeadPair('b-id', 'a-id')).toEqual(['a-id', 'b-id']);
    expect(orderedLeadPair('a-id', 'b-id')).toEqual(['a-id', 'b-id']);
  });
});

describe('excludeDismissed', () => {
  it('never re-suggests a dismissed pair', () => {
    const suggestions = [{ confidence: 'high' as const, kind: 'duplicate_practice' as const, reason: 'x', otherLeadId: 'b' }];
    const dismissed = [{ lead_a_id: 'a', lead_b_id: 'b', kind: 'duplicate_practice' as const }];
    expect(excludeDismissed('a', suggestions, dismissed)).toHaveLength(0);
  });

  it('is order-independent — dismissing from either lead filters the same pair', () => {
    const suggestions = [{ confidence: 'high' as const, kind: 'duplicate_practice' as const, reason: 'x', otherLeadId: 'a' }];
    const dismissed = [{ lead_a_id: 'a', lead_b_id: 'b', kind: 'duplicate_practice' as const }];
    expect(excludeDismissed('b', suggestions, dismissed)).toHaveLength(0);
  });

  it('a dismissal of one kind does not suppress a different kind for the same pair', () => {
    const suggestions = [{ confidence: 'low' as const, kind: 'prospecting_hint' as const, reason: 'x', otherLeadId: 'b' }];
    const dismissed = [{ lead_a_id: 'a', lead_b_id: 'b', kind: 'duplicate_practice' as const }];
    expect(excludeDismissed('a', suggestions, dismissed)).toHaveLength(1);
  });
});
