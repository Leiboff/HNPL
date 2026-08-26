import { describe, it, expect } from 'vitest';
import { parseNeighbourhoodLocation } from './parseLocation';

describe('parseNeighbourhoodLocation', () => {
  it('splits a 3-part "suburb, city, province" string', () => {
    expect(parseNeighbourhoodLocation('Springs , Springs, Gauteng')).toEqual({
      suburb: 'Springs', city: 'Springs', province: 'Gauteng',
    });
  });

  it('joins extra trailing parts into province', () => {
    expect(parseNeighbourhoodLocation('Bedfordview, Germiston, Gauteng, South Africa')).toEqual({
      suburb: 'Bedfordview', city: 'Germiston', province: 'Gauteng, South Africa',
    });
  });

  it('treats a 2-part string as city + province', () => {
    expect(parseNeighbourhoodLocation('Pretoria, Gauteng')).toEqual({
      suburb: null, city: 'Pretoria', province: 'Gauteng',
    });
  });

  it('treats a single part as province only', () => {
    expect(parseNeighbourhoodLocation('Gauteng')).toEqual({
      suburb: null, city: null, province: 'Gauteng',
    });
  });

  it('drops empty comma-separated segments, then re-buckets by count', () => {
    // The empty middle segment is dropped before bucketing, so this
    // resolves as a 2-part "city, province" string, not 3-part.
    expect(parseNeighbourhoodLocation('Springs, , Gauteng')).toEqual({
      suburb: null, city: 'Springs', province: 'Gauteng',
    });
  });

  it('returns all-null for an empty string', () => {
    expect(parseNeighbourhoodLocation('')).toEqual({ suburb: null, city: null, province: null });
  });
});
