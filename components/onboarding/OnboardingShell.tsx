import Link from 'next/link';
import type { OnboardingStep } from '@/lib/onboarding/state';

// ─── Shared onboarding shell (v2 visual refresh) ────────────────────────
//
// One card per screen. The card header row carries the wordmark (left)
// and "Step n of total" (right); directly under it a SEGMENTED progress
// rail — one filled segment per completed-or-current step. Then the
// title / description, then the step body.
//
// The rail is COUNT-AGNOSTIC: it renders exactly `steps.length` segments,
// so it reads "of 3" today and grows automatically to "of 4"/"of 5" if
// the credit-check / liveness flags are switched on. No server-side step
// model change is needed for the refresh — the visual is independent of
// the count (see lib/onboarding/state.ts, deliberately untouched).
//
// Layout contract for step bodies: the card is a flex column with a min
// height; `children` render inside a `flex-1 flex flex-col` region, so a
// step pins its primary action to the card bottom with `mt-auto`.

type Props = {
  /** Full path-fixed list for this user (stepListFor). Stable across the journey. */
  steps:        readonly OnboardingStep[];
  /** The step this page renders. Must be a member of `steps`. */
  currentStep:  OnboardingStep;
  title:        string;
  description?: string;
  /** Card min height in px. Integration-seam steps (credit/liveness) use 560. */
  minHeight?:   number;
  children:     React.ReactNode;
};

const POPPINS = 'var(--font-poppins), Poppins, system-ui, sans-serif';

export default function OnboardingShell({
  steps,
  currentStep,
  title,
  description,
  minHeight = 640,
  children,
}: Props) {
  const idx = steps.indexOf(currentStep);
  // Fallback to position 1 if the caller passed a step outside the list
  // (a wiring bug) so the shell still renders sensibly.
  const currentIndex = idx >= 0 ? idx + 1 : 1;
  const total        = steps.length;

  return (
    <div className="min-h-full flex justify-center px-4 py-8 sm:py-14" style={{ background: '#E9EFF1' }}>
      <div className="w-full max-w-[428px]">
        <section
          className="flex flex-col gap-7 overflow-hidden rounded-[28px] border bg-white"
          style={{
            borderColor: 'rgba(19,41,75,0.07)',
            boxShadow:   '0 24px 48px -28px rgba(15,31,58,.28), 0 2px 6px rgba(15,31,58,.04)',
            padding:     '30px 28px 32px',
            minHeight,
          }}
        >
          {/* Header row — wordmark + step counter. */}
          <div className="flex items-center justify-between">
            <Link href="/" className="text-[22px] font-bold tracking-tight" style={{ fontFamily: POPPINS }}>
              <span style={{ color: '#13294B' }}>better</span>
              <span style={{ color: '#15A89E' }}>now</span>
            </Link>
            <span
              data-testid="onboarding-progress-label"
              className="text-xs font-semibold tracking-[0.02em]"
              style={{ color: '#41556F' }}
            >
              Step {currentIndex} of {total}
            </span>
          </div>

          {/* Segmented rail — filled up to and including the current step. */}
          <div
            data-testid="onboarding-progress"
            className="flex gap-[7px]"
            role="progressbar"
            aria-valuenow={currentIndex}
            aria-valuemin={1}
            aria-valuemax={total}
            aria-label={`Step ${currentIndex} of ${total}`}
          >
            {Array.from({ length: total }).map((_, i) => (
              <div
                key={i}
                className="h-[5px] flex-1 rounded-full"
                style={{ background: i < currentIndex ? '#15A89E' : '#E4EAEF' }}
              />
            ))}
          </div>

          {/* Title + description. */}
          <div>
            <h1
              className="text-[28px] font-semibold leading-[1.18] tracking-[-0.025em]"
              style={{ color: '#13294B', fontFamily: POPPINS }}
            >
              {title}
            </h1>
            {description && (
              <p className="mt-2.5 text-[15px] leading-[1.55]" style={{ color: '#6B7C93' }}>
                {description}
              </p>
            )}
          </div>

          {/* Body — grows so a step can pin its CTA to the card bottom. */}
          <div className="flex flex-1 flex-col">{children}</div>
        </section>
      </div>
    </div>
  );
}
