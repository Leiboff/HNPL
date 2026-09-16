'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── ExploreHeader — the navy band above the Find-care sheet ───────────
//
// The navy header is the only full-width, high-contrast surface on the
// screen, so it should carry the thing the patient is actually looking
// at. On the landing that's "Find care"; inside a specialty it's the
// SPECIALTY — "General Dental Practitioner" — with the count of people
// behind it, and a back control that reads as "out of here, back to the
// other specialties".
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
        <p className="text-[24px] font-semibold text-white" style={{ letterSpacing: '-.025em' }} data-testid="explore-header-title">
          Find care
        </p>
        <p className="mt-1.5 text-[13.5px]" style={{ color: 'rgba(255,255,255,.62)' }} data-testid="explore-header-count">
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
  // characters) and the band is 22px-padded on a 360px phone. Step the
  // title down one size rather than let it wrap to three lines.
  const titleSize = title.length > 22 ? 'text-[21px]' : 'text-[24px]';

  const subtitle = count > 0
    ? `Pay later at ${count} practitioner${count === 1 ? '' : 's'}.`
    : 'No practitioners listed here yet.';

  return (
    <div data-testid="explore-header">
      <Link
        href="/patient/explore"
        data-testid="results-back-to-landing"
        aria-label="Back to all specialties"
        className="group inline-flex items-center gap-2.5 -ml-0.5 rounded-full pr-3 transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      >
        <span
          aria-hidden
          className="flex-none w-[34px] h-[34px] rounded-full flex items-center justify-center transition-transform group-hover:-translate-x-0.5"
          style={{ background: 'rgba(255,255,255,.12)', border: '1px solid rgba(255,255,255,.14)' }}
        >
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </span>
        <span className="text-[12.5px] font-semibold" style={{ color: 'rgba(255,255,255,.72)' }}>
          All specialties
        </span>
      </Link>

      <p
        className={`mt-3 ${titleSize} font-semibold text-white`}
        style={{ letterSpacing: '-.025em' }}
        data-testid="explore-header-title"
      >
        {title}
      </p>
      <p className="mt-1.5 text-[13.5px]" style={{ color: 'rgba(255,255,255,.62)' }} data-testid="explore-header-count">
        {subtitle}
      </p>
    </div>
  );
}
