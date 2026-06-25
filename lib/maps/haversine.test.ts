import { describe, it, expect } from 'vitest';
import { haversineKm, formatDistanceKm } from './haversine';

// ─── Tests — Haversine great-circle distance ────────────────────────────
//
// Well-known SA city-pair distances anchor these tests so a regression
// (wrong earth radius, missing radians conversion, wrong formula) shows
// up as a wildly off km.

const SANDTON = { latitude: -26.107567, longitude:  28.056456 };
const CAPETOWN = { latitude: -33.918861, longitude: 18.4233 };
const DURBAN   = { latitude: -29.858680, longitude: 31.021840 };

describe('haversineKm — known SA city pairs', () => {
  it('Sandton ↔ Cape Town ≈ 1265 km (great-circle)', () => {
    const km = haversineKm(SANDTON, CAPETOWN);
    expect(km).toBeGreaterThan(1240);
    expect(km).toBeLessThan(1290);
  });

  it('Sandton ↔ Durban ≈ 500 km', () => {
    const km = haversineKm(SANDTON, DURBAN);
    expect(km).toBeGreaterThan(490);
    expect(km).toBeLessThan(520);
  });

  it('Cape Town ↔ Durban ≈ 1280 km', () => {
    const km = haversineKm(CAPETOWN, DURBAN);
    expect(km).toBeGreaterThan(1260);
    expect(km).toBeLessThan(1310);
  });
});

describe('haversineKm — properties', () => {
  it('identity: distance from a point to itself is 0', () => {
    expect(haversineKm(SANDTON, SANDTON)).toBeCloseTo(0, 5);
  });

  it('symmetric: haversineKm(a, b) === haversineKm(b, a)', () => {
    const ab = haversineKm(SANDTON, CAPETOWN);
    const ba = haversineKm(CAPETOWN, SANDTON);
    expect(ab).toBeCloseTo(ba, 6);
  });

  it('a small in-suburb distance (e.g. 2 km) computes reasonably', () => {
    // ~0.018 degrees ≈ 2 km at SA latitudes.
    const a = { latitude: -26.107567, longitude: 28.056456 };
    const b = { latitude: -26.107567 + 0.018, longitude: 28.056456 };
    const km = haversineKm(a, b);
    expect(km).toBeGreaterThan(1.8);
    expect(km).toBeLessThan(2.2);
  });
});

describe('formatDistanceKm', () => {
  it('shows one decimal below 10 km', () => {
    expect(formatDistanceKm(3.247)).toBe('3.2 km away');
    expect(formatDistanceKm(9.9)).toBe('9.9 km away');
  });

  it('shows whole km at 10+ km', () => {
    expect(formatDistanceKm(10)).toBe('10 km away');
    expect(formatDistanceKm(47.3)).toBe('47 km away');
    expect(formatDistanceKm(1234)).toBe('1234 km away');
  });

  it('returns empty string for invalid input (NaN, negative, non-finite)', () => {
    expect(formatDistanceKm(NaN)).toBe('');
    expect(formatDistanceKm(-5)).toBe('');
    expect(formatDistanceKm(Infinity)).toBe('');
  });

  it('renders 0 km as "0.0 km away" (not empty)', () => {
    expect(formatDistanceKm(0)).toBe('0.0 km away');
  });
});
