import Link from 'next/link';

// ─── Find-care search bar (LINK — not a real search input) ─────────────
//
// Discovery-style pattern: on the home dashboard we render an element
// that LOOKS like a search input ("Find a practitioner…" with a search
// icon) but is actually a link to /patient/explore. Tapping anywhere
// on it navigates. Inline search on the home page would just duplicate
// the explore page's search — this redirect affordance keeps the home
// dashboard clean and leans on the well-designed explore experience.
//
// Visual layer (2026-07): the pill has a "traveling light" border —
// a thin conic-gradient ring that rotates around the perimeter in
// brand colours. Pure CSS (@property --angle + keyframes; no JS
// animation loop). Rules live in globals.css under .find-care-bar-*
// so the pseudo-element mask works with Tailwind v4's opinions on
// class ordering. Prefers-reduced-motion swaps to a static gradient.

export default function FindCareBar() {
  return (
    <div className="find-care-bar-wrap group" data-testid="find-care-bar-wrap">
      <Link
        href="/patient/explore"
        data-testid="find-care-bar"
        className="find-care-bar-surface block rounded-2xl bg-white shadow-sm hover:shadow-md transition-shadow px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--portal-accent)]/60 focus-visible:ring-offset-2"
      >
        <div className="flex items-center gap-3">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ stroke: 'var(--portal-faint)' }} strokeWidth={2} aria-hidden className="shrink-0">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" strokeLinecap="round" />
          </svg>
          <span className="text-sm text-gray-500 flex-1 truncate">Find a practitioner…</span>
          <span
            aria-hidden
            className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-white"
            style={{ background: 'linear-gradient(135deg, var(--portal-ink) 0%, var(--portal-accent) 145%)' }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
              <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>
        </div>
      </Link>
    </div>
  );
}
