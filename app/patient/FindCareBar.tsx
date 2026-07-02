import Link from 'next/link';

// ─── Find-care search bar (LINK — not a real search input) ─────────────
//
// Discovery-style pattern: on the home dashboard we render an element
// that LOOKS like a search input ("Find a practitioner…" with a search
// icon) but is actually a link to /patient/explore. Tapping anywhere
// on it navigates. Inline search on the home page would just duplicate
// the explore page's search — this redirect affordance keeps the home
// dashboard clean and leans on the well-designed explore experience.

export default function FindCareBar() {
  return (
    <Link
      href="/patient/explore"
      data-testid="find-care-bar"
      className="block rounded-2xl border border-[rgba(19,41,75,.08)] bg-white shadow-sm hover:shadow-md transition-shadow px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7A8AA0" strokeWidth={2} aria-hidden className="shrink-0">
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" strokeLinecap="round" />
        </svg>
        <span className="text-sm text-gray-500 flex-1 truncate">Find a practitioner…</span>
        <span
          aria-hidden
          className="shrink-0 inline-flex h-8 w-8 items-center justify-center rounded-full text-white"
          style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.25}>
            <path d="m9 6 6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      </div>
    </Link>
  );
}
