'use client';

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { haversineKm, formatDistanceKm, type LatLng } from '@/lib/maps/haversine';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import type { PracticeCard } from './page';
import { bucketPractices, type PracticeWithDistance } from './bucket';

// ─── Explore practices — geolocation + suburb fallback + Haversine ─────
//
// Flow:
//   1. On EVERY mount, attempt navigator.geolocation.getCurrentPosition.
//      The browser decides whether to actually re-prompt:
//        • previously hard-BLOCKED → no prompt, error callback fires;
//          we land in 'denied' and the suburb-search fallback shows.
//        • previously granted → silent success.
//        • previously dismissed → browser usually re-prompts (this is
//          the case bug 2 cared about — we no longer gate the prompt
//          on first-visit-only state).
//      Don't BLOCK on it — the page renders ALL approved practices
//      while the user decides. No approved practice can ever be
//      invisible in the no-location state.
//   2. Granted → set userLocation; the memo sorts by Haversine distance
//      and hides practices beyond the radius preset.
//   3. Denied / unavailable / dismissed → leave userLocation null; the
//      page shows EVERY practice alphabetically AND a Places-driven
//      "search by suburb" input. Picking a suburb feeds the same
//      Haversine sort.
//   4. The denied/dismissed card also offers a "Try again" button that
//      re-calls getCurrentPosition — useful when the user has changed
//      their browser permission via the address-bar pad-lock since
//      first mount.
//
// POPIA: userLocation is component state only — never written to the
// DB. Lives for the session, dies when the page unmounts.
//
// The bucketing rule is captured in app/patient/explore/bucket.ts so
// it's testable in isolation.

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
  // Lazy initializer decides the entry-state synchronously:
  //   • navigator.geolocation MISSING (SSR, locked-down browser) →
  //     'denied' — the suburb fallback is the only path.
  //   • navigator.geolocation PRESENT → 'requesting' — the post-mount
  //     effect calls getCurrentPosition, which transitions us to
  //     'granted' (success) or 'denied' (error / dismiss / timeout)
  //     via the ASYNC callbacks. We never call setGeo synchronously
  //     inside the effect body — that would trip
  //     react-hooks/set-state-in-effect.
  const [geo, setGeo] = useState<GeoState>(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return { kind: 'denied' };
    }
    return { kind: 'requesting' };
  });

  // attemptId increments every time we want to (re)try geolocation.
  // The effect below depends on it, so a button-driven retry simply
  // bumps the counter and the effect re-fires.
  const [attemptId, setAttemptId] = useState(0);

  // Track whether THIS effect run is still the live one — if the
  // component unmounts or attemptId changes mid-flight, ignore the
  // callbacks. Vanilla Geolocation API has no abort signal.
  const livenessRef = useRef({ cancelled: false });

  const tryLocate = useCallback(() => {
    // Reset to 'requesting' so the user sees the spinner while the
    // retry runs. This is a normal event-handler setState (not
    // inside an effect), so the purity lint rule doesn't apply.
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      setGeo({ kind: 'requesting' });
    }
    setAttemptId((n) => n + 1);
  }, []);

  // Re-prompt on every mount AND on every tryLocate() call. Browsers
  // suppress repeated prompts for hard-blocked permissions — that's
  // the platform contract, not our code; the suburb fallback covers
  // it. We always attempt; the browser decides. The setGeo calls live
  // exclusively inside the async getCurrentPosition callbacks so this
  // effect body has no synchronous setState.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      // Initial state already 'denied' from the lazy initializer.
      // Nothing to do.
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
      // Cheap settings: don't insist on high accuracy (drains battery)
      // and don't sit on a hanging request for ages.
      { enableHighAccuracy: false, timeout: 8_000, maximumAge: 60_000 },
    );

    return () => {
      liveness.cancelled = true;
    };
  }, [attemptId]);

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

  // Decorate every practice with distanceKm — null whenever geo isn't
  // granted, or whenever the practice has no coords.
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

  // Bucketing — extracted to bucket.ts so this rule is testable in
  // isolation. The crucial invariant: when hasLocation is false, the
  // returned nearList === filtered (no approved practice is hidden).
  const { nearList, otherList } = useMemo(
    () => bucketPractices(filtered, geo.kind === 'granted', radiusKm),
    [filtered, geo, radiusKm],
  );

  const chipStyle = (active: boolean) =>
    active
      ? { background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)', color: '#fff' }
      : { background: 'rgba(19,41,75,.06)', color: '#13294B' };

  return (
    <div className="space-y-5">
      {/* ── Location card — sets the basis for nearest-first sort ───── */}
      <LocationCard geo={geo} onSuburbPicked={onSuburbPicked} onTryAgain={tryLocate} />

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

          {/* "Other practices" — only rendered when location is GRANTED
              and there's a separate no-coord bucket. In the no-location
              state, everything is already in `nearList` and this
              section stays hidden. */}
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

  // denied → suburb fallback via Google Places (New) Autocomplete +
  // a "Try again" button. The button re-fires getCurrentPosition,
  // which on a hard-BLOCKED browser will silently fail (the browser
  // suppresses the prompt) — the suburb input is the real escape
  // hatch for that case. For a dismissed state, the browser usually
  // does re-prompt.
  return (
    <div className="rounded-2xl bg-white border border-[rgba(19,41,75,.08)] shadow-sm px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium" style={{ color: '#13294B' }}>
            Search by suburb
          </p>
          <p className="mt-1 text-xs text-gray-500 mb-3">
            Or enable location in your browser to see practices near you.
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
