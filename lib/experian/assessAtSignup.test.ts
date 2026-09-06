import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseReturnData, type ExperianConfig, type ExperianOutcome } from './client';
import { bandFor } from './scores';
import {
  decide,
  assessAtSignup,
  __resetInFlightForTests,
  RISK_EXPOSURE_CENTS,
  SCORECARD_PREFERENCE,
  CACHE_TTL_DAYS,
  type Assessment,
  type AssessmentDeps,
} from './assessAtSignup';
import { FIXTURES, ERROR_CODES, soapSuccess } from '@/lib/testing/experianFixtures';
import { VALID_SA_ID } from '@/lib/testing/saIdFixtures';

// ─── Decisioning and orchestration ─────────────────────────────────────
//
// NO NETWORK, NO CREDENTIALS, NOTHING BILLABLE. Every test drives fixtures
// through a mocked global fetch.
//
// Converted from docs/experian/experian.test.ts (node:test), plus the
// orchestration cases the reference could not express because it took its
// dependencies as stubs rather than exercising the guard.

const CFG: ExperianConfig = {
  env: 'uat',
  username: 'test-user',
  password: 'test-pass',
  origin: 'BetterNow',
  pVersion: '4.0',
  timeoutMs: 5_000,
};

const asOk = (json: string): ExperianOutcome => ({
  kind: 'ok',
  latencyMs: 1,
  raw: json,
  ...parseReturnData(json),
});

describe('decide — the real captured payloads', () => {
  it('a credit-active SU file selects SU and bands it', () => {
    const d = decide(asOk(FIXTURES.real_su_credit_active));
    expect(d.scorecard).toBe('SU');
    expect(d.score).toBe(657);
    expect(d.band).toBe(4);
  });

  it('preference order is honoured, not array order', () => {
    // SS appears FIRST in the payload; SU wins because it is first in the
    // preference list. Selecting by array index would pick SS.
    const json = '{"results":[{"resultType":"SS","score":"684","reasons":[]},{"resultType":"SU","score":"640","reasons":[]}]}';
    expect(decide(asOk(json)).scorecard).toBe('SU');
    expect(SCORECARD_PREFERENCE[0]).toBe('SU');
  });

  it('a scorecard outside the preference list refers rather than guessing', () => {
    expect(decide(asOk(FIXTURES.unknown_scorecard)).decision).toBe('referred');
  });

  it('empty results refers', () => {
    expect(decide(asOk(FIXTURES.no_results)).decision).toBe('referred');
  });
});

// ── NAMED TEST (4) ─────────────────────────────────────────────────────
describe('a legacy score of 3 is a thin file, not a very-low score', () => {
  it('has no band and does not produce a risk decline', () => {
    const { results } = parseReturnData(FIXTURES.legacy_thin_file);
    expect(results.every((r) => r.score !== null && r.score > 0)).toBe(true);
    expect(bandFor('NLR', 3), 'a thin file must have no band').toBeNull();

    const d = decide(asOk(FIXTURES.legacy_thin_file));
    // The failure this guards: 3 read as a real score lands in band 1, whose
    // exposure is 0, and the applicant is DECLINED for risk when the truth is
    // that Experian holds no data on them. Wrong decision, wrong §71 reason.
    expect(d.decision).not.toBe('declined');
    expect(d.decision).toBe('referred');
    expect(d.riskExposureCents).toBeNull();
    expect(d.band).toBeNull();
  });
});

// ── NAMED TEST (5) ─────────────────────────────────────────────────────
describe('the pVersion 4.0 Sigma Transcend fallback', () => {
  it('falls through SU → STS and bands on the STS scale, not SU’s', () => {
    const d = decide(asOk(FIXTURES.sts_fallback_after_thin_su));

    // The preference list fell through: SU is present but unusable (-1), so
    // STS is selected on its own without any special-casing.
    expect(d.scorecard).toBe('STS');
    expect(SCORECARD_PREFERENCE).toEqual(['SU', 'SS', 'STS']);

    // Banded on the STS table. This is the discriminator: STS 610 is band 4
    // on the STS bounds (597/602/608/621) and band 1 on SU's (623/637/651/667).
    // Band 1 is the entry decline, so using the wrong table would not merely
    // mis-band — it would DECLINE a consumer the thin-file card scored well.
    expect(d.band).toBe(4);
    expect(bandFor('STS', 610)).toBe(4);
    expect(bandFor('SU', 610)).toBe(1);
    expect(d.decision).not.toBe('declined');
  });

  it('is not referred merely because SU was unusable', () => {
    // With STS band 4 funded, the same payload APPROVES — which proves the
    // referral in the shipped config is about calibration, not about the
    // primary card being thin.
    const before = RISK_EXPOSURE_CENTS.STS[4];
    RISK_EXPOSURE_CENTS.STS[4] = 250_000;
    try {
      const d = decide(asOk(FIXTURES.sts_fallback_after_thin_su));
      expect(d.decision).toBe('approved');
      expect(d.scorecard).toBe('STS');
      expect(d.riskExposureCents).toBe(250_000);
    } finally {
      RISK_EXPOSURE_CENTS.STS[4] = before;
    }
  });

  it('refers on the shipped config, for the calibration reason and not another', () => {
    const d = decide(asOk(FIXTURES.sts_fallback_after_thin_su));
    expect(d.decision).toBe('referred');
    expect(d.detail).toMatch(/no exposure configured for STS band 4/);
    expect(d.reasonCodes).not.toContain('NO_USABLE_SCORECARD');
  });
});

// ── NAMED TEST (5b) ────────────────────────────────────────────────────
describe('a thin file with NO STS card degrades safely', () => {
  it('routes explicitly and keeps WARN-1 plus the diagnostic reason', () => {
    // This is the REAL captured payload: our branch had the 4.0 fallback
    // switched off, so a genuine thin file came back as SU -1 / MI62 with no
    // STS card at all. A configuration regression that switches it off again
    // must degrade to this, not to something that looks like a missing card.
    const d = decide(asOk(FIXTURES.real_su_thin_file));

    expect(d.decision).toBe('referred');
    expect(d.reasonCodes, 'thin-file signal must survive').toContain('WARN-1');
    expect(d.reasonCodes, 'diagnostic reason must survive').toContain('MI62');
    expect(d.detail).not.toBe('no usable scorecard');
    expect(d.reasonCodes).not.toContain('NO_USABLE_SCORECARD');
    expect(d.riskExposureCents).toBeNull();
  });
});

// ── NAMED TEST (6) ─────────────────────────────────────────────────────
describe('an identity flag on one card decides the whole application', () => {
  it('SU -2 alongside SS 690 declines with WARN-2', () => {
    const d = decide(asOk(FIXTURES.mixed_deceased_and_good));
    expect(d.decision).toBe('declined');
    expect(d.reasonCodes).toEqual(['WARN-2']);
    expect(d.riskExposureCents).toBeNull();
    // The good score is NOT used. Deceased is a fact about the person, not a
    // property of one scorecard.
    expect(d.scorecard).toBeNull();
    expect(d.score).toBeNull();
  });

  it.each([
    ['ss_deceased', 'WARN-2'],
    ['ss_sequestrated', 'WARN-3'],
    ['ss_debt_review', 'WARN-4'],
    ['ss_fraud', 'WARN-6'],
  ] as const)('%s hard declines with %s and never bands', (fixture, code) => {
    const d = decide(asOk(FIXTURES[fixture]));
    expect(d.decision).toBe('declined');
    expect(d.reasonCodes).toEqual([code]);
    expect(d.riskExposureCents).toBeNull();
    expect(d.band).toBeNull();
  });
});

// ── NAMED TEST (7) ─────────────────────────────────────────────────────
describe('an unrecognised negative code', () => {
  it('refers and is never banded', () => {
    const d = decide(asOk(FIXTURES.ss_unknown_warning));
    expect(d.decision).toBe('referred');
    expect(d.band).toBeNull();
    expect(d.score).toBeNull();
    expect(d.riskExposureCents).toBeNull();
    // -99 is not in SIGMA_WARNINGS, so it must not be silently treated as a
    // score, and must not be silently treated as a decline either.
    expect(d.decision).not.toBe('approved');
    expect(d.decision).not.toBe('declined');
  });

  it('a bureau dispute refers rather than declines', () => {
    expect(decide(asOk(FIXTURES.ss_bureau_dispute)).decision).toBe('referred');
  });
});

// ── NAMED TEST (9) ─────────────────────────────────────────────────────
describe('the shipped exposure table approves nothing', () => {
  it('every cell is null except band 1, which is zero', () => {
    // Pinned as data, not behaviour. Populating these needs Experian's
    // bad-rate table by band, per scorecard, and it has not been supplied —
    // so a value appearing here is either that work landing deliberately or a
    // number somebody invented, and this test makes it a decision either way.
    for (const [card, bands] of Object.entries(RISK_EXPOSURE_CENTS)) {
      expect(bands[1], `${card} band 1`).toBe(0);
      for (const band of [2, 3, 4, 5] as const) {
        expect(bands[band], `${card} band ${band} must be uncalibrated`).toBeNull();
      }
    }
  });

  it('an uncalibrated band refers, and never approves', () => {
    const d = decide(asOk(FIXTURES.real_ss_minimum_risk));
    expect(d.decision).toBe('referred');
    expect(d.detail).toMatch(/no exposure configured/);
    expect(d.riskExposureCents).toBeNull();
  });

  it('band 1 declines outright — a funded zero is a decision, not a gap', () => {
    expect(decide(asOk(FIXTURES.ss_band1_upper)).decision).toBe('declined');
  });

  it('no scored payload approves under the shipped config', () => {
    // The sweep. Every score across every preference-list card, through the
    // whole decide() path — nothing may come back approved.
    for (const card of SCORECARD_PREFERENCE) {
      for (let score = 480; score <= 750; score += 1) {
        const json = `{"results":[{"resultType":"${card}","score":"${score}","reasons":[]}]}`;
        const d = decide(asOk(json));
        expect(d.decision, `${card} ${score}`).not.toBe('approved');
        expect(d.riskExposureCents === null || d.riskExposureCents === 0, `${card} ${score}`).toBe(true);
      }
    }
  });

  it('approves only once a cell is calibrated', () => {
    const before = RISK_EXPOSURE_CENTS.SS[5];
    RISK_EXPOSURE_CENTS.SS[5] = 500_000;
    try {
      const d = decide(asOk(FIXTURES.real_ss_minimum_risk));
      expect(d.decision).toBe('approved');
      expect(d.riskExposureCents).toBe(500_000);
      expect(d.reasonCodes).toEqual(['TM61', 'TM44']);
    } finally {
      RISK_EXPOSURE_CENTS.SS[5] = before;
    }
  });
});

// ── NAMED TEST (10) ────────────────────────────────────────────────────
describe('every documented error code', () => {
  it('maps to a non-approving decision and invents no exposure', () => {
    expect(ERROR_CODES.length).toBe(11);
    for (const [code, desc] of ERROR_CODES) {
      const kind = code === '-115' ? 'thin_file'
        : ['-113', '-114'].includes(code) ? 'input_error'
        : ['-106', '-999'].includes(code) ? 'provider_error'
        : 'config_error';
      const d = decide({ kind, errorCode: code, errorDescription: desc, latencyMs: 1 } as ExperianOutcome);
      expect(d.decision, `${code} must never approve`).not.toBe('approved');
      expect(d.riskExposureCents, `${code}`).toBeNull();
      expect(d.band, `${code}`).toBeNull();
    }
  });

  it('-115 refers rather than declining — no data is not a bad file', () => {
    const d = decide({ kind: 'thin_file', errorCode: '-115', errorDescription: 'Thin file', latencyMs: 1 });
    expect(d.decision).toBe('referred');
    expect(d.billed, 'an envelope came back, so it billed').toBe(true);
  });

  it('a config error is billed but is never an applicant decision', () => {
    const d = decide({ kind: 'config_error', errorCode: '-107', errorDescription: 'Invalid user details', latencyMs: 1 });
    expect(d.decision).toBe('error');
    expect(d.decision).not.toBe('declined');
  });
});

// ── NAMED TEST (11) ────────────────────────────────────────────────────
describe('a transport failure', () => {
  it('never approves and never invents an exposure', () => {
    const d = decide({ kind: 'transport_error', reason: 'timeout', httpStatus: null, latencyMs: 1 });
    expect(d.decision).toBe('error');
    expect(d.decision).not.toBe('approved');
    expect(d.decision).not.toBe('declined');
    expect(d.riskExposureCents).toBeNull();
    expect(d.band).toBeNull();
    // Unbilled: no envelope came back, so we cannot say it billed. The
    // attempt row is what reconciliation uses.
    expect(d.billed).toBe(false);
  });
});

// ─── Orchestration ─────────────────────────────────────────────────────

const HMAC_KEY = 'jXIQJ/clclWd6qkwBdP97RBEB0ePkRiwBMfh5gm3cJA=';

type Recorder = {
  deps: AssessmentDeps;
  opened: number;
  closed: number;
  fetchMock: ReturnType<typeof vi.fn>;
};

function makeDeps(opts: {
  consent?: boolean;
  cached?: Assessment | null;
  openReturns?: string | null;
  payload?: string;
} = {}): Recorder {
  const rec = { opened: 0, closed: 0 } as Recorder;

  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    text: async () => soapSuccess(opts.payload ?? FIXTURES.real_su_credit_active),
  } as unknown as Response));
  vi.stubGlobal('fetch', fetchMock);

  rec.fetchMock = fetchMock;
  rec.deps = {
    config: CFG,
    hasBureauConsent: async () => opts.consent ?? true,
    findFreshEnquiry: async () => opts.cached ?? null,
    openAttempt: async () => {
      rec.opened += 1;
      return opts.openReturns === undefined ? 'attempt-1' : opts.openReturns;
    },
    closeAttempt: async () => { rec.closed += 1; },
  };
  return rec;
}

describe('assessAtSignup — the money controls', () => {
  beforeEach(() => {
    process.env.SA_ID_LOOKUP_HMAC_KEY = HMAC_KEY;
    __resetInFlightForTests();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetInFlightForTests();
  });

  // ── NAMED TEST (12) — the money test ─────────────────────────────────
  it('concurrent duplicate requests produce exactly ONE billable call', async () => {
    const rec = makeDeps();

    // Fired in the SAME TICK, which is the case a `disabled` flag or an
    // awaited check does not catch: every caller passes the check before any
    // of them has recorded that it started. The guard is entered
    // synchronously, before assessAtSignup's first await, for this reason.
    const N = 8;
    const promises = Array.from({ length: N }, () => assessAtSignup('p1', VALID_SA_ID, rec.deps));
    const results = await Promise.all(promises);

    expect(rec.fetchMock, 'ONE billable call for N concurrent requests').toHaveBeenCalledTimes(1);
    expect(rec.opened, 'one attempt row').toBe(1);
    expect(rec.closed).toBe(1);

    // And every caller gets the same answer, rather than N-1 of them erroring.
    expect(results).toHaveLength(N);
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('a second request AFTER the first settles is a fresh call — the guard is not a cache', () => {
    // Guarding and caching are different jobs: the in-flight map collapses
    // simultaneous callers, findFreshEnquiry is what stops a re-pull. If the
    // map outlived the call it would silently become a cache with no TTL.
    const rec = makeDeps();
    return assessAtSignup('p1', VALID_SA_ID, rec.deps)
      .then(() => assessAtSignup('p1', VALID_SA_ID, rec.deps))
      .then(() => {
        expect(rec.fetchMock).toHaveBeenCalledTimes(2);
      });
  });

  it('different IDs in the same tick are not collapsed into one another', async () => {
    const rec = makeDeps();
    await Promise.all([
      assessAtSignup('p1', '9001015800088', rec.deps),
      assessAtSignup('p2', '8506155001082', rec.deps),
    ]);
    expect(rec.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('the database refusing the in-flight row stops the call, and never approves', async () => {
    // openAttempt returns null when 0148's unique partial index refused us:
    // another serverless invocation is already spending this transaction.
    const rec = makeDeps({ openReturns: null });
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
    expect(out.billed).toBe(false);
    expect(out.riskExposureCents).toBeNull();
    expect(out.detail).toMatch(/already in flight/);
  });

  // ── NAMED TEST (13) ──────────────────────────────────────────────────
  it('makes NO bureau call without a recorded terms acceptance', async () => {
    const rec = makeDeps({ consent: false });
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock, 'the transport must never be invoked').not.toHaveBeenCalled();
    expect(rec.opened, 'and no attempt row is opened either').toBe(0);
    expect(out.decision).toBe('error');
    expect(out.detail).toMatch(/no recorded bureau consent/);
    expect(out.riskExposureCents).toBeNull();
  });

  it('a consent read that FAILS is not consent', async () => {
    const rec = makeDeps();
    rec.deps.hasBureauConsent = async () => { throw new Error('db down'); };
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
  });

  it('an invalid SA ID is refused locally, before anything billable', async () => {
    // -114 "Invalid Id number supplied" is returned AND BILLED. The local
    // checks are the cheapest possible way not to pay for one.
    const rec = makeDeps();
    const out = await assessAtSignup('p1', '9001015800086', rec.deps); // fails Luhn

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(rec.opened).toBe(0);
    expect(out.decision).toBe('error');
    expect(out.detail).toMatch(/local ID validation failed/);
  });

  it('an under-18 ID is refused locally too', async () => {
    const rec = makeDeps();
    // 2015 birth date, valid checksum — a real ID belonging to a minor.
    const minor = '1501014800086';
    const out = await assessAtSignup('p1', minor, rec.deps);

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
  });

  it('a fresh cached enquiry is served without calling, and is marked as cached', async () => {
    const cached: Assessment = {
      decision: 'referred', riskExposureCents: null, scorecard: 'SU', score: 657,
      band: 4, reasonCodes: ['MI39'], detail: 'cached', billed: true, fromCache: false,
    };
    const rec = makeDeps({ cached });
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock, 're-pulling costs money AND damages the score').not.toHaveBeenCalled();
    expect(rec.opened).toBe(0);
    expect(out.fromCache).toBe(true);
    expect(out.decision).toBe('referred');
  });

  it('a cache read FAILURE fails closed rather than paying again', async () => {
    const rec = makeDeps();
    rec.deps.findFreshEnquiry = async () => { throw new Error('db down'); };
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
  });

  it('the TTL is 45 days, and is what the cache is asked for', async () => {
    let askedFor: number | null = null;
    const rec = makeDeps();
    rec.deps.findFreshEnquiry = async (_hash, ttl) => { askedFor = ttl; return null; };
    await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(CACHE_TTL_DAYS).toBe(45);
    expect(askedFor).toBe(45);
  });

  it('the attempt row is opened BEFORE the call, so a timeout leaves evidence', async () => {
    const order: string[] = [];
    const rec = makeDeps();
    rec.deps.openAttempt = async () => { order.push('open'); return 'a1'; };
    vi.stubGlobal('fetch', vi.fn(async () => {
      order.push('call');
      throw new Error('AbortError: timed out');
    }));
    rec.deps.closeAttempt = async () => { order.push('close'); };

    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(order).toEqual(['open', 'call', 'close']);
    expect(out.decision).toBe('error');
    expect(out.billed).toBe(false);
  });

  it('a failed closeAttempt does not discard a decision we already paid for', async () => {
    const rec = makeDeps();
    rec.deps.closeAttempt = async () => { throw new Error('write failed'); };
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    // The call happened and billed. Returning an error here would throw the
    // answer away and invite a retry that pays a second time.
    expect(rec.fetchMock).toHaveBeenCalledTimes(1);
    expect(out.scorecard).toBe('SU');
    expect(out.billed).toBe(true);
  });

  it('a missing HMAC key fails closed instead of calling without a cache key', async () => {
    const rec = makeDeps();
    delete process.env.SA_ID_LOOKUP_HMAC_KEY;
    const out = await assessAtSignup('p1', VALID_SA_ID, rec.deps);

    expect(rec.fetchMock).not.toHaveBeenCalled();
    expect(out.decision).toBe('error');
    expect(out.detail).toMatch(/could not derive ID hash/);
  });
});
