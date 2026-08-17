'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PENDING_LABEL_DELAY_MS, PENDING_LABEL_MIN_MS } from './timing';

/**
 * One pending-state contract for in-place actions.
 *
 * ═══════════════════════════════════════════════════════════════════════
 * READ THIS BEFORE "CONVERGING" THE TWO PENDING PATTERNS IN THIS APP
 * ═══════════════════════════════════════════════════════════════════════
 *
 * A survey of app/ finds two ways of tracking a pending action:
 *
 *     useTransition                      33 files
 *     a manual useState boolean          31 files
 *     both in the same file               0 files
 *
 * The zero is the important number. This is NOT drift that someone forgot
 * to clean up — it is a STRUCTURAL split, and the two halves are doing
 * different things:
 *
 *   • useTransition wraps a SERVER ACTION. Its isPending stays true
 *     through the action AND the router refresh/revalidation that
 *     follows, which is exactly what you want there: the button should
 *     stay busy until the new data is on screen, not until the POST
 *     returns. Used across admin, crm, brand, practice.
 *
 *   • the manual boolean wraps a DIRECT BROWSER CALL to Supabase —
 *     supabase.auth.signInWithPassword, signUp, updateUser, verifyOtp.
 *     These are not server actions. There is no transition and no
 *     revalidation for React to track, and several of them deliberately
 *     end in `window.location.assign` rather than a re-render. Used
 *     across login, signup, onboarding, update-password, verify-*.
 *
 * Wrapping a direct auth call in startTransition does not make it a
 * transition; it just produces an isPending that flips back before the
 * navigation it triggered has happened, so the button un-disables itself
 * mid-redirect and becomes double-tappable at exactly the wrong moment.
 * Mechanically "converging" the 31 auth-shaped files onto useTransition
 * would therefore break them — quietly, and on the highest-consequence
 * screens in the app.
 *
 * So what is unified is this HOOK, not the mechanism underneath it. It
 * accepts either shape:
 *
 *     const p = usePendingAction();              // owns its own flag
 *     await p.run(() => supabase.auth.signIn…)   // direct call
 *
 *     const [isPending, start] = useTransition();
 *     const p = usePendingAction({ pending: isPending });   // mirrors it
 *
 * Both then present identical timing and identical disabled semantics to
 * the user, which is the property that actually matters, without either
 * half pretending to be the other.
 *
 * ─── THE THREE TIMING RULES, AND WHY THEY DIFFER ──────────────────────
 *
 *  1. `disabled` is TRUE IMMEDIATELY. Never delayed, not by a
 *     millisecond. It is the double-submit guard, and a guard that waits
 *     150 ms is not a guard — 150 ms is comfortably inside the window
 *     where an impatient user double-taps a slow button on a phone. This
 *     is the one value in this file with no threshold logic anywhere near
 *     it, deliberately.
 *
 *     AND `disabled` ALONE IS NOT ENOUGH, which is worth spelling out
 *     because it looks like it should be. `disabled` is React state, and
 *     state updates are asynchronous: taps arriving in the same tick —
 *     before React has re-rendered the button into its disabled form —
 *     all see `disabled === false` and all get through. A test that taps
 *     10 ms apart passes and hides this; three taps in one tick do not.
 *     So `run` ALSO holds a ref, which updates synchronously, and a
 *     re-entrant call is collapsed onto the in-flight one. The ref is the
 *     actual guard; the state is what the user can see.
 *
 *  2. `showLabel` waits PENDING_LABEL_DELAY_MS. A "Saving…" that appears
 *     and vanishes inside 40 ms reads as a glitch, so fast actions stay
 *     visually silent while still being fully guarded by rule 1.
 *
 *  3. Once shown, `showLabel` stays for at least PENDING_LABEL_MIN_MS.
 *     Otherwise an action finishing just past the delay flashes the label
 *     for 20 ms — the same glitch, merely relocated. This is possible
 *     here and impossible for route skeletons, because here we own the
 *     state machine; a Suspense fallback cannot survive its own unmount.
 *     See ./timing.ts.
 *
 * Net effect per duration:
 *
 *     0-150 ms    disabled, no label            (feels instant)
 *     150-400 ms  disabled, label held to 400   (no flash)
 *     400 ms+     disabled, label for as long as it takes
 */

export type PendingAction = {
  /** True from the moment work starts. Bind to `disabled`. NEVER delayed. */
  disabled: boolean;
  /** True only once the work has outlived the delay. Bind to label/spinner. */
  showLabel: boolean;
  /**
   * Run an async function under this hook's own flag. Resolves after the
   * work settles. Rejections are re-thrown so callers keep their own
   * error handling — the hook manages presentation, not failure policy.
   *
   * RE-ENTRANT CALLS ARE COLLAPSED: while a run is in flight, a further
   * call does not start a second one. It returns the in-flight promise,
   * so the duplicate tap resolves with the first call's result rather
   * than erroring — the user asked for the same thing twice and gets the
   * one answer. This is the synchronous half of the double-submit guard;
   * see rule 1 in the file header for why `disabled` cannot do it alone.
   */
  run: <T>(fn: () => Promise<T>) => Promise<T>;
};

export function usePendingAction(options: {
  /**
   * Mirror an EXTERNAL pending flag (a useTransition isPending) instead of
   * owning one. When supplied, `run` still works but the external flag is
   * OR-ed in, so a component may use both without them fighting.
   */
  pending?: boolean;
} = {}): PendingAction {
  const external = options.pending ?? false;

  const [own, setOwn]             = useState(false);
  const [showLabel, setShowLabel] = useState(false);

  const active = own || external;

  // Timers, and the moment the label actually appeared — needed to work
  // out how much of the minimum duration is still owed.
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const minTimer   = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shownAt    = useRef<number | null>(null);

  const clearTimers = () => {
    if (delayTimer.current) { clearTimeout(delayTimer.current); delayTimer.current = null; }
    if (minTimer.current)   { clearTimeout(minTimer.current);   minTimer.current   = null; }
  };

  useEffect(() => {
    if (active) {
      // Work started (or restarted). If the label is already up, leave it
      // alone — restarting the delay would make it blink.
      if (minTimer.current) { clearTimeout(minTimer.current); minTimer.current = null; }
      if (!showLabel && !delayTimer.current) {
        delayTimer.current = setTimeout(() => {
          delayTimer.current = null;
          shownAt.current = Date.now();
          setShowLabel(true);
        }, PENDING_LABEL_DELAY_MS);
      }
      return;
    }

    // Work finished.
    if (delayTimer.current) {
      // Never got as far as showing anything — the fast path. Cancel and
      // stay silent.
      clearTimeout(delayTimer.current);
      delayTimer.current = null;
      return;
    }
    if (showLabel && !minTimer.current) {
      // Label is up: hold it for whatever remains of the minimum.
      const shownFor = shownAt.current === null ? PENDING_LABEL_MIN_MS : Date.now() - shownAt.current;
      const owed     = Math.max(0, PENDING_LABEL_MIN_MS - shownFor);
      minTimer.current = setTimeout(() => {
        minTimer.current = null;
        shownAt.current  = null;
        setShowLabel(false);
      }, owed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, showLabel]);

  // Unmount: drop both timers so neither fires setState on a dead
  // component (a real risk here, since several callers redirect on
  // success and are unmounted mid-flight).
  useEffect(() => clearTimers, []);

  // The SYNCHRONOUS half of the double-submit guard. A ref, not state,
  // precisely because it must be true before React has had a chance to
  // re-render — see rule 1 in the file header.
  const inFlight = useRef<Promise<unknown> | null>(null);

  const run = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    // Already running: hand back the same promise rather than starting a
    // second call. The cast is sound in practice because a re-entrant call
    // comes from the same handler running the same action, so T is the
    // same type — there is no code path where one button's `run` is
    // invoked with two different result types while in flight.
    if (inFlight.current) return inFlight.current as Promise<T>;

    setOwn(true);
    const p = (async () => {
      try {
        return await fn();
      } finally {
        inFlight.current = null;
        setOwn(false);
      }
    })();
    inFlight.current = p;
    return p;
  }, []);

  return { disabled: active, showLabel, run };
}
