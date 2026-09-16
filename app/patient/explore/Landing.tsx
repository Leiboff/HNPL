'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
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
//   • No medical-aid-network language.
//   • No "Use my location" pill / "Near your current location" caption —
//     replaced by the LocationRow the parent renders below the search
//     bar, which drives the shared ChangeLocationSheet.
//   • No "See all practitioners" tile (removed 2026-08-21, direct
//     product decision) — specialty is now the only way in below the
//     search box, and the categories themselves sort A→Z
//     (lib/practitioner/categories.ts) so the list is scannable without
//     it.
//
// Interaction:
//   • The search box searches specialties, not practitioners: this
//     screen's whole job is picking a specialty, so its search narrows
//     the tile list in place rather than jumping the patient into a
//     cross-specialty practitioner list they didn't ask for. Finding a
//     named practitioner happens one level down, inside the specialty.
//   • Tap a specialty tile → parent switches to results, filtered to
//     that specialty (via a URL param the results view reads).
//   • Submitting the search when exactly one specialty matches opens
//     that specialty — the keyboard path to the same place as the tap.

type Props = {
  categories:   CategoryCount[];
  /** LocationRow rendered by the orchestrator; sits directly under the search bar. */
  locationRow:  React.ReactNode;
  /** v4: hide the in-view "Find care" hero when the navy PatientScreen
   *  header already carries the title (avoids a duplicate heading). */
  hideHeading?: boolean;
};

function specialtyHref(specialty: string) {
  return `/patient/explore?view=results&specialty=${encodeURIComponent(specialty)}`;
}

export default function Landing({ categories, locationRow, hideHeading = false }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState('');

  const query = search.trim().toLowerCase();
  const visible = useMemo(
    () => query
      ? categories.filter((c) => c.specialty.toLowerCase().includes(query))
      : categories,
    [categories, query],
  );

  // Enter with a single match is the keyboard equivalent of tapping the
  // one tile left on screen. With 0 or 2+ matches there's nothing
  // unambiguous to open, so the list on screen is the answer.
  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    if (visible.length === 1) router.push(specialtyHref(visible[0].specialty));
  }

  return (
    <div className="space-y-6">
      {/* Hero — suppressed under the v4 navy header (which owns the title). */}
      {!hideHeading && (
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold" style={{ color: 'var(--portal-ink)' }}>Find care</h1>
          <p className="text-sm text-gray-500">
            Pay-later at any of these practitioners. Browse by specialty.
          </p>
        </header>
      )}

      {/* Search + Location row */}
      <form onSubmit={submitSearch} className="space-y-3">
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
            placeholder="Search specialties…"
            aria-label="Search specialties"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="landing-search"
            className="w-full rounded-xl border border-gray-200 bg-white pl-9 pr-3 py-2.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-[var(--portal-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/15"
          />
        </div>

        {/* Location row — directly under the specialty search bar */}
        {locationRow}
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
        ) : visible.length === 0 ? (
          <div
            className="rounded-2xl border border-dashed border-gray-200 py-10 text-center"
            data-testid="landing-no-matches"
          >
            <p className="font-medium text-gray-500">No specialties match “{search.trim()}”</p>
            <p className="mt-1 text-sm text-gray-400">Try a different word, or clear the search to see them all.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" data-testid="landing-categories">
            {visible.map((c) => (
              <Link
                key={c.specialty}
                href={specialtyHref(c.specialty)}
                data-testid={`landing-category-${c.specialty}`}
                className="group rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm hover:shadow-md transition-shadow px-4 py-4 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900 leading-snug break-words">{c.specialty}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {c.count} practitioner{c.count === 1 ? '' : 's'}
                  </p>
                </div>
                <span
                  aria-hidden
                  className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-white transition-transform group-hover:translate-x-0.5"
                  style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
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
    </div>
  );
}
