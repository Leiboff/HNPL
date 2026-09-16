'use client';

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
//   • Results (?view=results OR ?specialty=X OR ?q=X) — the grouped
//     practitioner list for ONE specialty, with a name search. No
//     filter drawer: the specialty is the screen, and changing it
//     means going back to the specialty list.
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

// The results list no longer exposes a proximity control (the Filters
// drawer is gone — see ResultsView), but the bucketer still needs a
// radius to decide what counts as "near you" for the near-first
// ORDERING of one continuous list. Nothing is hidden by it: cards
// outside the radius still render, just after the nearby ones.
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
  const cards      = useMemo(() => groupIntoCards(decorated), [decorated]);
  const categories = useMemo(() => categoryCounts(cards),     [cards]);

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
        hasLocation={location != null}
        locationRow={
          <LocationRow
            label={rowLabel}
            onOpen={() => setSheetOpen(true)}
          />
        }
        specialty={specialtyParam}
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
  cards:        ReturnType<typeof groupIntoCards>;
  hasLocation:  boolean;
  locationRow:  React.ReactNode;
  /** The specialty this screen IS, straight from ?specialty=. Fixed for
   *  the life of the screen — swapping specialty means going back. */
  specialty:    string | null;
  initialQuery: string;
};

function ResultsView({
  cards,
  hasLocation,
  locationRow,
  specialty,
  initialQuery,
}: ResultsProps) {
  // The only control on this screen is the practitioner search. The
  // specialty is fixed by the URL — the way to a different one is the
  // header's "All specialties" back control, not a filter drawer that
  // let the screen quietly disagree with its own title.
  const [search, setSearch] = useState(initialQuery);

  const filtered = useMemo(() => filterCards(cards, search, specialty), [cards, search, specialty]);
  const { nearList, otherList } = useMemo(
    () => bucketPractitionerCards(filtered, hasLocation, DEFAULT_RADIUS),
    [filtered, hasLocation],
  );

  return (
    <div className="space-y-4">
      {/* Back to the specialty list lives in the navy header
          (ExploreHeader), which also carries the specialty as its
          title — nothing here duplicates it. */}

      {/* Search — practitioners WITHIN this specialty */}
      <div className="space-y-3">
        <div className="relative">
          <svg
            aria-hidden
            className="absolute left-3 top-1/2 -translate-y-1/2"
            width="16" height="16" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth={2}
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Search practitioners by name…"
            aria-label="Search practitioners by name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="results-search"
            className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[var(--portal-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/15"
          />
        </div>

        {/* Location row — directly under the search bar */}
        {locationRow}
      </div>

      {/* Results */}
      {nearList.length === 0 && otherList.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-gray-200 py-14 text-center">
          <p className="font-medium text-gray-500">No practitioners found</p>
          <p className="mt-1 text-sm text-gray-400">
            {search.trim()
              ? 'Try a different name, or clear the search to see everyone here.'
              : 'Try another specialty from the list.'}
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

