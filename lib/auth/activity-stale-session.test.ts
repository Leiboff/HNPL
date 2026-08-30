import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  discardActivityBefore,
  readStoredActivity,
  writeStoredActivity,
  LAST_ACTIVITY_STORAGE_KEY,
} from './activityStorage';

// ─── Signed in, then immediately signed out for inactivity ─────────────
//
// THE BUG, as reported: sign in, land in the app, get bounced straight to
// /login?reason=inactivity having just typed a password.
//
// THE CAUSE. clearStoredActivity() runs in exactly one place —
// logoutAndRedirect's finally block — and sign-in never seeds the key,
// deliberately (the guard must not write on mount, or the reload it
// exists to detect would refresh the timestamp on the way in).
//
// That holds only while every session ends through the client-side
// logout. These do not:
//
//   • the absolute session cap, enforced server-side in proxy.ts, which
//     redirects with no client code running at all;
//   • a cookie or refresh token expiring between visits;
//   • the browser being closed on an open, idle tab — the common one.
//
// The key survives, and the next sign-in computes
// effectiveLastActivity() = min(now, yesterday) = yesterday. Elapsed is
// then hours or days, far past the threshold, and the guard signs the
// user out on its first tick.
//
// THE FIX. The guard receives the session's sign-in time as a prop from
// the server layout that mounts it, and discards any persisted activity
// older than it: activity recorded before this session began is not
// activity in this session.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const MINUTE = 60_000;
const NOW    = 1_800_000_000_000;

beforeEach(() => {
  window.localStorage.clear();
});

describe('the reported failure, reproduced', () => {
  it('a timestamp from a previous session survives and would expire the new one', () => {
    // Yesterday's session, ended by closing the browser rather than
    // signing out — so nothing cleared the key.
    const yesterday = NOW - 20 * 60 * MINUTE;
    writeStoredActivity(yesterday);

    // Without reconciliation the guard reads yesterday and, combined with
    // its fresh in-memory ref via Math.min, measures elapsed from then.
    const before = readStoredActivity(NOW);
    expect(before).toEqual({ kind: 'valid', atMs: yesterday });

    // Signing in now discards it.
    discardActivityBefore(NOW, NOW);
    expect(readStoredActivity(NOW)).toEqual({ kind: 'absent' });
  });

  it('activity from WITHIN this session is kept — the timeout still works', () => {
    // The whole point of the persisted value: a reload must not mint a
    // fresh idle window. Reconciliation must not become a way to do that.
    const signedInAt = NOW - 30 * MINUTE;
    const activeAt   = NOW - 20 * MINUTE;   // after sign-in, still idle 20 min
    writeStoredActivity(activeAt);

    discardActivityBefore(signedInAt, NOW);
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: activeAt });
  });

  it('a tampered value is left alone, so it keeps failing closed', () => {
    // 'tampered' maps to -Infinity in effectiveLastActivity, i.e. sign
    // out. Clearing it here would convert a forged value into a fresh
    // window — the exact loophole activityStorage's three-way split
    // exists to close.
    window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(NOW + 60 * MINUTE));
    expect(readStoredActivity(NOW).kind).toBe('tampered');

    discardActivityBefore(NOW, NOW);
    expect(readStoredActivity(NOW).kind).toBe('tampered');
  });

  it('an absent or unparseable anchor changes nothing', () => {
    // A layout that cannot supply last_sign_in_at must leave the stored
    // value exactly as it was — the safe direction, since the session can
    // then only end early, never run long.
    const activeAt = NOW - 3 * MINUTE;
    writeStoredActivity(activeAt);
    discardActivityBefore(Number.NaN, NOW);
    expect(readStoredActivity(NOW)).toEqual({ kind: 'valid', atMs: activeAt });
  });
});

describe('every mount site supplies the anchor', () => {
  // The prop is optional so the guard still renders without it. That
  // makes a layout quietly dropping it invisible — and dropping it
  // restores the bug in full. So the mount sites are enumerated.
  // SIX, not the three I first wrote. provider, admin and crm mount the
  // guard too, and an incomplete list here would have left those areas
  // with the bug while the test reported success — the failure mode this
  // block exists to prevent, nearly shipped inside the block itself.
  const LAYOUTS = [
    'app/patient/layout.tsx',
    'app/practice/layout.tsx',
    'app/brand/layout.tsx',
    'app/provider/layout.tsx',
    'app/admin/layout.tsx',
    'app/crm/layout.tsx',
  ];

  it('is the complete list of layouts mounting the guard', () => {
    // If a fourth authenticated area appears, this fails and whoever adds
    // it has to decide about the anchor rather than inherit the bug.
    const mounts = LAYOUTS.filter((p) => read(p).includes('<InactivityGuard'));
    expect(mounts).toEqual(LAYOUTS);
  });

  it('each passes sessionStartedAt from the server-read user', () => {
    for (const p of LAYOUTS) {
      const src = read(p);
      expect(src).toMatch(/sessionStartedAt=\{Date\.parse\(/);
      expect(src).toMatch(/last_sign_in_at/);
    }
  });
});

describe('the guard stays a timer, not an auth client', () => {
  it('still imports no Supabase — the anchor arrives as a prop', () => {
    // lib/auth/inactivity-lightmode.test.ts pins this boundary too. It is
    // restated here because THIS change is the one that would have
    // breached it: reading last_sign_in_at from a client session inside
    // the guard was the obvious fix and the wrong one. A server-read
    // value is also one the browser cannot influence.
    const GUARD = read('lib/auth/InactivityGuard.tsx');
    expect(GUARD).not.toMatch(/from\s+['"]@\/lib\/supabase/);
    expect(GUARD).toMatch(/discardActivityBefore/);
    expect(GUARD).toMatch(/sessionStartedAt/);
  });
});
