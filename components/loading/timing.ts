/**
 * Loading-affordance timing — one place, because the numbers only make
 * sense relative to each other.
 *
 * ─── THE PROBLEM BEING SOLVED, IN BOTH DIRECTIONS ─────────────────────
 *
 * Too little feedback and a route transition on a mobile network reads as
 * a frozen app. Too much and a 60 ms response produces a skeleton that
 * flashes and vanishes, which reads as a glitch — worse than nothing,
 * because a flicker is a defect signal while a still screen is merely
 * slow. Both failures are real, so every value below is a threshold
 * between them rather than a preference.
 *
 * ─── ONE LIMITATION WORTH KNOWING UP FRONT ────────────────────────────
 *
 * Route-level fallbacks get a DELAY but cannot get a MINIMUM DURATION,
 * and the reason is structural rather than an omission: `loading.tsx` is
 * a Suspense fallback, so React unmounts it the moment the real content
 * streams in. The fallback has no say in its own removal — there is no
 * hook, no callback, nowhere to hold it open from. A minimum duration is
 * only possible where we own the state machine, which is why
 * usePendingAction has one and the skeletons do not.
 *
 * The practical consequence: a response arriving at 160 ms shows a
 * skeleton for ~10 ms. Mitigated by choosing the delay against real
 * network latency (below) rather than by pretending it cannot happen.
 */

/**
 * How long a navigation may take before a skeleton appears.
 *
 * Sized against the two constraints that actually bracket it:
 *
 *   • Nielsen's 100 ms — under that, an interaction feels instantaneous
 *     and no feedback is wanted at all. So the floor is ~100 ms.
 *   • Real latency on SA mobile networks. A round trip to Supabase is
 *     rarely under 200 ms, and the slowest routes here run 7-16 SERIAL
 *     round trips (see the parallelisation task). So anything genuinely
 *     slow clears this threshold comfortably and still gets prompt
 *     feedback.
 *
 * 150 ms sits between them: fast in-cache navigations and local
 * transitions resolve underneath it and show nothing, while every real
 * wait is announced almost immediately.
 */
export const SKELETON_DELAY_MS = 150;

/**
 * How long an in-place action may run before its pending LABEL appears
 * ("Sending bill…", a spinner).
 *
 * Deliberately identical to SKELETON_DELAY_MS: from the user's side a
 * slow navigation and a slow button are the same event — "I tapped
 * something and it hasn't happened yet" — and two different thresholds
 * would make the app feel inconsistent for no benefit.
 *
 * NOTE this delays the LABEL only. The disabled state is never delayed;
 * see usePendingAction.
 */
export const PENDING_LABEL_DELAY_MS = 150;

/**
 * Once a pending label HAS been shown, the minimum time it stays.
 *
 * Without this, an action finishing at 170 ms — just past the delay —
 * flashes "Saving…" for 20 ms, which is the exact glitch the delay was
 * introduced to prevent, merely moved. 400 ms is long enough to read a
 * short label and register as a deliberate state, short enough that
 * nobody waits on it: it only ever applies when the work is already
 * essentially done.
 *
 * Only possible here, not for route skeletons — see the file header.
 */
export const PENDING_LABEL_MIN_MS = 400;
