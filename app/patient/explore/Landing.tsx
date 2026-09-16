'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
//   • Tap a specialty tile → parent switches to results, filtered to
//     that specialty (via a URL param the results view reads).
//   • Search input → typing anything switches to results with the
//     search text pre-populated.

type Props = {
  categories:   CategoryCount[];
  /** LocationRow rendered by the orchestrator; sits directly under the search bar. */
  locationRow:  React.ReactNode;
  /** v4: hide the in-view "Find care" hero when the navy PatientScreen
   *  header already carries the title (avoids a duplicate heading). */
  hideHeading?: boolean;
};

export default function Landing({ categories, locationRow, hideHeading = false }: Props) {
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
            className="absolute left-[15px] top-1/2 -translate-y-1/2"
            width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth={2}
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            placeholder="Practice, suburb or treatment"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="landing-search"
            className="w-full rounded-2xl bg-white pl-[42px] pr-4 py-[13px] text-[14px] focus:outline-none focus:ring-2 focus:ring-[var(--portal-accent)]/20"
            style={{ border: '1px solid rgba(19,41,75,.08)', color: 'var(--portal-ink)' }}
          />
        </div>

        {/* Location row — directly under the practitioner search bar */}
        {locationRow}
      </form>

      {/* ── Specialties ──────────────────────────────────────────────
          A horizontally scrolling PILL ROW, not a two-column grid of
          cards. Same destinations, same counts; what changes is how much
          of the screen they take. As cards, eleven specialties filled the
          viewport twice over and pushed the practitioners — the thing a
          patient came for — entirely below the fold, so the screen opened
          on a menu of categories rather than on care.

          The labels do NOT wrap. A pill that grows sideways is what the
          horizontal scroll is for; that is also what keeps a long name
          like "General Dental Practitioner" from being clipped, which is
          the failure app/patient/phase5-polish.test.ts pins. */}
      <section className="space-y-3">
        <h2 className="text-[11px] font-semibold uppercase" style={{ letterSpacing: '.16em', color: 'var(--portal-faint)' }}>
          Browse by specialty
        </h2>
        {categories.length === 0 ? (
          <div className="rounded-card py-10 text-center" style={{ border: '1px dashed var(--portal-line)' }}>
            <p className="text-[13.5px]" style={{ color: 'var(--portal-muted)' }}>
              No practitioners live on betternow yet. Check back soon.
            </p>
          </div>
        ) : (
          <div className="bn-scroll -mx-[18px] px-[18px] flex gap-2 overflow-x-auto" data-testid="landing-categories">
            {categories.map((c) => (
              <Link
                key={c.specialty}
                href={`/patient/explore?view=results&specialty=${encodeURIComponent(c.specialty)}`}
                data-testid={`landing-category-${c.specialty}`}
                className="bn-card-hover flex-none rounded-full px-[14px] py-[9px] text-[12.5px] font-medium whitespace-nowrap"
                style={{ background: '#fff', border: '1px solid rgba(19,41,75,.1)', color: 'var(--portal-ink)' }}
              >
                {c.specialty}
                {/* The count is a bare number in the pill — beside a
                    specialty name it reads as one, and the full phrase
                    would double the pill's width. "practitioners" is not
                    dropped, only moved: the sr-only span carries the whole
                    phrase for anyone who cannot see that arrangement.
                    The visible one is aria-hidden, or the link announces
                    the number twice ("Dentistry · 2, 2 practitioners"). */}
                <span aria-hidden style={{ color: 'var(--portal-faint)' }}> · {c.count}</span>
                <span className="sr-only">{` ${c.count} practitioner${c.count === 1 ? '' : 's'}`}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
