import { describe, it, expect } from 'vitest';
import {
  buildGoogleMapsDirUrl,
  nearestNeighbourOrder,
  haversineKm,
  pinColourForStage,
  STAGE_PIN_COLORS,
} from './mapPlanner';

describe('haversineKm', () => {
  it('returns ~0 for identical points', () => {
    const d = haversineKm({ lat: -26, lng: 28 }, { lat: -26, lng: 28 });
    expect(d).toBeLessThan(0.001);
  });

  it('roughly matches known distances (Johannesburg → Cape Town ~1265 km)', () => {
    const d = haversineKm({ lat: -26.2041, lng: 28.0473 }, { lat: -33.9249, lng: 18.4241 });
    // Loose bound — Haversine is a spherical approximation.
    expect(d).toBeGreaterThan(1200);
    expect(d).toBeLessThan(1400);
  });
});

describe('nearestNeighbourOrder', () => {
  it('orders stops from closest to farthest (single-hop chain)', () => {
    const origin = { lat: 0, lng: 0 };
    const stops = [
      { id: 'C', lat: 0, lng: 3 },
      { id: 'A', lat: 0, lng: 1 },
      { id: 'B', lat: 0, lng: 2 },
    ];
    const ordered = nearestNeighbourOrder(origin, stops);
    expect(ordered.map(s => s.id)).toEqual(['A', 'B', 'C']);
  });

  it('produces the nearest-neighbour sequence (2D grid)', () => {
    const origin = { lat: 0, lng: 0 };
    const stops = [
      { id: 'far',    lat: 0, lng: 10 },
      { id: 'close',  lat: 0, lng: 1  },
      { id: 'medium', lat: 0, lng: 4  },
    ];
    const ordered = nearestNeighbourOrder(origin, stops);
    expect(ordered[0].id).toBe('close');
    expect(ordered[1].id).toBe('medium');
    expect(ordered[2].id).toBe('far');
  });

  it('returns empty array on empty input', () => {
    expect(nearestNeighbourOrder({ lat: 0, lng: 0 }, [])).toEqual([]);
  });
});

describe('buildGoogleMapsDirUrl', () => {
  it('builds /dir/ URL with lat,lng segments in order (no start)', () => {
    const url = buildGoogleMapsDirUrl(null, [
      { lat: -26.10, lng: 28.05 },
      { lat: -26.20, lng: 28.10 },
    ]);
    expect(url.startsWith('https://www.google.com/maps/dir/')).toBe(true);
    // Segments are URL-encoded; the comma between lat,lng becomes %2C.
    expect(url).toContain('-26.1%2C28.05');
    expect(url).toContain('-26.2%2C28.1');
    // Order preserved.
    const idxFirst  = url.indexOf('-26.1%2C28.05');
    const idxSecond = url.indexOf('-26.2%2C28.1');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(idxFirst);
  });

  it('includes the start as the first segment when provided', () => {
    const url = buildGoogleMapsDirUrl(
      { lat: -25.0, lng: 27.0 },
      [{ lat: -26.0, lng: 28.0 }],
    );
    // Start segment appears BEFORE the stop segment.
    const iStart = url.indexOf('-25%2C27');
    const iStop  = url.indexOf('-26%2C28');
    expect(iStart).toBeGreaterThan(-1);
    expect(iStop).toBeGreaterThan(iStart);
  });
});

describe('pinColourForStage', () => {
  it('returns a distinct colour per known stage', () => {
    const stages = ['new','contacted','meeting_scheduled','demo_done','agreement_sent','signed','onboarded','lost'];
    const colours = new Set(stages.map(pinColourForStage));
    expect(colours.size).toBe(stages.length);
  });

  it('falls back to the "new" colour on an unknown stage', () => {
    expect(pinColourForStage('bogus-stage')).toBe(STAGE_PIN_COLORS.new);
  });
});
