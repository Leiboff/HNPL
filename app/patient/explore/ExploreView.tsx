'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
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
import { categoryCounts } from '@/lib/practitioner/categories';
import PractitionerListCard from './PractitionerListCard';
import Landing from './Landing';

// ─── Find a Practitioner — orchestrator ───────────────────────────────
//
// Two views under one route:
//   • Landing (default, no ?view / no ?specialty / no ?q) — data-driven
//     categories, search box, "See all practitioners", "Use my
//     location" button.
//   • Results (?view=results OR ?specialty=X OR ?q=X) — the redesigned
//     list with grouping + filters + no-location contract.
//
// Geo state + auto-prompt live in THIS component so both views share
// one location. The "Use my location" button (on Landing) and the
// "Try location" retry (on Results denied state) both call the same
// tryLocate() handler.

const RADIUS_PRESETS = [10, 25, 50] as const;
const DEFAULT_RADIUS = 25;

type GeoState =
  | { kind: 'idle' }
  | { kind: 'requesting' }
  | { kind: 'granted'; location: LatLng; source: 'gps' | 'suburb'; label?: string }
  | { kind: 'denied' };

type Props = {
  rows: DirectoryRow[];
};

export default function ExploreView({ rows }: Props) {
  const searchParams = useSearchParams();
  const viewParam      = searchParams?.get('view');
  const specialtyParam = searchParams?.get('specialty');
  const qParam         = searchParams?.get('q');

  // Any non-null filter or view=results puts us in results mode.
  const isResults = viewParam === 'results' || !!specialtyParam || !!qParam;

  // ── Geo state machine ─────────────────────────────────────────────
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

  // ── Pipeline: decorate → group → filter → bucket. ─────────────────
  const userLocation: LatLng | null = geo.kind === 'granted' ? geo.location : null;

  const decorated = useMemo(
    () => decorateWithDistance(rows, userLocation),
    [rows, userLocation],
  );
  const cards       = useMemo(() => groupIntoCards(decorated),        [decorated]);
  const specialties = useMemo(() => specialtiesFromCards(cards),      [cards]);
  const categories  = useMemo(() => categoryCounts(cards),            [cards]);

  const locationHint =
    geo.kind === 'granted'
      ? (geo.source === 'suburb' && geo.label ? `Near ${geo.label}` : 'Near your current location')
      : null;

  // ── LANDING view ──────────────────────────────────────────────────
  if (!isResults) {
    return (
      <Landing
        categories={categories}
        totalPractitioners={cards.length}
        locationHint={locationHint}
        hasLocation={geo.kind === 'granted'}
        onUseMyLocation={tryLocate}
        onSuburbPicked={onSuburbPicked}
      />
    );
  }

  // ── RESULTS view ──────────────────────────────────────────────────
  return (
    <ResultsView
      cards={cards}
      specialties={specialties}
      geo={geo}
      onUseMyLocation={tryLocate}
      onSuburbPicked={onSuburbPicked}
      locationHint={locationHint}
      initialSpecialty={specialtyParam}
      initialQuery={qParam ?? ''}
    />
  );
}

// ─── ResultsView ───────────────────────────────────────────────────────

type ResultsProps = {
  cards:            ReturnType<typeof groupIntoCards>;
  specialties:      string[];
  geo:              GeoState;
  onUseMyLocation:  () => void;
  onSuburbPicked:   (lat: number, lng: number, label: string) => void;
  locationHint:     string | null;
  initialSpecialty: string | null;
  initialQuery:     string;
};

function ResultsView({
  cards,
  specialties,
  geo,
  onUseMyLocation,
  onSuburbPicked,
  locationHint,
  initialSpecialty,
  initialQuery,
}: ResultsProps) {
  const [search,      setSearch]      = useState(initialQuery);
  const [specialty,   setSpecialty]   = useState<string | null>(initialSpecialty);
  const [radiusKm,    setRadiusKm]    = useState<number>(DEFAULT_RADIUS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = useMemo(() => filterCards(cards, search, specialty), [cards, search, specialty]);
  const { nearList, otherList } = useMemo(
    () => bucketPractitionerCards(filtered, geo.kind === 'granted', radiusKm),
    [filtered, geo, radiusKm],
  );

  const activeFilterCount =
    (specialty ? 1 : 0) +
    (geo.kind === 'granted' && radiusKm !== DEFAULT_RADIUS ? 1 : 0);

  return (
    <div className="space-y-4">
      {/* Back to categories */}
      <Link
        href="/patient/explore"
        data-testid="results-back-to-landing"
        className="inline-flex items-center gap-1 text-xs font-semibold"
        style={{ color: '#13294B' }}
      >
        ← Browse by specialty
      </Link>

      {/* Sticky search + filters + Use-my-location */}
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

        {/* Location line + always-visible Use-my-location button. The
            button is also on the Landing screen; both call the same
            tryLocate() so browsers that suppress the auto-prompt still
            let the patient explicitly request geolocation. */}
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs text-gray-500 flex items-center gap-1.5">
            <PinIcon />
            {locationHint ?? (geo.kind === 'requesting' ? 'Checking your location…' : 'No location — showing all practitioners.')}
            {locationHint && <span className="text-gray-400"> · not saved</span>}
          </p>
          {geo.kind !== 'granted' || geo.source === 'suburb' ? (
            <button
              type="button"
              onClick={onUseMyLocation}
              data-testid="use-my-location"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-semibold hover:bg-gray-50"
              style={{ color: '#13294B' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M12 3v2M12 19v2M3 12h2M19 12h2" strokeLinecap="round" />
                <circle cx="12" cy="12" r="9" />
              </svg>
              Use my location
            </button>
          ) : null}
        </div>

        {/* Filters drawer */}
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
                        active ? 'text-white' : 'text-[#13294B] bg-[rgba(19,41,75,.06)] hover:bg-[rgba(19,41,75,.1)]'
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

        {/* Denied-state suburb fallback — the browser-hard-blocked
            escape hatch. Landing has the same PlacesAutocomplete in
            its own denied panel; the two are equivalent. */}
        {geo.kind === 'denied' && (
          <div className="rounded-xl border border-gray-200 bg-white px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-gray-500 mb-1.5">
              Or search by suburb
            </p>
            <PlacesAutocomplete
              variant="locality"
              placeholder="e.g. Rosebank"
              onSelect={(place) => onSuburbPicked(place.latitude, place.longitude, place.formattedAddress)}
            />
          </div>
        )}
      </div>

      {/* Results */}
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

// ─── Small shared pieces ───────────────────────────────────────────────

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

function PinIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
      <path d="M12 22s7-7 7-12a7 7 0 0 0-14 0c0 5 7 12 7 12z" strokeLinejoin="round" />
      <circle cx="12" cy="10" r="2.5" />
    </svg>
  );
}
