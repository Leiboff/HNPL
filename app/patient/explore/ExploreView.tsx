'use client';

import { useState, useMemo, useEffect } from 'react';
import { haversineKm, formatDistanceKm, type LatLng } from '@/lib/maps/haversine';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import type { PracticeCard } from './page';

// ─── Explore practices — geolocation + suburb fallback + Haversine ─────
//
// Flow:
//   1. On mount, ask the browser for geolocation. Don't BLOCK on it —
//      the page renders with all practices unsorted while the user
//      decides whether to grant.
//   2. Granted → set userLocation; the memo re-sorts by Haversine
//      distance and hides practices beyond the selected radius.
//   3. Denied / unavailable / dismissed → leave userLocation null; the
//      page shows all practices alphabetically AND a "search by suburb"
//      Places (New) Autocomplete input (locality-biased). On selection,
//      the place's coords drive the same Haversine sort. No server-side
//      Places call — the picker is client-side; the key is the
//      domain-restricted Places key.
//
// POPIA: userLocation is component state only — never written to the
// DB. Lives for the session, dies when the page unmounts.
//
// Practices without coordinates (latitude OR longitude NULL) are landed
// in an "Other practices" bucket below the distance-filtered list when
// a userLocation is set — they're findable, just not distance-rankable.
// When no userLocation is set, they merge into the alphabetical list.

type PracticeWithDistance = PracticeCard & { distanceKm: number | null };

const RADIUS_PRESETS = [10, 25, 50] as const;
const DEFAULT_RADIUS = 25;

type GeoState =
  | { kind: 'idle' }                                         // pre-prompt
  | { kind: 'requesting' }
  | { kind: 'granted'; location: LatLng; source: 'gps' | 'suburb'; label?: string }
  | { kind: 'denied' };

type Props = {
  practices: PracticeCard[];
};

export default function ExploreView({ practices }: Props) {
  const [search,    setSearch]    = useState('');
  const [specialty, setSpecialty] = useState<string | null>(null);
  const [radiusKm,  setRadiusKm]  = useState<number>(DEFAULT_RADIUS);
  // Lazy initializer: decide once at first render whether the browser
  // can even prompt for location. Avoids a synchronous setState inside
  // useEffect (which the react-hooks/set-state-in-effect lint rule
  // discourages — re-render-storm risk). The effect below only sets
  // state from inside the (async) Geolocation callbacks.
  const [geo, setGeo] = useState<GeoState>(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { kind: 'denied' };
    }
    return { kind: 'requesting' };
  });

  // suburb-search state: just the picked label. Coords arrive via the
  // PlacesAutocomplete onSelect and feed straight into setGeo — no
  // server-side geocode action needed.

  // Fire the geolocation prompt once on mount, but only if the lazy
  // initializer above already put us in 'requesting' (i.e. the API is
  // available). The effect itself contains no synchronous setState;
  // the setGeo calls are inside the async Geolocation callbacks.
  useEffect(() => {
    if (geo.kind !== 'requesting') return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({
          kind:     'granted',
          location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
          source:   'gps',
        });
      },
      () => { setGeo({ kind: 'denied' }); },
      // Cheap settings: don't insist on high accuracy (drains battery)
      // and don't sit on a hanging request for ages.
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );
    // Run once on mount — geo dep would re-fire on each transition,
    // which would re-trigger the prompt every time the user changes
    // their mind. The 'requesting' check above gates the body so the
    // empty-deps array is the correct shape.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picker-driven suburb selection. Coords come from the place's
  // location field; no geocode action needed.
  function onSuburbPicked(latitude: number, longitude: number, label: string) {
    setGeo({
      kind:     'granted',
      location: { latitude, longitude },
      source:   'suburb',
      label,
    });
  }

  const specialties = useMemo(() => {
    const seen = new Set<string>();
    practices.forEach((p) => { if (p.specialty) seen.add(p.specialty); });
    return Array.from(seen).sort();
  }, [practices]);

  // Compute distance once per (practices, geo) pair and reuse across
  // search/specialty filter re-renders.
  const withDistance = useMemo<PracticeWithDistance[]>(() => {
    if (geo.kind !== 'granted') {
      return practices.map((p) => ({ ...p, distanceKm: null }));
    }
    const me = geo.location;
    return practices.map((p) => {
      if (p.latitude == null || p.longitude == null) {
        return { ...p, distanceKm: null };
      }
      const km = haversineKm(me, { latitude: p.latitude, longitude: p.longitude });
      return { ...p, distanceKm: km };
    });
  }, [practices, geo]);

  // Search + specialty filter on top of the distance-decorated list.
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return withDistance.filter((p) => {
      const matchesSearch    = !q || p.name.toLowerCase().includes(q);
      const matchesSpecialty = !specialty || p.specialty === specialty;
      return matchesSearch && matchesSpecialty;
    });
  }, [withDistance, search, specialty]);

  // Split into near / far / no-coord buckets ONLY when a userLocation
  // is set. Otherwise everything is alphabetical and the buckets don't
  // apply.
  const { nearList, otherList } = useMemo(() => {
    if (geo.kind !== 'granted') {
      return { nearList: filtered, otherList: [] as PracticeWithDistance[] };
    }
    const within: PracticeWithDistance[] = [];
    const without: PracticeWithDistance[] = [];
    for (const p of filtered) {
      if (p.distanceKm == null) without.push(p);
      else if (p.distanceKm <= radiusKm) within.push(p);
      // beyond-radius rows are hidden by default (clean "near me" list).
    }
    within.sort((a, b) => (a.distanceKm! - b.distanceKm!));
    without.sort((a, b) => a.name.localeCompare(b.name));
    return { nearList: within, otherList: without };
  }, [filtered, geo, radiusKm]);

  const chipStyle = (active: boolean) =>
    active
      ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)', color: '#fff' }
      : { background: 'rgba(19,41,75,.06)', color: '#13294B' };

  return (
    <div className="space-y-5">
      {/* ── Location card — sets the basis for nearest-first sort ───── */}
      <LocationCard geo={geo} onSuburbPicked={onSuburbPicked} />

      {/* ── Radius preset — only shown when we have a location ────── */}
      {geo.kind === 'granted' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            Radius
          </span>
          {RADIUS_PRESETS.map((km) => (
            <button
              key={km}
              type="button"
              onClick={() => setRadiusKm(km)}
              className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
              style={chipStyle(radiusKm === km)}
            >
              {km} km
            </button>
          ))}
        </div>
      )}

      {/* Search */}
      <input
        type="search"
        placeholder="Search practices…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]"
      />

      {/* Specialty chips */}
      {specialties.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setSpecialty(null)}
            className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
            style={chipStyle(specialty === null)}
          >
            All
          </button>
          {specialties.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpecialty(specialty === s ? null : s)}
              className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
              style={chipStyle(specialty === s)}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* ── Results — within radius first, then "other practices" ── */}
      {nearList.length === 0 && otherList.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practices found</p>
          <p className="mt-1 text-sm text-gray-400">
            {geo.kind === 'granted' && nearList.length === 0
              ? 'Try a wider radius or a different search.'
              : 'Try a different search or specialty.'}
          </p>
        </div>
      ) : (
        <>
          {nearList.length > 0 && (
            <div className="space-y-3">
              {nearList.map((p) => (
                <PracticeRow key={p.id} practice={p} />
              ))}
            </div>
          )}

          {/* Other practices — coords missing OR (in future) beyond radius
              we chose to surface. Currently only no-coord rows land here
              so the patient can still find them; beyond-radius rows are
              hidden by design (the radius preset IS the cutoff). */}
          {otherList.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 pt-2">
                Other practices
              </p>
              {otherList.map((p) => (
                <PracticeRow key={p.id} practice={p} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Location card — explains the prompt + offers the suburb fallback ──

function LocationCard({
  geo,
  onSuburbPicked,
}: {
  geo:             GeoState;
  onSuburbPicked:  (lat: number, lng: number, label: string) => void;
}) {
  if (geo.kind === 'idle' || geo.kind === 'requesting') {
    return (
      <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
        <p className="text-sm font-medium" style={{ color: '#13294B' }}>
          {geo.kind === 'requesting' ? 'Checking your location…' : 'Allow location to see practices near you'}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Your location is used only to sort this list — never saved.
        </p>
      </div>
    );
  }

  if (geo.kind === 'granted') {
    const sourceLine = geo.source === 'suburb' && geo.label
      ? `Near ${geo.label}`
      : 'Near your current location';
    return (
      <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
        <p className="text-sm font-medium" style={{ color: '#13294B' }}>
          {sourceLine}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          Sorted nearest-first within the selected radius. Your location is not saved.
        </p>
      </div>
    );
  }

  // denied → suburb fallback via Google Places (New) Autocomplete.
  // Locality-biased so "Rosebank" surfaces the area, not 40 individual
  // street addresses. Coords come from Place Details on selection.
  return (
    <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
      <p className="text-sm font-medium" style={{ color: '#13294B' }}>
        Search by suburb
      </p>
      <p className="mt-1 text-xs text-gray-500 mb-3">
        Or enable location in your browser to see practices near you.
      </p>
      <PlacesAutocomplete
        variant="locality"
        placeholder="e.g. Rosebank"
        onSelect={(place) => onSuburbPicked(place.latitude, place.longitude, place.formattedAddress)}
      />
    </div>
  );
}

// ─── Per-practice card ────────────────────────────────────────────────

function PracticeRow({ practice }: { practice: PracticeWithDistance }) {
  const locationLine = [practice.suburb, practice.city].filter(Boolean).join(', ');
  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{practice.name}</p>
          {practice.specialty && (
            <p className="text-xs text-gray-400 mt-0.5">{practice.specialty}</p>
          )}
          {locationLine && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{locationLine}</p>
          )}
          {practice.distanceKm != null && (
            <p className="text-xs font-medium mt-1" style={{ color: '#15A89E' }}>
              {formatDistanceKm(practice.distanceKm)}
            </p>
          )}
        </div>
        {practice.phone && (
          <a
            href={`tel:${practice.phone}`}
            className="shrink-0 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
          >
            Call
          </a>
        )}
      </div>
      {practice.email && (
        <p className="mt-2 text-xs text-gray-400">{practice.email}</p>
      )}
    </div>
  );
}
