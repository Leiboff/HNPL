'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import PlacesAutocomplete from '@/app/_components/PlacesAutocomplete';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── Landing — "Browse by specialty" ───────────────────────────────────
//
// The first screen a patient sees under /patient/explore. Data-driven:
// the parent computes CategoryCount[] from the LIVE inventory (the
// same grouped-practitioner set the results list uses) so a specialty
// that hasn't attracted any active provider yet doesn't appear here.
// New specialties gaining ≥1 practitioner appear automatically — no
// hard-coded list to update.
//
// Explicitly NOT here (per the brief):
//   • No hard-coded Doctor / Dentist / Pharmacy / Hospital / Vet grid.
//   • No A-Z alphabetical specialty screen.
//   • No medical-aid-network language.
//
// Interaction:
//   • Tap a specialty tile → parent switches to results, filtered to
//     that specialty (via a URL param the results view reads).
//   • Tap "See all practitioners" → parent switches to results with
//     no specialty filter (all).
//   • Search input → typing anything switches to results with the
//     search text pre-populated.
//   • "Use my location" — always visible, on-demand geolocation
//     re-trigger. Parent owns the geo state machine.

type Props = {
  categories:       CategoryCount[];
  totalPractitioners: number;
  locationHint:     string | null;   // "Near Rosebank" / "Near your current location" / null
  hasLocation:      boolean;
  onUseMyLocation:  () => void;
  onSuburbPicked:   (lat: number, lng: number, label: string) => void;
};

export default function Landing({
  categories,
  totalPractitioners,
  locationHint,
  hasLocation,
  onUseMyLocation,
  onSuburbPicked,
}: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = search.trim();
    const params = new URLSearchParams();
    params.set('view', 'results');
    if (q) params.set('q', q);
    router.push(`/patient/explore?${params.toString()}`);
  }

  return (
    <div className="space-y-6">
      {/* Hero */}
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold" style={{ color: '#13294B' }}>Find care</h1>
        <p className="text-sm text-gray-500">
          Pay-later at any of these practitioners. Browse by specialty, or see everyone.
        </p>
      </header>

      {/* Search + Use-my-location */}
      <form onSubmit={submitSearch} className="space-y-3">
        <div className="relative">
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
            placeholder="Search practitioners by name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="landing-search"
            className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[#15A89E] focus:outline-none focus:ring-2 focus:ring-[#15A89E]/15"
          />
        </div>

        {/* Location context + always-visible Use-my-location button */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={onUseMyLocation}
            data-testid="use-my-location"
            className="inline-flex items-center gap-1.5 rounded-xl border border-[rgba(19,41,75,.12)] bg-white px-3 py-2 text-xs font-semibold hover:bg-gray-50"
            style={{ color: '#13294B' }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M3 12h2M19 12h2" strokeLinecap="round" />
              <circle cx="12" cy="12" r="9" />
            </svg>
            Use my location
          </button>
          {locationHint && (
            <span className="text-xs text-gray-500 truncate">{locationHint}</span>
          )}
          {!hasLocation && (
            <span className="text-xs text-gray-400">Optional — helps show nearest first.</span>
          )}
        </div>

        {/* Suburb fallback — always available for patients who blocked
            geolocation at the browser level. Picking a suburb sets
            geo via onSuburbPicked. */}
        {!hasLocation && (
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
      </form>

      {/* Categories */}
      <section className="space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-500">
          Browse by specialty
        </h2>
        {categories.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-gray-200 py-10 text-center">
            <p className="text-sm text-gray-500">
              No practitioners live on BetterNow yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="landing-categories">
            {categories.map((c) => (
              <Link
                key={c.specialty}
                href={`/patient/explore?view=results&specialty=${encodeURIComponent(c.specialty)}`}
                data-testid={`landing-category-${c.specialty}`}
                className="group rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm hover:shadow-md transition-shadow px-4 py-4 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 truncate">{c.specialty}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {c.count} practitioner{c.count === 1 ? '' : 's'}
                  </p>
                </div>
                <span
                  aria-hidden
                  className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-white transition-transform group-hover:translate-x-0.5"
                  style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
                    <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* See all */}
      <Link
        href="/patient/explore?view=results"
        data-testid="landing-see-all"
        className="block rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm hover:shadow-md transition-shadow px-5 py-4"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold" style={{ color: '#13294B' }}>See all practitioners</p>
            <p className="text-xs text-gray-500 mt-0.5">
              {totalPractitioners} practitioner{totalPractitioners === 1 ? '' : 's'} across every specialty.
            </p>
          </div>
          <span
            aria-hidden
            className="shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-full border border-[rgba(19,41,75,.12)]"
            style={{ color: '#13294B' }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
              <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </Link>
    </div>
  );
}
