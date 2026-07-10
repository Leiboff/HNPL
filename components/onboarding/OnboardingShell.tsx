import Link from 'next/link';
import type { OnboardingStep } from '@/lib/onboarding/state';

// ─── Shared onboarding progress-bar shell ──────────────────────────────
//
// Receives the FULL step list for this user's path + the CURRENT step,
// and computes its position + total internally. This lets the shell
// mark earlier-list steps as done and prevents the total from
// shrinking mid-flow (the "Step 1 of 3 → Step 1 of 2" defect).
//
// The card + step body inside use the same look-and-feel as the pre-
// existing /verify-email + /verify-phone screens — canonical OtpInput
// (via VerifyEmailForm / PhoneOtpStep), gradient primary buttons,
// gray-200/80 border card.

type Props = {
  /** Full path-fixed list for this user (stepListFor). Stable across the journey. */
  steps:        readonly OnboardingStep[];
  /** The step this page renders. Must be a member of `steps`. */
  currentStep:  OnboardingStep;
  title:        string;
  description?: string;
  children:     React.ReactNode;
};

export default function OnboardingShell({
  steps,
  currentStep,
  title,
  description,
  children,
}: Props) {
  const idx = steps.indexOf(currentStep);
  // Fallback: if the caller passed a step that isn't in the list
  // (shouldn't happen — this would be a wiring bug), treat it as
  // position 1 so the shell still renders sensibly.
  const currentIndex = idx >= 0 ? idx + 1 : 1;
  const total        = steps.length;
  const pct          = total > 0 ? Math.min(100, Math.round((currentIndex / total) * 100)) : 0;

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
