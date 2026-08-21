'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState, useMemo, useEffect, useCallback } from 'react';
import type { LatLng } from '@/lib/maps/haversine';
import {
  readStoredLocation,
  writeStoredLocation,
  type SharedLocation,
} from '@/lib/patient/sharedLocation';
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
import LocationRow from './LocationRow';
import ChangeLocationSheet from './ChangeLocationSheet';

// ─── Find a Practitioner — orchestrator ───────────────────────────────
//
// Two views under one route:
//   • Landing (default, no ?view / no ?specialty / no ?q) — data-driven
//     categories, search box.
//   • Results (?view=results OR ?specialty=X OR ?q=X) — the redesigned
//     list with grouping + filters.
//
// Location handling — GESTURE-GATED ONLY:
//   • On mount we hydrate the location from sessionStorage if present;
//     otherwise state stays null and the LocationRow reads "Choose
//     location". We NEVER call navigator.geolocation.getCurrentPosition
//     from this component.
//   • The only path to a fresh browser permission prompt is the "Use
//     current location" tap inside ChangeLocationSheet. Chrome
//     suppresses gesture-less permission prompts, and a denial there
//     poisons geolocation for the origin — hence the strict discipline.
//
// The LocationRow (renders under each screen's search bar) + the
// ChangeLocationSheet replace the old "Use my location" pill and
// "Near your current location" caption entirely.

const RADIUS_PRESETS = [10, 25, 50] as const;
const DEFAULT_RADIUS = 25;

type Props = {
  rows: DirectoryRow[];
  /** v4: the navy PatientScreen header owns the "Find care" title, so
   *  the Landing view suppresses its own duplicate hero heading. */
  hideHero?: boolean;
};

export default function ExploreView({ rows, hideHero = false }: Props) {
  const searchParams = useSearchParams();
  const viewParam      = searchParams?.get('view');
  const specialtyParam = searchParams?.get('specialty');
  const qParam         = searchParams?.get('q');

  // Any non-null filter or view=results puts us in results mode.
  const isResults = viewParam === 'results' || !!specialtyParam || !!qParam;

  // ── Location state ────────────────────────────────────────────────
  const [location, setLocationState] = useState<SharedLocation | null>(null);
  const [sheetOpen, setSheetOpen]    = useState(false);

  const commit = useCallback((loc: SharedLocation) => {
    writeStoredLocation(loc);
    setLocationState(loc);
  }, []);

  // Hydrate from sessionStorage exactly once on mount. Never auto-
  // requests GPS — a permission prompt without a user gesture gets
  // suppressed by Chrome and, when denied, permanently poisons
  // geolocation for the origin. The setState lives inside an async
  // IIFE so react-hooks/set-state-in-effect stays green.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = readStoredLocation();
      if (cancelled) return;
      if (stored) setLocationState(stored);
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Pipeline: decorate → group → filter → bucket. ─────────────────
  // userLocation is memo-ed to keep the LatLng object identity stable
  // when location doesn't change — otherwise `decorated` would
  // recompute on every render (the exhaustive-deps rule catches this).
  const userLocation: LatLng | null = useMemo(
    () => location ? { latitude: location.latitude, longitude: location.longitude } : null,
    [location],
  );

  const decorated = useMemo(
    () => decorateWithDistance(rows, userLocation),
    [rows, userLocation],
  );
  const cards       = useMemo(() => groupIntoCards(decorated),        [decorated]);
  const specialties = useMemo(() => specialtiesFromCards(cards),      [cards]);
  const categories  = useMemo(() => categoryCounts(cards),            [cards]);

  const rowLabel = location?.label ?? null;

  // ── LANDING view ──────────────────────────────────────────────────
  if (!isResults) {
    return (
      <>
        <Landing
          categories={categories}
          hideHeading={hideHero}
          locationRow={
            <LocationRow
              label={rowLabel}
              onOpen={() => setSheetOpen(true)}
            />
          }
        />
        {sheetOpen && (
          <ChangeLocationSheet
            onClose={() => setSheetOpen(false)}
            onCommit={commit}
          />
        )}
      </>
    );
  }

  // ── RESULTS view ──────────────────────────────────────────────────
  return (
    <>
      <ResultsView
        cards={cards}
        specialties={specialties}
        hasLocation={location != null}
        locationRow={
          <LocationRow
            label={rowLabel}
            onOpen={() => setSheetOpen(true)}
          />
        }
        initialSpecialty={specialtyParam}
        initialQuery={qParam ?? ''}
      />
      {sheetOpen && (
        <ChangeLocationSheet
          onClose={() => setSheetOpen(false)}
          onCommit={commit}
        />
      )}
    </>
  );
}

// ─── ResultsView ───────────────────────────────────────────────────────

type ResultsProps = {
  cards:            ReturnType<typeof groupIntoCards>;
  specialties:      string[];
  hasLocation:      boolean;
  locationRow:      React.ReactNode;
  initialSpecialty: string | null;
  initialQuery:     string;
};

function ResultsView({
  cards,
  specialties,
  hasLocation,
  locationRow,
  initialSpecialty,
  initialQuery,
}: ResultsProps) {
  const [search,      setSearch]      = useState(initialQuery);
  const [specialty,   setSpecialty]   = useState<string | null>(initialSpecialty);
  const [radiusKm,    setRadiusKm]    = useState<number>(DEFAULT_RADIUS);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const filtered = useMemo(() => filterCards(cards, search, specialty), [cards, search, specialty]);
  const { nearList, otherList } = useMemo(
    () => bucketPractitionerCards(filtered, hasLocation, radiusKm),
    [filtered, hasLocation, radiusKm],
  );

  const activeFilterCount =
    (specialty ? 1 : 0) +
    (hasLocation && radiusKm !== DEFAULT_RADIUS ? 1 : 0);

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

      {/* Sticky search + filters */}
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

        {/* Location row — directly under the search bar */}
        {locationRow}

        {/* Filters drawer */}
        {filtersOpen && (
          <div className="rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm px-4 py-3 space-y-3">
            {hasLocation && (
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
      </div>

      {/* Results */}
      {nearList.length === 0 && otherList.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practitioners found</p>
          <p className="mt-1 text-sm text-gray-400">
            {hasLocation && nearList.length === 0
              ? 'Try a wider radius or a different search.'
              : 'Try a different search or specialty.'}
          </p>
        </div>
      ) : (
        // One continuous list — the bucketing ORDER stays (near-first,
        // coord-less-after), but the "Other practitioners" subheading
        // is gone so the results read as a single clean stream.
        // No-location contract preserved: when there's no user location,
        // `nearList` contains ALL practitioners (from bucketPractitionerCards)
        // and `otherList` is empty — same as before, just no heading.
        <div className="space-y-3">
          {nearList.map((c) => <PractitionerListCard key={c.id} card={c} />)}
          {otherList.map((c) => <PractitionerListCard key={c.id} card={c} />)}
        </div>
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
