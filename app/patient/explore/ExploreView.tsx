'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { formatDistanceKm, type LatLng } from '@/lib/maps/haversine';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import {
  decorateWithDistance,
  groupIntoCards,
  filterCards,
  bucketPractitionerCards,
  specialtiesFromCards,
  type DirectoryRow,
  type PractitionerCard,
  type LocationOnCard,
} from '@/lib/practitioner/grouping';

// ─── Find a Practitioner — geolocation + suburb fallback + filters ─────
//
// Renders one card per PRACTITIONER (grouped by HPCSA, with a
// null-HPCSA fallback to member_id). A practitioner working at two
// approved practices appears as one card listing both locations,
// each with its own distance + Call button. Filters: proximity
// (radius preset) + specialty (chip row). Distance and bucketing
// rules live in lib/practitioner/grouping.ts so they're unit-tested
// in isolation.
//
// Same no-location contract as before: when we can't measure
// distance (no user location yet, denied, dismissed), EVERY
// practitioner appears unsorted. Never hide anyone for missing
// signal we don't have.
//
// Same geolocation re-prompt contract: every mount calls
// getCurrentPosition, the browser decides whether to actually prompt
// (hard-blocked → no prompt → suburb fallback is the escape hatch).

const RADIUS_PRESETS = [10, 25, 50] as const;
const DEFAULT_RADIUS = 25;

type GeoState =
  | { kind: 'idle' }                                         // pre-prompt
  | { kind: 'requesting' }
  | { kind: 'granted'; location: LatLng; source: 'gps' | 'suburb'; label?: string }
  | { kind: 'denied' };

type Props = {
  rows: DirectoryRow[];
};

export default function ExploreView({ rows }: Props) {
  const [search,    setSearch]    = useState('');
  const [specialty, setSpecialty] = useState<string | null>(null);
  const [radiusKm,  setRadiusKm]  = useState<number>(DEFAULT_RADIUS);

  const [geo, setGeo] = useState<GeoState>(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { kind: 'denied' };
    }
    return { kind: 'requesting' };
  });

  const [attemptId, setAttemptId] = useState(0);
  const livenessRef = useRef({ cancelled: false });

  const tryLocate = useCallback(() => {
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      setGeo({ kind: 'requesting' });
    }
    setAttemptId((n) => n + 1);
  }, []);

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }

    livenessRef.current = { cancelled: false };
    const liveness = livenessRef.current;

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (liveness.cancelled) return;
        setGeo({
          kind:     'granted',
          location: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
          source:   'gps',
        });
      },
      () => {
        if (liveness.cancelled) return;
        setGeo({ kind: 'denied' });
      },
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );

    return () => { liveness.cancelled = true; };
  }, [attemptId]);

  function onSuburbPicked(latitude: number, longitude: number, label: string) {
    setGeo({
      kind:     'granted',
      location: { latitude, longitude },
      source:   'suburb',
      label,
    });
  }

  // ── Pipeline: decorate with distance → group into cards → filter →
  //              bucket. Each step is pure (lib/practitioner/grouping).
  const userLocation: LatLng | null = geo.kind === 'granted' ? geo.location : null;

  const decorated = useMemo(
    () => decorateWithDistance(rows, userLocation),
    [rows, userLocation],
  );
  const cards     = useMemo(() => groupIntoCards(decorated), [decorated]);
  const specialties = useMemo(() => specialtiesFromCards(cards), [cards]);
  const filtered  = useMemo(() => filterCards(cards, search, specialty), [cards, search, specialty]);
  const { nearList, otherList } = useMemo(
    () => bucketPractitionerCards(filtered, geo.kind === 'granted', radiusKm),
    [filtered, geo, radiusKm],
  );

  const chipStyle = (active: boolean) =>
    active
      ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)', color: '#fff' }
      : { background: 'rgba(19,41,75,.06)', color: '#13294B' };

  return (
    <div className="space-y-5">
      {/* ── Location card — drives the nearest-first sort ───────────── */}
      <LocationCard geo={geo} onSuburbPicked={onSuburbPicked} onTryAgain={tryLocate} />

      {/* ── Filters ──────────────────────────────────────────────────
          Two controls — proximity (radius preset) and specialty.
          Proximity is only meaningful once we have a location;
          specialty is always offered. Search is a separate input
          below — keeps it discoverable without nesting too deep. */}
      <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-5 py-4 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">Filters</p>

        {geo.kind === 'granted' && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-600 w-20 shrink-0">Proximity</span>
            {RADIUS_PRESETS.map((km) => (
              <button
                key={km}
                type="button"
                onClick={() => setRadiusKm(km)}
                className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
                style={chipStyle(radiusKm === km)}
                data-testid={`filter-radius-${km}`}
              >
                {km} km
              </button>
            ))}
          </div>
        )}

        {specialties.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-gray-600 w-20 shrink-0">Specialty</span>
            <button
              type="button"
              onClick={() => setSpecialty(null)}
              className="rounded-full px-3.5 py-1.5 text-xs font-semibold transition-all"
              style={chipStyle(specialty === null)}
              data-testid="filter-specialty-all"
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
                data-testid={`filter-specialty-${s}`}
              >
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Search by name */}
      <input
        type="search"
        placeholder="Search practitioners…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="w-full rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none focus:ring-1 focus:ring-[#15A89E]"
      />

      {/* ── Results — nearest first, then "Other practitioners" ─── */}
      {nearList.length === 0 && otherList.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practitioners found</p>
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
              {nearList.map((c) => <PractitionerCardRow key={c.id} card={c} />)}
            </div>
          )}
          {otherList.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 pt-2">
                Other practitioners
              </p>
              {otherList.map((c) => <PractitionerCardRow key={c.id} card={c} />)}
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
  onTryAgain,
}: {
  geo:             GeoState;
  onSuburbPicked:  (lat: number, lng: number, label: string) => void;
  onTryAgain:      () => void;
}) {
  if (geo.kind === 'idle' || geo.kind === 'requesting') {
    return (
      <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
        <p className="text-sm font-medium" style={{ color: '#13294B' }}>
          {geo.kind === 'requesting' ? 'Checking your location…' : 'Allow location to see practitioners near you'}
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

  return (
    <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: '#13294B' }}>
            Search by suburb
          </p>
          <p className="mt-1 text-xs text-gray-500 mb-3">
            Or enable location in your browser to see practitioners near you.
          </p>
        </div>
        <button
          type="button"
          onClick={onTryAgain}
          data-testid="explore-try-location-again"
          className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold text-[#13294B] hover:bg-gray-50"
        >
          Try location
        </button>
      </div>
      <PlacesAutocomplete
        variant="locality"
        placeholder="e.g. Rosebank"
        onSelect={(place) => onSuburbPicked(place.latitude, place.longitude, place.formattedAddress)}
      />
    </div>
  );
}

// ─── Per-practitioner card (with embedded locations) ───────────────────

function PractitionerCardRow({ card }: { card: PractitionerCard }) {
  return (
    <div className="bg-white rounded-2xl border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4" data-testid={`practitioner-card-${card.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-gray-900 truncate">{card.fullName}</p>
          {card.specialty && (
            <p className="text-xs text-gray-500 mt-0.5">{card.specialty}</p>
          )}
        </div>
        {card.hpcsaRegistered && (
          <span
            className="shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200"
            title="Registered with the Health Professions Council of South Africa."
          >
            HPCSA registered ✓
          </span>
        )}
      </div>

      {/* Locations — one row per practice, nearest-first */}
      <ul className="mt-3 space-y-2">
        {card.locations.map((loc) => (
          <LocationRow key={loc.practice_id} loc={loc} />
        ))}
      </ul>
    </div>
  );
}

function LocationRow({ loc }: { loc: LocationOnCard }) {
  const locationLine = [loc.suburb, loc.city].filter(Boolean).join(', ');
  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-gray-100 px-3 py-2">
      <div className="min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{loc.practice_name}</p>
        {locationLine && (
          <p className="text-xs text-gray-500 mt-0.5 truncate">{locationLine}</p>
        )}
        {loc.distanceKm != null && (
          <p className="text-xs font-medium mt-1" style={{ color: '#15A89E' }}>
            {formatDistanceKm(loc.distanceKm)}
          </p>
        )}
      </div>
      {loc.phone && (
        <a
          href={`tel:${loc.phone}`}
          className="shrink-0 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          Call
        </a>
      )}
    </li>
  );
}
