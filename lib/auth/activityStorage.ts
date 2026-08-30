/**
 * Persisted "last activity" timestamp — the ELAPSED-TIME half of the idle
 * timeout.
 *
 * WHY THIS EXISTS
 *   InactivityGuard's countdown was driven entirely by an in-memory
 *   `useRef` initialised to `Date.now()` on mount. A running timer is the
 *   right shape for a live foregrounded tab, but on its own it measures
 *   the wrong thing: every reload, tab restore or browser-discard
 *   re-mounts the guard and restarts the clock at zero. Close a laptop
 *   lid on a practice dashboard, reopen it the next morning, the tab
 *   reloads — and the user gets a fresh 15 minutes having been idle for
 *   fourteen hours.
 *
 *   Note what was NOT broken: the guard already re-checks on
 *   `visibilitychange`, so a tab that stays alive while hidden is caught
 *   correctly on wake. The hole is persistence, not visibility. This
 *   module closes the persistence half, and the guard keeps its timer.
 *
 * ─── THE ADVERSARIAL RULE ─────────────────────────────────────────────
 *
 *   NO VALUE WRITABLE INTO THIS KEY CAN LENGTHEN A SESSION.
 *
 *   The value lives in localStorage, which the user owns outright, so the
 *   claim cannot be "it can't be edited". It is the stronger-than-it-looks
 *   one above, achieved by splitting what we read into three cases rather
 *   than two — the distinction that makes the rule hold:
 *
 *     • VALID (a plausible past timestamp) — combined with the tab's own
 *       ref via `Math.min`. Older than memory → the session gets shorter,
 *       which is the case that fixes the bug. Newer than memory → memory
 *       wins and nothing changes. So a fresher timestamp buys nothing.
 *
 *     • TAMPERED (in the future beyond clock-skew tolerance, negative,
 *       or unparseable) — treated as INFINITELY IDLE, which signs the
 *       user out. Nothing legitimate ever writes such a value, so the
 *       only thing this can be is someone trying to move the clock
 *       forward. Failing closed here is what closes the loophole: were
 *       these merely ignored, forging a future timestamp would fall back
 *       to the in-memory ref — and on a fresh mount that ref is `now`,
 *       so ignoring a forged value would hand out exactly the full fresh
 *       window the forger was after.
 *
 *     • ABSENT — falls back to the in-memory ref. This one CANNOT fail
 *       closed, and the reason is worth stating: absence is the normal
 *       state on a first sign-in, and it is also what a browser with
 *       storage disabled or partitioned looks like (private-mode Safari,
 *       hardened settings, an evicted origin). Punishing it would lock
 *       out real users for their browser configuration.
 *
 *   THE HONEST LIMIT, stated plainly because a half-claimed guarantee is
 *   worse than a known one: two moves still get a window measured from
 *   mount, which is what shipped before this change.
 *
 *     • DELETING the key. Indistinguishable from a first sign-in.
 *     • Writing EXACTLY the current time. Indistinguishable from a
 *       legitimate write made at that instant.
 *
 *   Neither can be detected, and not for want of trying: separating them
 *   from honest writes would require the stored value to be
 *   authenticated, which requires a secret, which a guard running
 *   entirely in the browser cannot hold. What the three-way split does
 *   buy is that the careless attempts — a future timestamp, garbage —
 *   fail closed rather than resetting the clock.
 *
 *   So the unforgeable bound is deliberately NOT here. It is the absolute
 *   session cap in lib/auth/sessionCap.ts, measured from Supabase's own
 *   last_sign_in_at and enforced in proxy.ts, where the browser has no
 *   vote. Making the IDLE timeout unforgeable as well means moving it
 *   server-side, the way lib/auth/tillDevice.ts already does for the
 *   till's device lock — the right next step, not something this module
 *   pretends to have done.
 *
 * SCOPE — one key for the whole app, on purpose
 *   Not namespaced per area. There is one Supabase session per browser,
 *   so activity in a patient tab genuinely IS activity by the same human
 *   whose practice tab is idle. A single key also means the STRICTEST tab
 *   wins (because of the `min` above): an idle background tab still ends
 *   the session even though another tab is busy. That is exactly what
 *   today's per-tab timers already do — an idle hidden tab fires its own
 *   logout and takes the session with it — so this preserves current
 *   behaviour rather than quietly changing it.
 */

/** localStorage key. Prefixed like the app's other client-side keys. */
export const LAST_ACTIVITY_STORAGE_KEY = 'hnpl.lastActivityAt';

/**
 * How often activity is written through to storage.
 *
 * Deliberately much coarser than the guard's 250 ms in-memory throttle:
 * scroll and wheel fire continuously, and a synchronous localStorage
 * write per event is real main-thread work for no benefit. The cost of
 * lagging is bounded and always in the safe direction — a stored value up
 * to 5 s stale can only make the session end up to 5 s earlier, never
 * later.
 */
export const ACTIVITY_PERSIST_THROTTLE_MS = 5_000;

/**
 * How far into the future a stored timestamp may sit before we call it
 * tampering rather than clock skew.
 *
 * Real skew is small: NTP corrections move the clock by milliseconds to
 * seconds, and changing timezone doesn't affect `Date.now()` at all. A
 * minute is comfortably above the honest cases and far below anything
 * useful to somebody trying to buy themselves idle time — the smallest
 * worthwhile forgery is minutes, and a minute of tolerance cannot extend
 * a 15-minute window meaningfully.
 *
 * Without this tolerance, a user whose clock stepped backwards by a
 * second between two page loads would be signed out as an attacker.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 60_000;

/**
 * What storage had to say. Three cases, not two — see the header: the
 * split between ABSENT and TAMPERED is what lets absence stay benign
 * while forgery fails closed.
 */
export type StoredActivity =
  | { kind: 'absent' }
  | { kind: 'valid'; atMs: number }
  | { kind: 'tampered' };

const ABSENT: StoredActivity = { kind: 'absent' };

/** localStorage, or null when it isn't reachable at all. */
function storage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  } catch {
    // Access itself throws in some hardened / private-browsing modes.
    return null;
  }
}

/**
 * Classify the persisted timestamp.
 *
 * Every unreachable-storage path returns ABSENT rather than TAMPERED:
 * a browser that won't let us read is a browser configuration, not an
 * attack, and must not cost the user their session.
 */
export function readStoredActivity(nowMs: number): StoredActivity {
  const store = storage();
  if (!store) return ABSENT;

  let raw: string | null;
  try {
    raw = store.getItem(LAST_ACTIVITY_STORAGE_KEY);
  } catch {
    return ABSENT;
  }
  if (raw === null) return ABSENT;

  const parsed = Number(raw);
  // Number('') is 0 and Number('abc') is NaN. Neither is something this
  // module ever wrote, so both are tampering rather than absence.
  if (!Number.isFinite(parsed)) return { kind: 'tampered' };
  if (parsed <= 0) return { kind: 'tampered' };

  if (parsed > nowMs + CLOCK_SKEW_TOLERANCE_MS) return { kind: 'tampered' };
  // Inside the tolerance but still ahead of us: benign skew. Clamp to now
  // rather than trusting it, so it reads as "just active" and no further.
  if (parsed > nowMs) return { kind: 'valid', atMs: nowMs };

  return { kind: 'valid', atMs: parsed };
}

/** Record activity. Best-effort — a failed write just loses the second opinion. */
export function writeStoredActivity(nowMs: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(LAST_ACTIVITY_STORAGE_KEY, String(nowMs));
  } catch {
    // Quota / private mode. Nothing to do; the in-memory timer still runs.
  }
}

/**
 * Drop a timestamp that predates the CURRENT session.
 *
 * ─── THE BUG THIS FIXES ───────────────────────────────────────────────
 *
 * clearStoredActivity() runs in exactly one place — logoutAndRedirect's
 * finally block — and sign-in never seeds the key, by design: the guard
 * deliberately does not write on mount, because that would refresh the
 * very timestamp the persistence exists to preserve.
 *
 * That works only while every session ends through the client-side
 * logout. Several do not:
 *
 *   • the absolute session cap, enforced server-side in proxy.ts, which
 *     redirects without any client code running;
 *   • a cookie or refresh token expiring between visits;
 *   • the browser simply being closed on an open, idle tab.
 *
 * In all of those the key survives. The next person to sign in on that
 * browser — often the same person the next morning — gets
 * effectiveLastActivity() = min(now, yesterday) = yesterday, an elapsed
 * time far past the threshold, and is signed straight back out to
 * /login?reason=inactivity. Signed in, then immediately signed out for
 * being idle, having just typed a password.
 *
 * ─── WHY THIS IS SAFE ─────────────────────────────────────────────────
 *
 * It reads as though it breaks the module's rule that no value writable
 * into this key can lengthen a session. It does not, for two reasons:
 *
 *   • The anchor is not writable. `last_sign_in_at` is set by Supabase
 *     when credentials are actually presented and is not touched on a
 *     token refresh — the same property lib/auth/sessionCap.ts already
 *     depends on for the absolute cap. A refresh therefore cannot use
 *     this to reset the idle clock.
 *   • It grants nothing new even if it were forged. Clearing the key
 *     falls back to the in-memory ref, which is exactly what DELETING
 *     the key already does — named in this file's own list of accepted
 *     limits as indistinguishable from a first sign-in. This adds no
 *     capability an attacker did not already have.
 *
 * Only 'valid' timestamps are discarded. A 'tampered' one is left alone
 * so it keeps failing closed.
 */
export function discardActivityBefore(sessionStartedAtMs: number, nowMs: number): void {
  if (!Number.isFinite(sessionStartedAtMs)) return;
  const stored = readStoredActivity(nowMs);
  if (stored.kind !== 'valid') return;
  if (stored.atMs >= sessionStartedAtMs) return;
  clearStoredActivity();
}

/** Drop the timestamp — called on logout so the next sign-in starts clean. */
export function clearStoredActivity(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(LAST_ACTIVITY_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/**
 * Combine what this tab remembers with what storage claims, yielding the
 * timestamp the guard should measure elapsed time from.
 *
 * The return value is never LATER than `inMemoryMs`, which is the whole
 * adversarial argument in one sentence: elapsed time can only come out
 * the same or larger than the in-memory timer alone would have produced.
 *
 * TAMPERED maps to -Infinity, i.e. "idle since the beginning of time".
 * Expressed as a value rather than as a flag on purpose — the guard's
 * existing `elapsed >= idleMs + warnMs` branch then signs the user out
 * with no new code path to keep in step, and no way for a caller to
 * forget to check.
 */
export function effectiveLastActivity(inMemoryMs: number, stored: StoredActivity): number {
  switch (stored.kind) {
    case 'absent':   return inMemoryMs;
    case 'valid':    return Math.min(inMemoryMs, stored.atMs);
    case 'tampered': return Number.NEGATIVE_INFINITY;
  }
}
