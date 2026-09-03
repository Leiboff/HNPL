// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseAssuranceMethods,
  assuranceClaimsAgree,
  assuranceIsFresh,
  ASSURANCE_MAX_AGE_MS,
} from './aal';

// ─── The AAL2 guard ────────────────────────────────────────────────────
//
// The pure core is tested directly (parsing, cross-check, freshness);
// the composed requireAAL2 is tested through a controllable mock of the
// Supabase server client + getRequestUser, re-imported per case so the
// per-request memo in getSessionAssurance cannot leak state between cases.
//
// Named tests from the brief that live here:
//   2. aal2 + MFA 6h ago → critical re-challenges, standard passes
//   3. aal2 + MFA 3min ago → critical passes
//   4. forged FUTURE amr timestamp → fail closed (no fallback)
//   5. amr absent entirely → fail closed
//   6. stale aal2 token replay → rejected at critical
//   8. password recovery → aal1 → privileged refused

const SEC = 1000;
const nowMs = () => Date.parse('2026-09-03T12:00:00.000Z');
const secAt = (ms: number) => Math.floor(ms / 1000);

// ─────────────────────────────────────────────────────────────────────
// parseAssuranceMethods — the hostile-input surface
// ─────────────────────────────────────────────────────────────────────

describe('parseAssuranceMethods', () => {
  it('reads a well-formed mfa/totp entry and returns its time', () => {
    const now = nowMs();
    const amr = [
      { method: 'password', timestamp: secAt(now) - 600 },
      { method: 'mfa/totp', timestamp: secAt(now) - 120 },
    ];
    const r = parseAssuranceMethods(amr, now, secAt(now));
    expect(r.malformed).toBeNull();
    expect(r.mfaVerifiedAt?.getTime()).toBe((secAt(now) - 120) * SEC);
  });

  it('accepts the bare "totp" spelling as well as "mfa/totp"', () => {
    const now = nowMs();
    const r = parseAssuranceMethods([{ method: 'totp', timestamp: secAt(now) - 30 }], now, secAt(now));
    expect(r.malformed).toBeNull();
    expect(r.mfaVerifiedAt).not.toBeNull();
  });

  // Named test 5.
  it('[named 5] amr absent (empty / not an array) → amr_absent, no time', () => {
    expect(parseAssuranceMethods([], nowMs(), null).malformed).toBe('amr_absent');
    expect(parseAssuranceMethods(undefined, nowMs(), null).malformed).toBe('amr_absent');
    expect(parseAssuranceMethods('totp', nowMs(), null).malformed).toBe('amr_absent');
  });

  it('the RFC-8176 string[] form carries no timestamp → amr_untimestamped', () => {
    const r = parseAssuranceMethods(['password', 'totp'], nowMs(), null);
    expect(r.malformed).toBe('amr_untimestamped');
    expect(r.mfaVerifiedAt).toBeNull();
  });

  // Named test 4 — the one the session-lifetime work self-caught.
  it('[named 4] a FUTURE mfa timestamp fails closed, never clamps to now', () => {
    const now = nowMs();
    const r = parseAssuranceMethods(
      [{ method: 'mfa/totp', timestamp: secAt(now) + 3600 }],
      now,
      secAt(now),
    );
    expect(r.malformed).toBe('mfa_timestamp_future');
    expect(r.mfaVerifiedAt).toBeNull();
  });

  it('[named 4b] a timestamp later than the token iat is future in the token domain too', () => {
    const now = nowMs();
    // Not future vs wall clock, but issued after the token — impossible.
    const r = parseAssuranceMethods(
      [{ method: 'mfa/totp', timestamp: secAt(now) - 10 }],
      now,
      secAt(now) - 60, // token issued 60s ago; amr claims 10s ago
    );
    expect(r.malformed).toBe('mfa_timestamp_future');
  });

  it('a missing / non-numeric mfa timestamp fails closed', () => {
    const now = nowMs();
    expect(parseAssuranceMethods([{ method: 'mfa/totp' }], now, secAt(now)).malformed)
      .toBe('mfa_timestamp_missing');
    expect(parseAssuranceMethods([{ method: 'mfa/totp', timestamp: 'soon' }], now, secAt(now)).malformed)
      .toBe('mfa_timestamp_malformed');
  });

  it('a junk timestamp on a FIRST factor is ignored (only mfa recency matters)', () => {
    const now = nowMs();
    const r = parseAssuranceMethods(
      [{ method: 'password', timestamp: 'nonsense' }, { method: 'mfa/totp', timestamp: secAt(now) - 5 }],
      now, secAt(now),
    );
    expect(r.malformed).toBeNull();
    expect(r.mfaVerifiedAt).not.toBeNull();
  });

  it('an aal1-shaped amr (first factor only) is not a malformation', () => {
    const now = nowMs();
    const r = parseAssuranceMethods([{ method: 'password', timestamp: secAt(now) }], now, secAt(now));
    expect(r.malformed).toBeNull();
    expect(r.mfaVerifiedAt).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// assuranceClaimsAgree — the verified-vs-unverified cross-check
// ─────────────────────────────────────────────────────────────────────

describe('assuranceClaimsAgree (step 4 cross-check)', () => {
  it('agrees when level and method names match', () => {
    expect(assuranceClaimsAgree(
      'aal2', [{ method: 'password', timestamp: 1 }, { method: 'mfa/totp', timestamp: 2 }],
      'aal2', [{ method: 'mfa/totp', timestamp: 2 }, { method: 'password', timestamp: 1 }],
    )).toBe(true);
  });

  it('disagrees when the level differs (forged aal in the unverified decode)', () => {
    expect(assuranceClaimsAgree('aal2', [], 'aal1', [])).toBe(false);
  });

  it('disagrees when the method sets differ', () => {
    expect(assuranceClaimsAgree(
      'aal2', [{ method: 'mfa/totp', timestamp: 2 }],
      'aal2', [{ method: 'password', timestamp: 1 }],
    )).toBe(false);
  });

  it('handles the string[] amr form on either side', () => {
    expect(assuranceClaimsAgree('aal2', ['totp'], 'aal2', ['totp'])).toBe(true);
    expect(assuranceClaimsAgree('aal2', ['totp'], 'aal2', ['password'])).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// assuranceIsFresh — the two windows (named tests 2, 3, 6)
// ─────────────────────────────────────────────────────────────────────

describe('assuranceIsFresh', () => {
  it('null presentation is never fresh, at any tier', () => {
    expect(assuranceIsFresh(null, nowMs(), 'standard')).toBe(false);
    expect(assuranceIsFresh(null, nowMs(), 'critical')).toBe(false);
  });

  // Named test 2.
  it('[named 2] MFA 6 hours ago: standard PASSES, critical FAILS', () => {
    const now = nowMs();
    const sixHoursAgo = new Date(now - 6 * 60 * 60 * SEC);
    expect(assuranceIsFresh(sixHoursAgo, now, 'standard')).toBe(true);
    expect(assuranceIsFresh(sixHoursAgo, now, 'critical')).toBe(false);
  });

  // Named test 3.
  it('[named 3] MFA 3 minutes ago: critical PASSES', () => {
    const now = nowMs();
    const threeMinAgo = new Date(now - 3 * 60 * SEC);
    expect(assuranceIsFresh(threeMinAgo, now, 'critical')).toBe(true);
    expect(assuranceIsFresh(threeMinAgo, now, 'standard')).toBe(true);
  });

  // Named test 6 (freshness half — the replay is rejected by age, not level).
  it('[named 6] a 9-hour-old presentation fails BOTH tiers (the enrol-once hole)', () => {
    const now = nowMs();
    const old = new Date(now - 9 * 60 * 60 * SEC);
    expect(assuranceIsFresh(old, now, 'standard')).toBe(false);
    expect(assuranceIsFresh(old, now, 'critical')).toBe(false);
  });

  it('the window boundaries are exactly 8h / 5min', () => {
    expect(ASSURANCE_MAX_AGE_MS.standard).toBe(8 * 60 * 60 * 1000);
    expect(ASSURANCE_MAX_AGE_MS.critical).toBe(5 * 60 * 1000);
  });

  it('a future presentation is not fresh even if the parser let it through', () => {
    const now = nowMs();
    expect(assuranceIsFresh(new Date(now + 1000), now, 'standard')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// requireAAL2 — the composed guard (identity → verified claims →
// library AAL → cross-check → freshness). Re-imported per case.
// ─────────────────────────────────────────────────────────────────────

type MockShape = {
  userId:        string | null;
  claimsAal:     unknown;
  claimsAmr:     unknown;
  claimsSub?:    string;
  claimsIat?:    number;
  mfaLevel:      unknown;
  mfaMethods:    unknown;
  mfaNext:       unknown;
  getClaimsThrows?: boolean;
};

async function loadGuardWith(shape: MockShape) {
  vi.resetModules();

  vi.doMock('./requestUser', () => ({
    getRequestUser: async () =>
      shape.userId
        ? { id: shape.userId, email: 'a@b.co', email_confirmed_at: '2026-01-01T00:00:00Z', identities: [] }
        : null,
  }));

  vi.doMock('@/lib/supabase/server', () => ({
    createClient: async () => ({
      auth: {
        getUser: async () => ({ data: { user: shape.userId ? { id: shape.userId } : null }, error: null }),
        getClaims: async () => {
          if (shape.getClaimsThrows) throw new Error('verify failed');
          return {
            data: {
              claims: {
                sub: shape.claimsSub ?? shape.userId,
                aal: shape.claimsAal,
                amr: shape.claimsAmr,
                iat: shape.claimsIat,
              },
            },
            error: null,
          };
        },
        mfa: {
          getAuthenticatorAssuranceLevel: async () => ({
            data: {
              currentLevel: shape.mfaLevel,
              currentAuthenticationMethods: shape.mfaMethods,
              nextLevel: shape.mfaNext,
            },
            error: null,
          }),
        },
      },
    }),
  }));

  return import('./aal');
}

const nowSec = () => secAt(Date.now());

function amr(methods: Array<{ method: string; ageSec: number }>) {
  const base = nowSec();
  return methods.map((m) => ({ method: m.method, timestamp: base - m.ageSec }));
}

describe('requireAAL2 (composed)', () => {
  beforeEach(() => { vi.resetModules(); });

  it('aal2 + fresh mfa → ok at both tiers', async () => {
    const a = amr([{ method: 'password', ageSec: 60 }, { method: 'mfa/totp', ageSec: 60 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal2', claimsAmr: a, claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: a, mfaNext: 'aal2',
    });
    expect((await requireAAL2('standard')).ok).toBe(true);
    expect((await requireAAL2('critical')).ok).toBe(true);
  });

  it('[named 8] aal1 session (e.g. after password recovery) → refused, canEnrol reflects factor', async () => {
    const a = amr([{ method: 'recovery', ageSec: 5 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal1', claimsAmr: a, claimsIat: nowSec(),
      mfaLevel: 'aal1', mfaMethods: a, mfaNext: 'aal2', // has a verified factor but session is aal1
    });
    const r = await requireAAL2('standard');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe('aal1');
      if (r.refusal.kind === 'aal1') expect(r.refusal.canEnrol).toBe(true);
    }
  });

  it('aal1 with NO verified factor → refused, canEnrol false (forced enrolment)', async () => {
    const a = amr([{ method: 'password', ageSec: 5 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal1', claimsAmr: a, claimsIat: nowSec(),
      mfaLevel: 'aal1', mfaMethods: a, mfaNext: 'aal1',
    });
    const r = await requireAAL2('standard');
    if (!r.ok && r.refusal.kind === 'aal1') expect(r.refusal.canEnrol).toBe(false);
    else throw new Error('expected aal1 refusal');
  });

  it('[named 6] aal2 but mfa 6h old → critical STALE, standard ok', async () => {
    const a = amr([{ method: 'password', ageSec: 6 * 3600 }, { method: 'mfa/totp', ageSec: 6 * 3600 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal2', claimsAmr: a, claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: a, mfaNext: 'aal2',
    });
    expect((await requireAAL2('standard')).ok).toBe(true);
    const crit = await requireAAL2('critical');
    expect(crit.ok).toBe(false);
    if (!crit.ok) expect(crit.refusal.kind).toBe('stale');
  });

  it('[named 4] forged FUTURE mfa timestamp → malformed refusal, not a lenient pass', async () => {
    const base = nowSec();
    const a = [{ method: 'mfa/totp', timestamp: base + 3600 }];
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal2', claimsAmr: a, claimsIat: base,
      mfaLevel: 'aal2', mfaMethods: a, mfaNext: 'aal2',
    });
    const r = await requireAAL2('standard');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe('malformed');
      if (r.refusal.kind === 'malformed') expect(r.refusal.malformation).toBe('mfa_timestamp_future');
    }
  });

  it('[named 5] amr absent on an aal2 level → refused (self-contradiction)', async () => {
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal2', claimsAmr: undefined, claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: undefined, mfaNext: 'aal2',
    });
    const r = await requireAAL2('critical');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe('malformed');
  });

  it('[cross-check] verified aal disagrees with library aal → refused', async () => {
    // The forged case the library call cannot catch alone: the unverified
    // decode says aal2, the VERIFIED claims say aal1.
    const a = amr([{ method: 'mfa/totp', ageSec: 30 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal1', claimsAmr: [{ method: 'password', timestamp: nowSec() }],
      claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: a, mfaNext: 'aal2',
    });
    const r = await requireAAL2('critical');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.refusal.kind).toBe('malformed');
      if (r.refusal.kind === 'malformed') expect(r.refusal.malformation).toBe('claims_mismatch');
    }
  });

  it('[cross-check] claims.sub not matching the validated user → refused', async () => {
    const a = amr([{ method: 'mfa/totp', ageSec: 30 }]);
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsSub: 'someone-else', claimsAal: 'aal2', claimsAmr: a, claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: a, mfaNext: 'aal2',
    });
    const r = await requireAAL2('standard');
    expect(r.ok).toBe(false);
  });

  it('no session → unauthenticated refusal', async () => {
    const { requireAAL2 } = await loadGuardWith({
      userId: null, claimsAal: 'aal1', claimsAmr: [], mfaLevel: 'aal1', mfaMethods: [], mfaNext: 'aal1',
    });
    const r = await requireAAL2('standard');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.refusal.kind).toBe('unauthenticated');
  });

  it('getClaims throwing (unverifiable token) → refused, never opens', async () => {
    const { requireAAL2 } = await loadGuardWith({
      userId: 'admin-1', claimsAal: 'aal2', claimsAmr: [], claimsIat: nowSec(),
      mfaLevel: 'aal2', mfaMethods: [], mfaNext: 'aal2', getClaimsThrows: true,
    });
    const r = await requireAAL2('critical');
    expect(r.ok).toBe(false);
  });
});
