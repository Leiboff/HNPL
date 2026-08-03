import Link from 'next/link';

// ─── Default-freeze banner ──────────────────────────────────────────────────
//
// Unmissable notice shown on the patient home + orders when the patient has
// an UNRESOLVED defaulted plan. Policy: a single default freezes them out of
// taking any new plan until it's settled. The server enforces the freeze at
// plan creation (lib/patient/freeze.ts + the checkout / saved-card actions);
// this banner is the patient-facing surface of that state.
//
// Renders nothing when `frozen` is false, so callers can drop it in
// unconditionally.

export default function DefaultFreezeBanner({ frozen }: { frozen: boolean }) {
  if (!frozen) return null;

  return (
    <div
      role="alert"
      className="rounded-2xl border border-red-200 bg-red-50 p-4 sm:p-5"
    >
      <div className="flex items-start gap-3">
        <span aria-hidden className="mt-0.5 shrink-0 text-red-600">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-red-900">
            You have a defaulted plan
          </h2>
          <p className="mt-1 text-sm text-red-800 leading-relaxed">
            You can&apos;t take on any new plans until it&apos;s settled. Settle
            the outstanding balance to lift the freeze — then you can use
            betternow again as normal.
          </p>
          <Link
            href="/patient/orders"
            className="mt-3 inline-flex items-center rounded-full bg-red-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-red-700"
          >
            Settle now
          </Link>
        </div>
      </div>
    </div>
  );
}
