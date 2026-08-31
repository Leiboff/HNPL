import type { OnboardingStep } from '@/lib/onboarding/state';
import AuthSurface from '@/app/_components/AuthSurface';
import AuthWordmark from '@/app/_components/AuthWordmark';
import { AUTH_TITLE_CLS, AUTH_SUBTITLE_CLS } from '@/app/_components/authFormStyles';

// ─── Shared onboarding shell ───────────────────────────────────────────
//
// v3: the steps moved onto the SAME ground as /login and /signup.
//
// They used to be a white card on a pale blue-grey wash — a good-looking
// screen, but a different app from the one the patient had just signed up
// in. The journey went navy → white → navy, and the two halves shared
// nothing but the wordmark. Now the whole account journey is one surface:
// AuthSurface for the ground, the .auth-surface tokens for the palette,
// and app/_components/authFormStyles.ts for the controls.
//
// What each screen carries, top to bottom:
//   • the wordmark, centred — the one piece of chrome every screen in the
//     journey shares, including /login and /signup, so moving between
//     them reads as travel inside one app;
//   • the step counter and a SEGMENTED progress rail — one filled segment
//     per completed-or-current step;
//   • the title / description, left-aligned;
//   • the step body.
//
// The rail is COUNT-AGNOSTIC: it renders exactly `steps.length` segments,
// so it reads "of 3" today and grows automatically to "of 4"/"of 5" if
// the credit-check / liveness flags are switched on. No server-side step
// model change is needed for the refresh — the visual is independent of
// the count (see lib/onboarding/state.ts, deliberately untouched).
//
// Layout contract for step bodies (unchanged from v2): `children` render
// inside a `flex flex-col` region with a minimum height, so a step can
// pin its primary action to the bottom of that region with `mt-auto`.
// NOTE the change of reference: `minHeight` is now the BODY's height, not
// the whole card's, so it no longer has to include the chrome above it.

type Props = {
  /** Full path-fixed list for this user (stepListFor). Stable across the journey. */
  steps:        readonly OnboardingStep[];
  /** The step this page renders. Must be a member of `steps`. */
  currentStep:  OnboardingStep;
  title:        string;
  description?: string;
  /** Minimum height of the BODY region in px — what `mt-auto` pins against. */
  minHeight?:   number;
  children:     React.ReactNode;
};

export default function OnboardingShell({
  steps,
  currentStep,
  title,
  description,
  minHeight = 280,
  children,
}: Props) {
  const idx = steps.indexOf(currentStep);
  // Fallback to position 1 if the caller passed a step outside the list
  // (a wiring bug) so the shell still renders sensibly.
  const currentIndex = idx >= 0 ? idx + 1 : 1;
  const total        = steps.length;

  return (
    <AuthSurface>
      {/* No link home on the mark here, unlike /login: mid-signup, a tap
          that leaves for the marketing site abandons a half-finished
          account. The mark is identity, not navigation. */}
      <AuthWordmark size="md" href={null} />

      {/* Progress — counter above, rail below. */}
      <div className="mt-9">
        <div className="flex items-center justify-between">
          <span
            data-testid="onboarding-progress-label"
            className="text-[12px] font-semibold tracking-[0.02em] text-[var(--auth-muted)]"
          >
            Step {currentIndex} of {total}
          </span>
        </div>

        <div
          data-testid="onboarding-progress"
          className="mt-2.5 flex gap-[7px]"
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
              // Filled in the brand accent; the rest is white at alpha,
              // which over the navy ground is simply a lighter navy and
              // so cannot drift out of the family.
              style={{ background: i < currentIndex ? 'var(--auth-accent)' : 'rgba(255,255,255,.16)' }}
            />
          ))}
        </div>
      </div>

      {/* Title + description. Left-aligned, matching the email sign-in
          screen on /login — the other place in the journey where the job
          is "fill this in" rather than "choose one of these". */}
      <div className="mt-8">
        <h1 className={AUTH_TITLE_CLS}>{title}</h1>
        {description && <p className={`mt-2.5 ${AUTH_SUBTITLE_CLS}`}>{description}</p>}
      </div>

      {/* Body — a flex column with a floor, so a step can pin its CTA to
          the bottom with `mt-auto`. */}
      <div className="mt-8 flex flex-col" style={{ minHeight }}>{children}</div>
    </AuthSurface>
  );
}
