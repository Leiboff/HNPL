'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { CategoryCount } from '@/lib/practitioner/categories';

// ─── ExploreHeader — the title block above the Find-care list ──────────
//
// The header carries the thing the patient is actually looking at. On the
// landing that's "Find care"; inside a specialty it's the SPECIALTY —
// "General Dental Practitioner" — with the count of people behind it, and
// a back control that reads as "out of here, back to the other
// specialties".
//
// It sits on the navy CROWN — the short band every bottom-nav tab opens
// with (see the `crown` tone in PatientScreen). v5 had taken the band off
// this screen on the argument that a dark slab carrying two lines of text
// spends the loudest object on the screen for nothing. At chrome height
// that argument runs out, and it never covered the cost: Home met the
// phone's status bar in navy while Find care met it in pale grey.
//
// The landing's SEARCH FIELD rides up here with the title, which is what
// makes the crown carry its own weight rather than just being a coloured
// bar — a white field on navy is also the strongest that field has looked.
// Inside a specialty it comes back off: there the sheet's own search box
// live-filters the list as you type (ResultsView), and two search fields on
// one screen is one too many.
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

  // ── Landing: the brand title, and the search field. ───────────────
  if (!isResults) {
    return (
      <div data-testid="explore-header">
        <p className="text-[27px] font-bold text-white" style={{ letterSpacing: '-.035em' }} data-testid="explore-header-title">
          Find care
        </p>
        <p className="mt-2 text-[13.5px]" style={{ color: 'rgba(255,255,255,.6)' }} data-testid="explore-header-count">
          {practitionerCount > 0
            ? `Pay later at ${practitionerCount} practitioner${practitionerCount === 1 ? '' : 's'} near you.`
            : 'Pay later at practitioners near you.'}
        </p>
        <LandingSearch />
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
          style={{ background: 'rgba(255,255,255,.07)', border: '1px solid rgba(255,255,255,.14)', color: '#fff' }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 6-6 6 6 6" />
          </svg>
        </span>
        <span className="text-[12.5px] font-semibold" style={{ color: 'rgba(255,255,255,.6)' }}>
          All specialties
        </span>
      </Link>

      <p
        className={`mt-3 ${titleSize} font-bold text-white`}
        style={{ letterSpacing: '-.035em' }}
        data-testid="explore-header-title"
      >
        {title}
      </p>
      <p className="mt-2 text-[13.5px]" style={{ color: 'rgba(255,255,255,.6)' }} data-testid="explore-header-count">
        {subtitle}
      </p>
    </div>
  );
}

// ─── LandingSearch — the search field, on the crown ────────────────────
//
// Moved up from <Landing>, which no longer has a search field at all —
// there is one on this screen and it lives here. Same behaviour it always
// had: submit navigates to the results view with ?q=,
// and typing alone changes nothing (the landing has no list to filter).
// Styled for navy — a white field with no visible border, because on navy
// the field's own fill is the edge.
function LandingSearch() {
  const router = useRouter();
  const [search, setSearch] = useState('');

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const q = search.trim();
    const params = new URLSearchParams();
    params.set('view', 'results');
    if (q) params.set('q', q);
    router.push(`/patient/explore?${params.toString()}`);
  }

  return (
    <form onSubmit={submit} className="relative mt-[18px]">
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
        className="w-full rounded-2xl bg-white pl-[42px] pr-4 py-[13px] text-[14px] focus:outline-none focus:ring-2 focus:ring-[var(--brand-teal-bright)]/40"
        style={{ border: '1px solid rgba(255,255,255,.14)', color: 'var(--portal-ink)' }}
      />
    </form>
  );
}
