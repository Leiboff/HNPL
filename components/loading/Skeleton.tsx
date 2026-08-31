/**
 * Skeleton primitives — the ONE set. Compose these; don't hand-roll.
 *
 * Before this there were eight ad-hoc loading affordances (seven inline
 * `animate-spin` SVGs and one `animate-pulse` div) and no shared piece at
 * all. The point of this file is that a route's loading state is assembled
 * from named shapes, so the skeletons across the app stay consistent and a
 * change to the shimmer or the accessibility treatment happens once.
 *
 * ─── WHY SKELETONS RATHER THAN SPINNERS ───────────────────────────────
 *
 * A spinner says "wait". A skeleton says "a card with a heading and three
 * rows is arriving here", which is information: the user can start
 * orienting before the data lands, and the swap to real content doesn't
 * reflow the page. That only holds if the shape roughly matches, which is
 * why the compositions live in ./shapes.tsx next to the routes they
 * describe rather than being one generic blob.
 *
 * ─── ACCESSIBILITY: THE SHIMMER IS NOT THE MESSAGE ────────────────────
 *
 * The pulse is `motion-safe:` (matching the existing precedent in
 * components/OtpInput.tsx), so a reduced-motion user gets static grey
 * blocks. Grey blocks with no other signal are the SAME frozen-app problem
 * this work exists to fix, just for a smaller audience — so the animation
 * is never the only indicator:
 *
 *   • SkeletonRegion carries role="status" + aria-busy, which announces
 *     to a screen reader regardless of motion preference.
 *   • It carries a visually-hidden text label, so the state is available
 *     as words and not only as a texture.
 *   • The individual blocks are aria-hidden — announcing sixteen
 *     meaningless boxes would be worse than announcing nothing. The
 *     region speaks for all of them, once.
 *
 * role="status" is deliberate over role="alert": it is polite, so it
 * doesn't interrupt whatever the user is currently hearing, which is right
 * for "this is loading" and wrong for an error.
 */

import type { ReactNode } from 'react';

/**
 * The shared shimmer. `motion-safe:` resolves to
 * @media (prefers-reduced-motion: no-preference), so reduced-motion users
 * get the same layout with no animation — and the accessible label on
 * SkeletonRegion is what carries the meaning for them.
 */
const PULSE = 'motion-safe:animate-pulse';

/** The one grey. Sits between the #f7fbfb page bg and white cards. */
const FILL = 'bg-gray-200/80';

/**
 * The one placeholder tone for the navy auth surface. Grey on navy reads
 * as a hole punched in the screen; white at low alpha reads as a lighter
 * navy, which is exactly what the real controls on that surface are (see
 * the .auth-surface token block in app/globals.css).
 *
 * Two steps only — a block and its label — so the dark skeletons cannot
 * grow their own private ramp.
 */
export const SKELETON_ON_DARK      = 'bg-white/10';
export const SKELETON_ON_DARK_FAINT = 'bg-white/[.07]';

/**
 * Wrap every skeleton in one of these.
 *
 * This is the only element that talks to assistive technology, and it is
 * what makes the reduced-motion case work. A skeleton rendered outside a
 * region is silent to a screen reader and static for a reduced-motion
 * user, i.e. invisible to both — so the primitives below are deliberately
 * not usable as a complete loading state on their own.
 */
export function SkeletonRegion({
  children,
  label = 'Loading',
  className = '',
  style,
}: {
  children: ReactNode;
  /** Say what is loading — "Loading your bills" beats "Loading". */
  label?: string;
  className?: string;
  /**
   * For shells whose background is an inline gradient rather than a class
   * (the auth surfaces). Matching the real background matters: a skeleton
   * on the wrong ground colour flashes the whole viewport on swap, which is
   * more jarring than no skeleton.
   */
  style?: React.CSSProperties;
}) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className={className} style={style}>
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

/** A line of text. `w` is a Tailwind width class so callers can vary rhythm. */
export function SkeletonLine({
  w = 'w-full',
  h = 'h-4',
  className = '',
  fill = FILL,
  radius = 'rounded',
}: {
  w?: string;
  h?: string;
  className?: string;
  /**
   * The placeholder tone. Defaults to the grey that suits the app's light
   * surfaces; pass SKELETON_ON_DARK for the navy auth surface. A prop
   * rather than an `!important` class override in the caller, so both
   * tones are written down in one place.
   */
  fill?: string;
  /** Match the radius of the real control this stands in for. */
  radius?: string;
}) {
  return <div aria-hidden className={`${h} ${w} ${radius} ${fill} ${PULSE} ${className}`} />;
}

/** A solid rectangle — a chart, a QR, an image, a map. */
export function SkeletonBlock({
  h = 'h-24',
  className = '',
}: {
  h?: string;
  className?: string;
}) {
  return <div aria-hidden className={`${h} w-full rounded-xl ${FILL} ${PULSE} ${className}`} />;
}

/** A circle — avatar, icon slot, status dot. */
export function SkeletonCircle({
  size = 'h-10 w-10',
  className = '',
}: {
  size?: string;
  className?: string;
}) {
  return <div aria-hidden className={`${size} rounded-full ${FILL} ${PULSE} ${className}`} />;
}

/**
 * The white rounded card this app uses everywhere (rounded-2xl, thin grey
 * border). Real border and radius rather than a grey blob, so the swap to
 * real content doesn't visibly reflow.
 */
export function SkeletonCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-gray-200/80 bg-white p-5 ${className}`}>
      {children}
    </div>
  );
}

/**
 * N list rows, each a label line over a shorter sub-line with a value on
 * the right. Matches the bill / plan / payout row shape used across the
 * app closely enough to hold the layout.
 *
 * Widths are varied by index from a fixed cycle, NOT randomised: a random
 * width would differ between the server and client render and produce a
 * hydration mismatch.
 */
export function SkeletonRows({
  rows = 4,
  className = '',
}: {
  rows?: number;
  className?: string;
}) {
  const WIDTHS = ['w-2/5', 'w-1/2', 'w-1/3', 'w-3/5'];
  return (
    <div className={`divide-y divide-gray-100 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-4">
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonLine w={WIDTHS[i % WIDTHS.length]} />
            <SkeletonLine w="w-1/4" h="h-3" />
          </div>
          <SkeletonLine w="w-16" h="h-5" />
        </div>
      ))}
    </div>
  );
}

/** A form: N labelled inputs and a submit button. */
export function SkeletonFormFields({
  fields = 3,
  className = '',
}: {
  fields?: number;
  className?: string;
}) {
  return (
    <div className={`space-y-4 ${className}`}>
      {Array.from({ length: fields }).map((_, i) => (
        <div key={i} className="space-y-2">
          <SkeletonLine w="w-24" h="h-3" />
          <SkeletonBlock h="h-11" />
        </div>
      ))}
      <SkeletonBlock h="h-11" className="mt-2" />
    </div>
  );
}

/**
 * An inline spinner, for the cases where there is genuinely no shape to
 * promise — a button mid-submit, or /dashboard working out which area you
 * belong to. Prefer a skeleton wherever content IS arriving.
 *
 * REDUCED MOTION: this HIDES rather than freezing. A frozen spinner is a
 * three-quarter grey arc — it reads as a rendering artifact, not as a
 * status, which is worse than showing nothing. A skeleton block can hold
 * still and still mean something because its SHAPE carries the message; a
 * spinner's meaning is entirely in the motion, so with the motion removed
 * there is nothing left worth drawing.
 *
 * Which is why this must never be the only indicator: it is aria-hidden,
 * and every caller pairs it with text ("Setting up…") or sits inside a
 * SkeletonRegion. Reduced-motion users get that text; the spinner is
 * decoration on top of it, not the signal itself.
 */
export function Spinner({
  size = 'h-4 w-4',
  className = '',
}: {
  size?: string;
  className?: string;
}) {
  return (
    <svg
      aria-hidden
      className={`${size} motion-safe:animate-spin motion-reduce:hidden ${className}`}
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8v4l3-3-3-3V4a8 8 0 00-8 8z"
      />
    </svg>
  );
}

/**
 * A row of stat tiles — the dashboard shape (/practice, /brand, /admin).
 */
export function SkeletonStatTiles({
  tiles = 3,
  className = '',
}: {
  tiles?: number;
  className?: string;
}) {
  return (
    <div className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${className}`}>
      {Array.from({ length: tiles }).map((_, i) => (
        <SkeletonCard key={i} className="space-y-3">
          <SkeletonLine w="w-20" h="h-3" />
          <SkeletonLine w="w-28" h="h-7" />
        </SkeletonCard>
      ))}
    </div>
  );
}
