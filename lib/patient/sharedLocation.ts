'use client';

// ─── Shared patient location — sessionStorage-backed ────────────────────
//
// One source of truth for the patient-side "where am I" coordinate,
// used by every discovery surface that ranks nearest-first:
//   • /patient/explore (Landing + Results)
//   • /patient/practitioner/[memberId] (detail — distances per location)
//
// Persistence: sessionStorage under `hnpl:patient-location:v1`.
//   • Survives navigation inside one tab (explore → practitioner → back).
//   • Cleared when the tab closes — matches the existing POPIA copy
//     ("your location is not saved"). Not persisted long-term, no DB
//     column, no cookie sent to the server.
//   • jsdom-safe: sessionStorage exists in jsdom; guarded for SSR by
//     the `typeof window` check.
//
// Shape kept minimal:
//   • latitude / longitude — what the ordering pipeline consumes.
//   • label — the human-readable "Suburb, City" we render on the
//     LocationRow. May be null when a GPS grant hasn't finished
//     reverse-geocoding yet (the row shows "Locating…" then).
//   • source — 'gps' | 'suburb' so the row / debug UIs can tell
//     which path the coord came from without re-guessing.
//
// This module is intentionally NOT a hook — pure read/write helpers
// so callers can hydrate their own useState from storage in whatever
// shape they need. The `useSharedLocation` hook below is a thin
// wrapper for the common case.

import { useCallback, useEffect, useState } from 'react';

export type SharedLocation = {
  latitude:  number;
  longitude: number;
  label:     string | null;
  source:    'gps' | 'suburb';
};

const STORAGE_KEY = 'hnpl:patient-location:v1';

/** Read the stored location. Returns null on SSR / missing / malformed. */
export function readStoredLocation(): SharedLocation | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Partial<SharedLocation>;
    if (
      typeof p.latitude !== 'number'
      || typeof p.longitude !== 'number'
      || !Number.isFinite(p.latitude)
      || !Number.isFinite(p.longitude)
    ) return null;
    if (p.source !== 'gps' && p.source !== 'suburb') return null;
    const label = typeof p.label === 'string' && p.label.length > 0 ? p.label : null;
    return { latitude: p.latitude, longitude: p.longitude, label, source: p.source };
  } catch {
    return null;
  }
}

/** Persist the location. Silently no-ops on SSR / storage disabled. */
export function writeStoredLocation(loc: SharedLocation): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(loc));
  } catch {
    // Storage disabled (quota / private mode) — the runtime state
    // still updates via React state; only the persistence step is
    // lost. Not worth surfacing to the user.
  }
}

/** Remove the stored location entirely. */
export function clearStoredLocation(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* see writeStoredLocation */ }
}

// ─── Hook wrapper ──────────────────────────────────────────────────────
//
// Hydrates from sessionStorage once on mount and exposes a setter that
// persists on every change. Callers that also want to auto-request GPS
// on first visit (ExploreView / DetailView) drive that themselves —
// this hook doesn't fire geolocation because the sheet needs its own
// request-scoped attempts too, and centralising it here would collide.

export function useSharedLocation(): {
  location:    SharedLocation | null;
  setLocation: (loc: SharedLocation) => void;
  clear:       () => void;
  /** True once the initial sessionStorage read has completed. */
  hydrated:    boolean;
} {
  const [location, setLocationState] = useState<SharedLocation | null>(null);
  const [hydrated, setHydrated]      = useState(false);

  useEffect(() => {
    // Hydrate inside an async IIFE so the initial setState lives in
    // a callback body rather than the synchronous effect body —
    // matches the codebase pattern (see PushSoftAsk's cancelled-
    // guarded async IIFE) and satisfies react-hooks/set-state-in-effect.
    let cancelled = false;
    void (async () => {
      const stored = readStoredLocation();
      if (cancelled) return;
      if (stored) setLocationState(stored);
      setHydrated(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const setLocation = useCallback((loc: SharedLocation) => {
    writeStoredLocation(loc);
    setLocationState(loc);
  }, []);

  const clear = useCallback(() => {
    clearStoredLocation();
    setLocationState(null);
  }, []);

  return { location, setLocation, clear, hydrated };
}
