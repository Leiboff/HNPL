import { describe, it, expect, beforeEach } from 'vitest';
import {
  LAST_ACTIVITY_STORAGE_KEY,
  ACTIVITY_PERSIST_THROTTLE_MS,
  CLOCK_SKEW_TOLERANCE_MS,
  readStoredActivity,
  writeStoredActivity,
  clearStoredActivity,
  effectiveLastActivity,
} from './activityStorage';

// ─── The adversarial requirement, proved as arithmetic ───────────────────
//
// The persisted timestamp lives in localStorage, which the user owns
// outright. The claim is therefore not "it cannot be edited" but:
//
//   NO VALUE WRITABLE INTO THE KEY CAN LENGTHEN A SESSION.
//
// Two halves, and the second is the one that's easy to get wrong:
//
//   • A plausible past timestamp is combined via min(), so it can only
//     shorten.
//   • A FORGED FUTURE timestamp must not merely be ignored. Ignoring it
//     falls back to the in-memory ref — and on a fresh mount that ref is
//     `now`, so "ignore" would hand over exactly the full clean window
//     the forger wanted. It has to fail closed instead.
//
// The sweep at the bottom states the property over every input at once.

const NOW = 1_700_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
});

const store = (raw: string) => window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, raw);

describe('classification — absent, valid, tampered', () => {
  it('nothing stored → absent (the normal state on a first sign-in)', () => {
    expect(readStoredActivity(NOW)).toEqual({ kind: 'absent' });
  });

  it('a plain past timestamp → valid', () => {
    store(String(NOW - 60_000));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: NOW - 60_000 });
  });

  it('exactly now → valid', () => {
    store(String(NOW));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: NOW });
  });

  it('a FUTURE timestamp beyond skew tolerance → tampered, not ignored', () => {
    // The loophole this closes. See the file header.
    store(String(NOW + CLOCK_SKEW_TOLERANCE_MS + 1));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'tampered' });
  });

  it('a wildly future timestamp → tampered', () => {
    store(String(NOW + 86_400_000));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'tampered' });
  });

  it.each([
    ['not a number',      'tomorrow'],
    ['an empty string',   ''],
    ['whitespace',        '   '],
    ['Infinity',          'Infinity'],
    ['1e400 (→Infinity)', '1e400'],
    ['NaN',               'NaN'],
    ['zero',              '0'],
    ['a negative number', '-1'],
    ['an object',         '{"t":1}'],
    ['a JS expression',   'Date.now()+1e12'],
  ])('%s → tampered (nothing legitimate writes it)', (_label, raw) => {
    store(raw);
    expect(readStoredActivity(NOW)).toEqual({ kind: 'tampered' });
  });
});

describe('clock skew is tolerated, not punished', () => {
  it('a timestamp slightly ahead is clamped to now rather than rejected', () => {
    // A clock that stepped back a second between two page loads must not
    // look like an attack — it would sign real users out for an NTP tick.
    store(String(NOW + 1_000));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: NOW });
  });

  it('the tolerance boundary is inclusive on the benign side', () => {
    store(String(NOW + CLOCK_SKEW_TOLERANCE_MS));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: NOW });
    store(String(NOW + CLOCK_SKEW_TOLERANCE_MS + 1));
    expect(readStoredActivity(NOW)).toEqual({ kind: 'tampered' });
  });

  it('the tolerance is far too small to be worth forging', () => {
    // It buys at most a minute against a 15-minute window.
    expect(CLOCK_SKEW_TOLERANCE_MS).toBeLessThanOrEqual(60_000);
  });

  it('clamping cannot extend anything either — min() still applies', () => {
    store(String(NOW + 1_000));
    const inMemory = NOW - 10 * 60_000;
    expect(effectiveLastActivity(inMemory, readStoredActivity(NOW))).toBe(inMemory);
  });
});

describe('writing and clearing', () => {
  it('round-trips through storage', () => {
    writeStoredActivity(NOW - 5_000);
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: NOW - 5_000 });
  });

  it('what this module writes is always classified valid — never tampered', () => {
    // Guards against a formatting change (exponent notation, a float)
    // that would make our own writes look like an attack and sign
    // everybody out.
    for (const t of [1, 1_000, NOW - 1, NOW, NOW + 999]) {
      window.localStorage.clear();
      writeStoredActivity(t);
      expect(readStoredActivity(NOW).kind, `wrote ${t}`).toBe('valid');
    }
  });

  it('clearStoredActivity removes the key, leaving ABSENT not TAMPERED', () => {
    // Critical: logout clears the key, and the next sign-in must not be
    // treated as tampering.
    writeStoredActivity(NOW - 5_000);
    clearStoredActivity();
    expect(window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY)).toBeNull();
    expect(readStoredActivity(NOW)).toEqual({ kind: 'absent' });
  });

  it('the write throttle is much coarser than the guard\'s reset throttle', () => {
    // Lagging is only ever safe in the shortening direction, which is why
    // a coarse value is acceptable here.
    expect(ACTIVITY_PERSIST_THROTTLE_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe('effectiveLastActivity', () => {
  it('absent → falls back to memory', () => {
    expect(effectiveLastActivity(NOW, { kind: 'absent' })).toBe(NOW);
  });

  it('valid and OLDER → takes storage. This is the bug being fixed', () => {
    // A reload re-mounts with inMemory = now; storage remembers when the
    // user was last actually present.
    const reloadedAt      = NOW;
    const reallyIdleSince = NOW - 14 * 60 * 60 * 1000;
    expect(effectiveLastActivity(reloadedAt, { kind: 'valid', atMs: reallyIdleSince }))
      .toBe(reallyIdleSince);
  });

  it('valid and NEWER → memory wins, so a fresh timestamp buys nothing', () => {
    const inMemory = NOW - 10 * 60_000;
    expect(effectiveLastActivity(inMemory, { kind: 'valid', atMs: NOW })).toBe(inMemory);
  });

  it('tampered → -Infinity, i.e. infinitely idle', () => {
    // Expressed as a value so the guard's existing logout branch fires
    // with no extra code path to keep in step.
    expect(effectiveLastActivity(NOW, { kind: 'tampered' })).toBe(Number.NEGATIVE_INFINITY);
  });

  it('is min() for every valid pair', () => {
    for (const a of [0, 1, NOW - 1, NOW, NOW + 1, NOW * 2]) {
      for (const b of [0, 1, NOW - 1, NOW, NOW + 1, NOW * 2]) {
        expect(effectiveLastActivity(a, { kind: 'valid', atMs: b })).toBe(Math.min(a, b));
      }
    }
  });
});

describe('ADVERSARIAL: no storable value lengthens a session', () => {
  const CANDIDATES = [
    String(NOW + 1),
    String(NOW + CLOCK_SKEW_TOLERANCE_MS),
    String(NOW + CLOCK_SKEW_TOLERANCE_MS + 1),
    String(NOW + 86_400_000),
    String(Number.MAX_SAFE_INTEGER),
    '9'.repeat(40),
    'Infinity',
    '-Infinity',
    '1e400',
    'NaN',
    '',
    '   ',
    'null',
    'undefined',
    '0',
    '-1',
    'Date.now()+1e12',
    String(NOW),
    String(NOW - 1),
  ];

  it('elapsed time is never smaller than the in-memory timer alone gives', () => {
    // The property, over every candidate. `elapsedFloor` is what the
    // pre-existing timer would have computed with no storage at all; no
    // stored value may reduce it.
    const inMemory     = NOW - 10 * 60_000;
    const elapsedFloor = NOW - inMemory;

    for (const raw of [...CANDIDATES, String(inMemory + 1), String(inMemory - 1)]) {
      window.localStorage.clear();
      store(raw);
      const elapsed = NOW - effectiveLastActivity(inMemory, readStoredActivity(NOW));
      expect(elapsed, `stored=${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(elapsedFloor);
    }
  });

  it('a session already past the threshold cannot be rescued by any write', () => {
    // 20 minutes idle against a 15-minute logout.
    const LOGOUT_AT_MS = 15 * 60_000;
    const inMemory = NOW - 20 * 60_000;

    for (const raw of CANDIDATES) {
      window.localStorage.clear();
      store(raw);
      const elapsed = NOW - effectiveLastActivity(inMemory, readStoredActivity(NOW));
      expect(elapsed, `stored=${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(LOGOUT_AT_MS);
    }
  });

  it('a FRESH MOUNT cannot be handed a clean window by forging the future', () => {
    // The case that motivated the three-way classification, and the one a
    // simple "ignore bad values" implementation gets wrong. After a reload
    // the in-memory ref is `now`, so falling back to it would mean elapsed
    // = 0 — a full fresh window, exactly what the forger wanted.
    const freshMount = NOW;   // remounted after being idle for hours

    for (const raw of [String(NOW + 1e9), String(NOW + 86_400_000), 'Infinity', 'abc', '0']) {
      window.localStorage.clear();
      store(raw);
      const elapsed = NOW - effectiveLastActivity(freshMount, readStoredActivity(NOW));
      expect(elapsed, `stored=${JSON.stringify(raw)}`).toBe(Number.POSITIVE_INFINITY);
    }
  });

  it('THE TWO HONEST LIMITS — recorded, not implied', () => {
    // Both of these get a window measured from mount, i.e. exactly what
    // shipped before this change. Asserted explicitly so nobody reads the
    // sweeps above as a stronger guarantee than they are.
    const freshMount = NOW;

    // (1) Deleting the key. Cannot fail closed: absence is also what a
    //     first sign-in looks like, and what a browser with storage
    //     disabled or partitioned looks like (private-mode Safari, an
    //     evicted origin). Punishing it would lock out real users.
    window.localStorage.clear();
    expect(effectiveLastActivity(freshMount, readStoredActivity(NOW))).toBe(freshMount);

    // (2) Writing exactly the current time. Cannot be told apart from a
    //     legitimate write made at this instant — distinguishing them
    //     needs the value to be authenticated, which needs a secret, which
    //     a browser-only guard cannot hold.
    store(String(NOW));
    expect(effectiveLastActivity(freshMount, readStoredActivity(NOW))).toBe(freshMount);

    // What the classification DOES buy is that the careless attempts fail
    // closed instead — see the sweeps above. And the bound that does not
    // answer to the browser is the absolute session cap
    // (lib/auth/sessionCap.ts), enforced in proxy.ts from Supabase's own
    // last_sign_in_at. Making the idle timeout unforgeable too means
    // moving it server-side, as lib/auth/tillDevice.ts already does for
    // the till.
  });
});
