import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import InactivityGuard from './InactivityGuard';
import { LAST_ACTIVITY_STORAGE_KEY, writeStoredActivity } from './activityStorage';

// ─── Elapsed-time idle, driven through the real component ────────────────
//
// The source-regex pins live in inactivity-lightmode.test.ts. This file
// asserts BEHAVIOUR: it moves a wall clock, hides and shows the tab,
// mounts and unmounts the guard, and checks whether the user got signed
// out. A regex can confirm that a localStorage call exists; only this can
// confirm that a laptop lid closed for fourteen hours ends the session.
//
// The two failure shapes being separated:
//
//   HIDDEN TAB — the tab stays alive, its interval throttled or frozen.
//   Already handled before this change (the guard has always had a
//   visibilitychange handler) and tested here as a regression.
//
//   DISCARDED / RELOADED TAB — the guard re-mounts, and its in-memory
//   `lastActivityRef` was initialised to `Date.now()`. THIS is what was
//   broken: every reload minted a fresh idle window. Modelled below as
//   unmount → advance the clock → mount, which is what a reload is from
//   the component's point of view.

const logoutAndRedirect = vi.hoisted(() => vi.fn());
vi.mock('./logout', () => ({ logoutAndRedirect }));

const T0  = 1_700_000_000_000;
const MIN = 60_000;

// The staff split from (B): warn at 10 min, sign out at 15.
const IDLE_MIN = 10;
const WARN_MIN = 5;
const LOGOUT_AT = (IDLE_MIN + WARN_MIN) * MIN;

let clockMs = T0;
const clock = () => clockMs;

/** Move the wall clock WITHOUT running any timers — a frozen/absent tab. */
const advanceWallClock = (ms: number) => { clockMs += ms; };

const mount = () =>
  render(<InactivityGuard minutesIdle={IDLE_MIN} minutesWarn={WARN_MIN} now={clock} />);

/** Fire one 1 s interval tick and flush React. */
async function tickOnce() {
  await act(async () => { vi.advanceTimersByTime(1000); });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

async function wakeTab() {
  setHidden(false);
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
}

const modal = () => screen.queryByTestId('inactivity-modal');

beforeEach(() => {
  vi.useFakeTimers();
  clockMs = T0;
  window.localStorage.clear();
  logoutAndRedirect.mockClear();
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ─── The case that was broken: a discarded / reloaded tab ────────────────

describe('a reloaded tab measures REAL elapsed time, not time since mount', () => {
  it('idle past the threshold then reloaded → signed out immediately', () => {
    writeStoredActivity(T0);
    mount();
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    // Lid closed. The tab is discarded — nothing runs, no interval, no
    // visibilitychange. Fourteen hours later the user reopens it and the
    // tab reloads: a fresh mount whose in-memory ref is "now".
    cleanup();
    advanceWallClock(14 * 60 * MIN);
    mount();

    // No modal, no grace period — straight out.
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
    expect(modal()).toBeNull();
  });

  it('sixteen minutes is already enough — the threshold, not a long absence', () => {
    writeStoredActivity(T0);
    mount();
    cleanup();
    advanceWallClock(16 * MIN);
    mount();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it('one millisecond over the threshold signs out; one under does not', () => {
    writeStoredActivity(T0);
    mount();
    cleanup();
    advanceWallClock(LOGOUT_AT - 1);
    mount();
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    cleanup();
    advanceWallClock(1);
    mount();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it('reloaded UNDER the threshold → still signed in, and the timer resumes correctly', async () => {
    writeStoredActivity(T0);
    mount();
    cleanup();

    // Away for five minutes — under the 10-minute warn point.
    advanceWallClock(5 * MIN);
    mount();
    expect(logoutAndRedirect).not.toHaveBeenCalled();
    expect(modal()).toBeNull();

    // The timer resumes from the REAL last activity, not from this mount.
    // Six more minutes = 11 total, which is past warn but not logout.
    advanceWallClock(6 * MIN);
    await tickOnce();
    expect(modal()).not.toBeNull();
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    // And logout lands at 15 total, not at 15-after-the-reload.
    advanceWallClock(4 * MIN);
    await tickOnce();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it('a reload no longer mints a fresh window (the regression, stated directly)', async () => {
    // Reload repeatedly while idle. Under the old in-memory-only guard
    // every one of these reset the clock to zero, so the user could stay
    // signed in forever by reloading. Now the elapsed total is what counts.
    writeStoredActivity(T0);
    mount();
    for (let i = 0; i < 5; i++) {
      cleanup();
      advanceWallClock(4 * MIN);   // never 15 in one go
      mount();
    }
    // 20 minutes of real idleness, in 4-minute reload-separated slices.
    expect(clockMs - T0).toBe(20 * MIN);
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });
});

// ─── Hidden-tab handling: regression, not new behaviour ──────────────────

describe('a hidden (but live) tab is still caught on wake', () => {
  it('hidden past the threshold then made visible → signed out immediately', async () => {
    writeStoredActivity(T0);
    mount();

    setHidden(true);
    advanceWallClock(16 * MIN);   // interval frozen — no ticks at all
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    await wakeTab();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
    expect(modal()).toBeNull();
  });

  it('hidden UNDER the threshold then made visible → still signed in', async () => {
    writeStoredActivity(T0);
    mount();

    setHidden(true);
    advanceWallClock(7 * MIN);
    await wakeTab();

    expect(logoutAndRedirect).not.toHaveBeenCalled();
    expect(modal()).toBeNull();

    // Timer resumes from real elapsed time: warn at 10.
    advanceWallClock(4 * MIN);
    await tickOnce();
    expect(modal()).not.toBeNull();
  });

  it('logout fires exactly ONCE, not on every subsequent tick', async () => {
    // The interval keeps firing while window.location.assign tears the
    // page down. Each firing would now dispatch another revocation POST
    // and another global signOut — free before, a request burst now.
    writeStoredActivity(T0);
    mount();
    advanceWallClock(16 * MIN);
    await tickOnce();
    expect(logoutAndRedirect).toHaveBeenCalledTimes(1);

    for (let i = 0; i < 5; i++) {
      advanceWallClock(MIN);
      await tickOnce();
    }
    expect(logoutAndRedirect).toHaveBeenCalledTimes(1);
  });

  it('a frozen interval cannot lose time — elapsed is computed, not counted', async () => {
    // If the guard counted interval fires instead of comparing timestamps,
    // a tab whose timers never ran would never expire. One tick after a
    // 16-minute freeze must be enough.
    writeStoredActivity(T0);
    mount();
    advanceWallClock(16 * MIN);
    await tickOnce();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });
});

// ─── Regression: a live foregrounded tab behaves exactly as before ───────

describe('a foregrounded active tab is unchanged', () => {
  it('activity every 30 s keeps the session alive indefinitely', async () => {
    mount();
    for (let i = 0; i < 40; i++) {   // 20 minutes of steady use
      advanceWallClock(30_000);
      await act(async () => {
        window.dispatchEvent(new Event('keydown'));
        vi.advanceTimersByTime(1000);
      });
    }
    expect(clockMs - T0).toBeGreaterThan(LOGOUT_AT);
    expect(logoutAndRedirect).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
  });

  it('going idle: modal at the warn point, logout at the threshold', async () => {
    mount();

    advanceWallClock(IDLE_MIN * MIN - 1000);
    await tickOnce();
    expect(modal()).toBeNull();

    advanceWallClock(1000);
    await tickOnce();
    expect(modal()).not.toBeNull();
    expect(screen.getByTestId('inactivity-countdown').textContent).toBe('5:00');
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    advanceWallClock(WARN_MIN * MIN);
    await tickOnce();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it('activity does NOT dismiss the modal — only the button does', async () => {
    mount();
    advanceWallClock(IDLE_MIN * MIN);
    await tickOnce();
    expect(modal()).not.toBeNull();

    // A passer-by scrolling a shared reception screen.
    await act(async () => {
      window.dispatchEvent(new Event('wheel'));
      vi.advanceTimersByTime(1000);
    });
    expect(modal()).not.toBeNull();
  });

  it('"Stay signed in" clears the modal AND does not let it reopen', async () => {
    // The trap created by taking min(memory, storage): at this point the
    // STORED timestamp is the old one, so resetting only the in-memory ref
    // would leave the modal reopening on the very next tick. stay() has to
    // write through.
    writeStoredActivity(T0);
    mount();
    advanceWallClock(IDLE_MIN * MIN);
    await tickOnce();
    expect(modal()).not.toBeNull();

    await act(async () => { screen.getByTestId('inactivity-stay').click(); });
    expect(modal()).toBeNull();

    await tickOnce();
    expect(modal()).toBeNull();
    expect(logoutAndRedirect).not.toHaveBeenCalled();

    // And it survives a reload, i.e. the reset really was persisted.
    cleanup();
    advanceWallClock(MIN);
    mount();
    expect(logoutAndRedirect).not.toHaveBeenCalled();
    expect(modal()).toBeNull();
  });

  it('"Sign out now" signs out immediately', async () => {
    mount();
    advanceWallClock(IDLE_MIN * MIN);
    await tickOnce();
    await act(async () => { screen.getByTestId('inactivity-signout').click(); });
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });
});

// ─── Adversarial, end to end ─────────────────────────────────────────────

describe('ADVERSARIAL: the stored timestamp cannot buy extra time', () => {
  it('THE LIMIT: writing "now" before reloading DOES grant a fresh window', () => {
    // Recorded as a passing test asserting the real behaviour, because
    // pretending otherwise would be worse than the limitation itself.
    //
    // A value of exactly `Date.now()` is not distinguishable from a
    // legitimate write made at this instant — and it cannot be, because
    // telling them apart would need the stored value to be authenticated,
    // which needs a secret, which a pure-client guard does not have. So
    // this is equivalent to DELETING the key: both hand out a window
    // measured from mount.
    //
    // What the classification does buy is that the lazy attempts fail
    // closed (see the two cases below): a future timestamp or garbage
    // signs the user out instead of resetting them. And what actually
    // bounds this case is the layer that does not answer to the browser —
    // the 12-hour absolute cap in lib/auth/sessionCap.ts, enforced in
    // proxy.ts from Supabase's own last_sign_in_at.
    //
    // Making the IDLE timeout unforgeable too would mean moving it
    // server-side, the way lib/auth/tillDevice.ts already does for the
    // till's device lock. That is a bigger change than this task, and it
    // is the right next step rather than a gap being hidden here.
    writeStoredActivity(T0);
    mount();
    cleanup();
    advanceWallClock(20 * MIN);

    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(clockMs));
    mount();

    expect(logoutAndRedirect).not.toHaveBeenCalled();
  });

  it('forging a FUTURE timestamp signs the user out rather than resetting them', () => {
    writeStoredActivity(T0);
    mount();
    cleanup();
    advanceWallClock(20 * MIN);
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(clockMs + 86_400_000));
    mount();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });

  it.each(['Infinity', 'NaN', '', '0', '-1', '{"t":1}'])(
    'garbage (%s) in the key signs the user out rather than granting a window',
    (raw) => {
      mount();
      cleanup();
      window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, raw);
      mount();
      expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
    },
  );

  it('a mid-session forgery is caught on the very next tick, not only at mount', async () => {
    writeStoredActivity(T0);
    mount();
    advanceWallClock(2 * MIN);
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(clockMs + 86_400_000));
    await tickOnce();
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });
});

// ─── The patient split is genuinely different ────────────────────────────

describe('durations are per-mount, not global', () => {
  it('patient 5/5 signs out at 10 minutes, where staff 10/5 would not have', async () => {
    writeStoredActivity(T0);
    render(<InactivityGuard minutesIdle={5} minutesWarn={5} now={clock} />);
    cleanup();
    advanceWallClock(11 * MIN);
    render(<InactivityGuard minutesIdle={5} minutesWarn={5} now={clock} />);
    expect(logoutAndRedirect).toHaveBeenCalledWith('/login?reason=inactivity');
  });
});
