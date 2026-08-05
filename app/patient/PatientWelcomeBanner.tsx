import Link from 'next/link';

// ─── Patient completion welcome (first-run only) ───────────────────────
//
// Shown at the top of the dashboard ONLY on the immediate post-onboarding
// arrival — the /onboarding router appends ?welcome=1 exactly once, on
// the transition to onboarding_completed. Returning patients take the
// plain /patient redirect and never see this. Kept as its own component
// so the dashboard page's layout order (greeting → search → …) is
// untouched: this renders above the greeting, gated by the param.
//
// "Go to my dashboard" links to /patient (no param) so tapping it drops
// the welcome and lands on the ordinary dashboard.

export default function PatientWelcomeBanner({ firstName }: { firstName: string | null }) {
  const name = firstName?.trim() || 'there';

  return (
    <div
      data-testid="patient-welcome-banner"
      className="rounded-3xl border bg-white p-5 sm:p-6 shadow-sm"
      style={{ borderColor: 'rgba(19,41,75,.08)' }}
    >
      <span
        className="inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold"
        style={{ background: 'rgba(21,168,158,.12)', color: '#0F766E' }}
      >
        <svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M5 10.5l3 3 7-7" />
        </svg>
        Verified
      </span>

      <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em]" style={{ color: '#13294B' }}>
        You&rsquo;re all set, {name}
      </h2>
      <p className="mt-1 text-sm text-gray-500">
        Your account is verified. Here&rsquo;s what you can spend on care today.
      </p>

      <div className="mt-4 flex flex-col gap-2 sm:flex-row">
        <Link
          href="/patient/explore"
          className="flex h-[52px] flex-1 items-center justify-center rounded-2xl text-[15px] font-semibold text-white transition-all"
          style={{ background: '#15A89E', boxShadow: '0 10px 22px -12px rgba(21,168,158,0.9)' }}
        >
          Find care near me
        </Link>
        <Link
          href="/patient"
          className="flex h-[52px] flex-1 items-center justify-center rounded-2xl text-[15px] font-semibold"
          style={{ background: '#F1F5F6', color: '#13294B' }}
        >
          Go to my dashboard
        </Link>
      </div>
    </div>
  );
}
