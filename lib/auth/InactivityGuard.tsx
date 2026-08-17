'use client';

import { useEffect, useRef, useState } from 'react';
import { logoutAndRedirect } from './logout';
import {
  ACTIVITY_PERSIST_THROTTLE_MS,
  effectiveLastActivity,
  readStoredActivity,
  writeStoredActivity,
} from './activityStorage';

// ─── Inactivity guard — role-tuned idle logout with countdown modal ────
//
// Mounted in each authenticated area's layout with duration-appropriate
// props. Two thresholds:
//
//   • minutesIdle — how long the user must be idle before the modal
//     opens.
//   • minutesWarn — countdown length inside the modal. If the countdown
//     reaches zero without a "Stay signed in" tap, the user is logged
//     out and bounced to /login?reason=inactivity.
//
// Role durations:
//   • patient: 5 / 5 (warning at 5 min, logout at 10 min).
//   • practice / brand / provider / admin / crm: 10 / 5 (warning at
//     10 min, logout at 15 min). The 15-minute figure is not a
//     preference — PCI DSS 4.0 req 8.2.8 requires re-authentication
//     after 15 minutes idle for accounts with administrative
//     capabilities, which these surfaces have. The split shortens the
//     COUNTDOWN rather than the working window, so staff keep the
//     familiar 10 minutes of uninterrupted work and lose only warning
//     time they were never meant to be using.
//
// Design decisions:
//
//   • Activity events (pointerdown, touchstart, keydown, scroll,
//     wheel) reset `lastActivityRef.current`. All are captured on
//     `window` with the `capture: true` option so a child element
//     that stops propagation doesn't block the timer reset.
//   • A single setInterval(1000) polls the elapsed time. This is the
//     ONE authority for both "should the modal be open?" and "should
//     we log out now?" — deriving both from `Date.now() - lastActivity`
//     rules out clock-drift and multi-timer races.
//   • ELAPSED TIME, not a running countdown. `tick()` compares wall
//     clock against a timestamp, so it does not matter how often the
//     interval actually fires — a throttled or frozen timer in a
//     hidden tab cannot lose time. And the timestamp is persisted
//     (./activityStorage), which closes the hole a purely in-memory
//     ref left open: a reload or a browser-discarded tab used to
//     restart the clock at zero, handing an idle user a fresh window.
//     The stored value can only ever SHORTEN the session, never
//     extend it — see activityStorage.ts for the argument.
//   • While the modal is visible, activity events do NOT reset the
//     timer. This is deliberate: a passer-by scrolling the page on a
//     shared device shouldn't silently extend someone else's session.
//     Only the explicit "Stay signed in" button resets.
//   • visibilitychange safety: when the tab returns from background,
//     we re-check immediately. A tab hidden past the deadline logs
//     out on wake rather than showing a stale modal — and because the
//     check is on elapsed time there is no grace period.
//   • One shared timestamp, not per-tab: there is one Supabase session
//     per browser, so the strictest tab decides. This is what the
//     per-tab timers already did in practice (an idle background tab
//     fired its own logout and took the session with it).

const ACTIVITY_EVENTS = ['pointerdown', 'touchstart', 'keydown', 'scroll', 'wheel'] as const;

// Throttle the reset — scroll/wheel fire hundreds of times per second,
// and mutating a ref that fast is fine but the visibility-check side
// of the loop can miss the exact ms window. A 250 ms throttle is
// invisible to users and stops the ref from churning.
const RESET_THROTTLE_MS = 250;

export type InactivityGuardProps = {
  minutesIdle: number;
  minutesWarn: number;
  /** Testing hook — allows deterministic unit tests to inject a clock. */
  now?: () => number;
};

export default function InactivityGuard({ minutesIdle, minutesWarn, now }: InactivityGuardProps) {
  const clock = now ?? Date.now;
  const idleMs = minutesIdle * 60 * 1000;
  const warnMs = minutesWarn * 60 * 1000;

  const [modalOpen, setModalOpen] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(minutesWarn * 60);

  // Refs so the tick loop reads current values without re-subscribing
  // on every render.
  const lastActivityRef = useRef<number>(clock());
  const lastResetRef    = useRef<number>(clock());
  const modalOpenRef    = useRef<boolean>(false);
  // Starts at 0 so the first real activity writes through immediately
  // rather than waiting out a throttle window. Deliberately NOT seeded
  // with clock(): mount must not touch the stored timestamp, or the very
  // reload we are trying to detect would refresh it on the way in.
  const lastPersistRef  = useRef<number>(0);
  // Latches once logout has been triggered. The interval keeps firing
  // while window.location.assign tears the page down, and logging out is
  // no longer free: each firing would dispatch another revocation POST and
  // another global signOut. Harmless before, a small request burst now.
  const loggingOutRef   = useRef<boolean>(false);

  // Mirror modalOpen into a ref so the activity-listener callback
  // (installed once, capturing refs by identity) can read the live
  // value without a re-subscribe. Kept in an effect — mutating a ref
  // during render trips the react-hooks/refs lint rule.
  useEffect(() => {
    modalOpenRef.current = modalOpen;
  }, [modalOpen]);

  useEffect(() => {
    function markActivity() {
      if (modalOpenRef.current) return;   // modal open → activity does NOT reset
      const t = clock();
      if (t - lastResetRef.current < RESET_THROTTLE_MS) return;
      lastResetRef.current = t;
      lastActivityRef.current = t;

      // Write through on a coarser throttle. Lagging is safe in one
      // direction only — a stale stored value can end the session
      // slightly early, never late.
      if (t - lastPersistRef.current >= ACTIVITY_PERSIST_THROTTLE_MS) {
        lastPersistRef.current = t;
        writeStoredActivity(t);
      }
    }

    for (const evt of ACTIVITY_EVENTS) {
      window.addEventListener(evt, markActivity, { capture: true, passive: true });
    }

    function onVisibility() {
      // Tab returning from background — recheck immediately (see tick()).
      if (!document.hidden) tick();
    }
    document.addEventListener('visibilitychange', onVisibility);

    function tick() {
      if (loggingOutRef.current) return;
      const nowMs = clock();
      // The single source of truth for "how long since activity". Takes
      // the EARLIER of what this tab remembers and what storage says, so
      // a forged-forward timestamp is inert and a reload cannot reset the
      // clock. Runs on every tick, on mount, and on tab wake, so all
      // three paths agree by construction rather than by duplication.
      const since   = effectiveLastActivity(lastActivityRef.current, readStoredActivity(nowMs));
      const elapsed = nowMs - since;
      if (elapsed >= idleMs + warnMs) {
        // Expired — log out, exactly once.
        loggingOutRef.current = true;
        void logoutAndRedirect('/login?reason=inactivity');
        return;
      }
      if (elapsed >= idleMs) {
        setModalOpen(true);
        const remaining = Math.max(0, idleMs + warnMs - elapsed);
        setSecondsLeft(Math.ceil(remaining / 1000));
      } else {
        // Under idle threshold — modal should be closed. (In practice
        // it already is; this handles the edge case of a "Stay signed
        // in" tap that closed the modal but left secondsLeft stale.)
        if (modalOpenRef.current) setModalOpen(false);
      }
    }

    const interval = setInterval(tick, 1000);
    tick();  // initial fire so tests / mount don't wait a second

    return () => {
      for (const evt of ACTIVITY_EVENTS) {
        window.removeEventListener(evt, markActivity, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(interval);
    };
    // Deps intentionally exclude `clock` — it's a stable ref in
    // production (Date.now) and mount-fresh in tests.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleMs, warnMs]);

  function stay() {
    lastActivityRef.current = clock();
    lastResetRef.current    = clock();
    // MUST write through, unthrottled. The stored timestamp is by now the
    // older of the two (it is what opened the modal), and tick() takes the
    // minimum — so resetting only the in-memory ref would leave the modal
    // reopening on the very next tick. "Stay signed in" is also the one
    // explicit statement of presence we get, which is exactly the case a
    // throttle should not swallow.
    lastPersistRef.current  = clock();
    writeStoredActivity(clock());
    setModalOpen(false);
  }

  async function signOutNow() {
    loggingOutRef.current = true;
    await logoutAndRedirect('/login?reason=inactivity');
  }

  if (!modalOpen) return null;

  const m = Math.floor(secondsLeft / 60);
  const s = secondsLeft % 60;
  const mmss = `${m}:${s.toString().padStart(2, '0')}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="inactivity-title"
      aria-describedby="inactivity-body"
      data-testid="inactivity-modal"
      className="fixed inset-0 z-100 flex items-center justify-center bg-black/40 px-4"
    >
      <div className="w-full max-w-sm rounded-2xl bg-white shadow-lg p-6 space-y-4">
        <h2 id="inactivity-title" className="text-lg font-semibold" style={{ color: '#13294B' }}>
          Are you still there?
        </h2>
        <p id="inactivity-body" className="text-sm text-gray-600">
          For your security, you&apos;ll be signed out in{' '}
          <span className="font-semibold tabular-nums" data-testid="inactivity-countdown">
            {mmss}
          </span>
          .
        </p>
        <div className="flex flex-col sm:flex-row-reverse gap-2">
          <button
            type="button"
            onClick={stay}
            data-testid="inactivity-stay"
            className="flex-1 rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all hover:shadow-lg"
            style={{ background: 'linear-gradient(135deg, #13294B 0%, #15A89E 145%)' }}
          >
            Stay signed in
          </button>
          <button
            type="button"
            onClick={signOutNow}
            data-testid="inactivity-signout"
            className="flex-1 rounded-lg border border-gray-300 px-4 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}
