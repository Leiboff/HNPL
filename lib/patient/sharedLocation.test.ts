import { describe, it, expect, beforeEach } from 'vitest';

import {
  readStoredLocation,
  writeStoredLocation,
  clearStoredLocation,
  type SharedLocation,
} from './sharedLocation';

// ─── Tests — sharedLocation storage helpers ────────────────────────────
//
// Pure storage layer under `hnpl:patient-location:v1`. Every explore
// / practitioner surface hydrates from this on mount so a location
// chosen once is applied everywhere.

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('readStoredLocation', () => {
  it('returns null when nothing is stored', () => {
    expect(readStoredLocation()).toBeNull();
  });

  it('round-trips a valid write', () => {
    const loc: SharedLocation = { latitude: -26.10, longitude: 28.05, label: 'Sandton, JHB', source: 'suburb' };
    writeStoredLocation(loc);
    expect(readStoredLocation()).toEqual(loc);
  });

  it('null-labels round-trip correctly (GPS coords before reverse-geocode)', () => {
    const loc: SharedLocation = { latitude: -26.10, longitude: 28.05, label: null, source: 'gps' };
    writeStoredLocation(loc);
    expect(readStoredLocation()).toEqual(loc);
  });

  it('returns null on malformed JSON', () => {
    window.sessionStorage.setItem('hnpl:patient-location:v1', 'not-json');
    expect(readStoredLocation()).toBeNull();
  });

  it('returns null on missing lat/lng', () => {
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({ label: 'x', source: 'suburb' }));
    expect(readStoredLocation()).toBeNull();
  });

  it('returns null on invalid source', () => {
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: -26, longitude: 28, label: 'x', source: 'other',
    }));
    expect(readStoredLocation()).toBeNull();
  });

  it('returns null on non-finite coords', () => {
    window.sessionStorage.setItem('hnpl:patient-location:v1', JSON.stringify({
      latitude: NaN, longitude: 28, label: 'x', source: 'gps',
    }));
    expect(readStoredLocation()).toBeNull();
  });
});

describe('clearStoredLocation', () => {
  it('removes the entry', () => {
    writeStoredLocation({ latitude: -26, longitude: 28, label: 'x', source: 'suburb' });
    expect(readStoredLocation()).not.toBeNull();
    clearStoredLocation();
    expect(readStoredLocation()).toBeNull();
  });
});

describe('POPIA posture', () => {
  it('is scoped to sessionStorage (not localStorage) so it clears on tab close', () => {
    writeStoredLocation({ latitude: -26, longitude: 28, label: 'x', source: 'suburb' });
    // sessionStorage has it; localStorage does not.
    expect(window.sessionStorage.getItem('hnpl:patient-location:v1')).not.toBeNull();
    expect(window.localStorage.getItem('hnpl:patient-location:v1')).toBeNull();
  });
});
