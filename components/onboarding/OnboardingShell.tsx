import Link from 'next/link';

// ─── Shared onboarding progress-bar shell ──────────────────────────────
//
// The single wrapper used by every /onboarding/* step page — both the
// email-signup and the Google-signup paths render inside this shell.
// Only the progress bar is "new"; the card + step body inside it use
// the same look-and-feel as the pre-existing /verify-email + /verify-
// phone screens (canonical OtpInput, gradient primary buttons,
// gray-200/80 border card).
//
// Step counts are per-user + per-flag: the caller (each step page)
// computes `currentIndex` and `total` from stepsFor(user, flags) so
// Google patients see "Step 1 of 2" (no permanently-skipped verify-
// email slot) and email patients see "Step 1 of 3".

type Props = {
  currentIndex: number;
  total:        number;
  title:        string;
  description?: string;
  children:     React.ReactNode;
};

export default function OnboardingShell({
  currentIndex,
  total,
  title,
  description,
  children,
}: Props) {
  const pct = total > 0 ? Math.min(100, Math.round((currentIndex / total) * 100)) : 0;

  return (
    <div className="mx-auto max-w-md px-4 py-8 sm:py-14 space-y-8">

      <header>
        <Link href="/" className="inline-block text-2xl font-bold tracking-tight" style={{ fontFamily: 'var(--font-poppins), Poppins, system-ui, sans-serif' }}>
          <span style={{ color: '#13294B' }}>better</span>
          <span style={{ color: '#15A89E' }}>now</span>
        </Link>
      </header>

      <div data-testid="onboarding-progress" className="space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-gray-500">
          <span data-testid="onboarding-progress-label">
            Step {currentIndex} of {total}
          </span>
          <span>{pct}%</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-gray-200 overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          />
        </div>
      </div>

      <section className="bg-white rounded-2xl shadow-sm border border-gray-200/80 p-6 sm:p-7">
        <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: '#13294B' }}>
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-gray-500">{description}</p>
        )}
        <div className="mt-5">
          {children}
        </div>
      </section>

    </div>
  );
}
