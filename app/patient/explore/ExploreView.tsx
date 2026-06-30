'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { LatLng } from '@/lib/maps/haversine';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import {
  decorateWithDistance,
  groupIntoCards,
  filterCards,
  bucketPractitionerCards,
  specialtiesFromCards,
  type DirectoryRow,
} from '@/lib/practitioner/grouping';
import PractitionerListCard from './PractitionerListCard';

// ─── Find a Practitioner — Discovery-inspired card layout, BetterNow tone
//
// Renders one card per PRACTITIONER (grouped by HPCSA, NULL fallback
// to member_id). Multi-location practitioners show their nearest
// location inline + "Show all N locations" to reveal the rest. Each
// location row has Call to book + Directions actions. Tapping the
// header "View profile →" opens /patient/practitioner/[memberId].
//
// Things we DELIBERATELY don't show — these come from Discovery's UI
// but are wrong for BetterNow (not a medical scheme):
//   • No "Cover" / "In Network" / "Full network cover" / "Partial cover".
//   • No "Premier Plus" / "Nominate as primary GP".
//   • No HPCSA badge (registration assumed for every listed practitioner).
// These omissions are pinned by source-text tests.
//
// The data, grouping, distance, no-location, and re-prompt contracts
// are UNCHANGED from the previous design — only the visual layer and
// the new detail-screen link are this build.

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
  const [filtersOpen, setFiltersOpen] = useState(false);

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
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;

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

  // ── Pipeline: decorate → group → filter → bucket. All pure. ─────
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

  const activeFilterCount =
    (specialty ? 1 : 0) +
    (geo.kind === 'granted' && radiusKm !== DEFAULT_RADIUS ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* ── Sticky search + filters bar (Discovery-style header polish) */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <svg
              aria-hidden
              className="absolute left-3 top-1/2 -translate-y-1/2"
              width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7A8AA0" strokeWidth={2}
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              placeholder="Search practitioners…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none focus:ring-2 focus:ring-[#15A89E]/15"
            />
          </div>
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            data-testid="filters-toggle"
            aria-expanded={filtersOpen}
            className="shrink-0 inline-flex items-center gap-1.5 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-[#13294B] hover:bg-gray-50"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden>
              <path d="M4 6h16M7 12h10M10 18h4" strokeLinecap="round" />
            </svg>
            Filters
            {activeFilterCount > 0 && (
              <span className="ml-0.5 inline-flex items-center justify-center min-w-4.5 h-4.5 rounded-full bg-[#15A89E] text-white text-[10px] font-semibold px-1">
                {activeFilterCount}
              </span>
            )}
          </button>
        </div>

        {/* Compact location indicator + suburb fallback */}
        <LocationLine geo={geo} onSuburbPicked={onSuburbPicked} onTryAgain={tryLocate} />

        {/* Filters drawer — proximity + specialty. Closed by default
            to keep the top of the page clean (Discovery-style); the
            count badge above advertises that filters are applied. */}
        {filtersOpen && (
          <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 space-y-3">
            {geo.kind === 'granted' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 w-20 shrink-0">Proximity</span>
                {RADIUS_PRESETS.map((km) => {
                  const active = radiusKm === km;
                  return (
                    <button
                      key={km}
                      type="button"
                      onClick={() => setRadiusKm(km)}
                      data-testid={`filter-radius-${km}`}
                      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
                        active
                          ? 'text-white'
                          : 'text-[#13294B] bg-[rgba(19,41,75,.06)] hover:bg-[rgba(19,41,75,.1)]'
                      }`}
                      style={active ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' } : undefined}
                    >
                      {km} km
                    </button>
                  );
                })}
              </div>
            )}

            {specialties.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 w-20 shrink-0">Specialty</span>
                <SpecialtyChip active={specialty === null} onClick={() => setSpecialty(null)} testId="filter-specialty-all">
                  All
                </SpecialtyChip>
                {specialties.map((s) => (
                  <SpecialtyChip
                    key={s}
                    active={specialty === s}
                    onClick={() => setSpecialty(specialty === s ? null : s)}
                    testId={`filter-specialty-${s}`}
                  >
                    {s}
                  </SpecialtyChip>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

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
              {nearList.map((c) => <PractitionerListCard key={c.id} card={c} />)}
            </div>
          )}
          {otherList.length > 0 && (
            <div className="space-y-3 pt-2">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Other practitioners
              </p>
              {otherList.map((c) => <PractitionerListCard key={c.id} card={c} />)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Specialty chip ────────────────────────────────────────────────────

function SpecialtyChip({
  active,
  onClick,
  testId,
  children,
}: {
  active:   boolean;
  onClick:  () => void;
  testId:   string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={`rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
        active
          ? 'text-white'
          : 'text-[#13294B] bg-[rgba(19,41,75,.06)] hover:bg-[rgba(19,41,75,.1)]'
      }`}
      style={active ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' } : undefined}
    >
      {children}
    </button>
  );
}

// ─── LocationLine — the inline "Near your current location" strip ──────
//
// Compact one-row replacement for the previous big white card. Shows
// the current geo state + the "your location is not saved" reassurance.
// When denied, the suburb picker drops down + a Try-location retry.

function LocationLine({
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
      <p className="text-xs text-gray-500 flex items-center gap-1.5">
        <PinIcon /> Checking your location…
      </p>
    );
  }

  if (geo.kind === 'granted') {
    const line = geo.source === 'suburb' && geo.label
      ? `Near ${geo.label}`
      : 'Near your current location';
    return (
      <p className="text-xs text-gray-500 flex items-center gap-1.5">
        <PinIcon /> {line} · Your location is not saved.
      </p>
    );
  }

  return (
    <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: '#13294B' }}>Search by suburb</p>
          <p className="mt-0.5 text-xs text-gray-500">
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

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}
