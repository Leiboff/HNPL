'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── ExploreHeader — the title block above the Find-care list ──────────
//
// The header carries the thing the patient is actually looking at. On the
// landing that's "Find care"; inside a specialty it's the SPECIALTY —
// "General Dental Practitioner" — with the count of people behind it, and
// a back control that reads as "out of here, back to the other
// specialties".
//
// It sits on the light sheet now, not on a navy band. Find care leads with
// a SEARCH FIELD, and the band above it was a dark slab carrying two lines
// of text — the loudest object on the screen spent on its own name. The
// band is reserved for screens that lead with a figure (see the `plain`
// tone in PatientScreen); this is not one.
//
// Why this replaces the old sheet-level "← Browse by specialty" link:
// that link was 12px of text floating above the search box, competing
// with the card stack for attention while the header still said "Find
// care" — i.e. the loudest element on screen was the least specific one.
// Moving it up promotes the specialty to the title and puts the back
// affordance in the same place every other patient sub-screen keeps it
// (the circular chevron — see account/SubScreenHeader and the plan
// detail screen), just with a visible label since "back" here means
// "browse the other specialties", which an unlabelled arrow can't say.
//
// URL-driven: this is a client component so it re-renders when the
// specialty param changes — including when it changes from the Filters
// drawer inside the sheet (ExploreView syncs the param via
// history.replaceState), so the title can never disagree with the list
// underneath it.

type Props = {
  /** Distinct practitioners in the whole directory (landing + unfiltered results). */
  practitionerCount: number;
  /** Per-specialty counts, computed server-side from the same rows the list uses. */
  categories: CategoryCount[];
};

export default function ExploreHeader({ practitionerCount, categories }: Props) {
  const searchParams   = useSearchParams();
  const specialtyParam = searchParams?.get('specialty') ?? null;
  const qParam         = searchParams?.get('q') ?? null;
  const isResults      = searchParams?.get('view') === 'results' || !!specialtyParam || !!qParam;

  // ── Landing: the brand title, unchanged. ──────────────────────────
  if (!isResults) {
    return (
      <div data-testid="explore-header">
        <p className="text-[27px] font-bold" style={{ letterSpacing: '-.035em', color: 'var(--portal-ink)' }} data-testid="explore-header-title">
          Find care
        </p>
        <p className="mt-2 text-[13.5px]" style={{ color: 'var(--portal-muted)' }} data-testid="explore-header-count">
          {practitionerCount > 0
            ? `Pay later at ${practitionerCount} practitioner${practitionerCount === 1 ? '' : 's'} near you.`
            : 'Pay later at practitioners near you.'}
        </p>
      </div>
    );
  }

  // ── Results: the specialty IS the title. ──────────────────────────
  const count = specialtyParam
    ? categories.find((c) => c.specialty === specialtyParam)?.count ?? 0
    : practitionerCount;

  const title = specialtyParam ?? 'All practitioners';

  // Specialty names run long ("General Dental Practitioner" is 27
  // characters) and the gutter is 20px on a 360px phone. Step the title
  // down one size rather than let it wrap to three lines.
  const titleSize = title.length > 22 ? 'text-[22px]' : 'text-[27px]';

  const subtitle = count > 0
    ? `Pay later at ${count} practitioner${count === 1 ? '' : 's'}.`
    : 'No practitioners listed here yet.';

  return (
    <div data-testid="explore-header">
      <Link
        href="/patient/explore"
        data-testid="results-back-to-landing"
        aria-label="Back to all specialties"
        className="group inline-flex items-center gap-2.5 -ml-0.5 rounded-full pr-3 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--portal-accent)]/50"
      >
        <span
          aria-hidden
          className="flex-none w-9 h-9 rounded-full flex items-center justify-center transition-transform group-hover:-translate-x-0.5"
          style={{ background: '#fff', border: '1px solid var(--portal-hairline)', color: 'var(--portal-ink)' }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </span>
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--portal-muted)' }}>
          All specialties
        </span>
      </Link>

      <p
        className={`mt-3 ${titleSize} font-bold`}
        style={{ letterSpacing: '-.035em', color: 'var(--portal-ink)' }}
        data-testid="explore-header-title"
      >
        {title}
      </p>
      <p className="mt-2 text-[13.5px]" style={{ color: 'var(--portal-muted)' }} data-testid="explore-header-count">
        {subtitle}
      </p>
    </div>
  );
}
