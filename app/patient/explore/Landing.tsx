'use client';

import Link from 'next/link';
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
//   • No search field. It moved onto the navy crown with the title —
//     see LandingSearch in ExploreHeader.
//   • No "See all practitioners" tile (removed 2026-08-21, direct
//     product decision) — specialty is now the only way in below the
//     search box, and the categories themselves sort A→Z
//     (lib/practitioner/categories.ts) so the list is scannable without
//     it.
//
// Interaction:
//   • Tap a specialty tile → parent switches to results, filtered to
//     that specialty (via a URL param the results view reads).

type Props = {
  categories:   CategoryCount[];
  /** LocationRow rendered by the orchestrator; sits directly under the
   *  crown's search bar, which is the first thing on the sheet now. */
  locationRow:  React.ReactNode;
  /** v4: hide the in-view "Find care" hero when the navy PatientScreen
   *  header already carries the title (avoids a duplicate heading). */
  hideHeading?: boolean;
};

export default function Landing({ categories, locationRow, hideHeading = false }: Props) {
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

      {/* Location row — directly under the crown's search bar */}
      {locationRow}

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
                className="bn-card-hover relative flex-none rounded-full px-[14px] py-[9px] text-[12.5px] font-medium whitespace-nowrap"
                style={{ background: '#fff', border: '1px solid rgba(19,41,75,.1)', color: 'var(--portal-ink)' }}
              >
                {c.specialty}
                {/* The count is a bare number in the pill — beside a
                    specialty name it reads as one, and the full phrase
                    would double the pill's width. "practitioners" is not
                    dropped, only moved: the sr-only span carries the whole
                    phrase for anyone who cannot see that arrangement.
                    The visible one is aria-hidden, or the link announces
                    the number twice ("Dentistry · 2, 2 practitioners").

                    `relative` on the pill above is what keeps that span
                    from breaking the page, and it is not decoration.
                    `sr-only` is `position: absolute`, so it resolves
                    against the nearest POSITIONED ancestor — and there
                    wasn't one, all the way up to the viewport. A span
                    belonging to a pill scrolled off the right-hand end of
                    this row was therefore laid out against the viewport at
                    x≈650 instead of being clipped by the scroller with its
                    pill, and the whole document grew to 649px wide on a
                    390px phone: Find care panned sideways into 259px of
                    nothing, and browsers that shrink-to-fit rendered the
                    screen zoomed out like a desktop page. Making the pill
                    a containing block puts the span back inside the
                    scroller, where the overflow is already handled.
                    Pinned by app/patient/explore/landing-overflow.test.tsx. */}
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
