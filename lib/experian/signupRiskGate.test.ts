import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseReturnData, type ExperianOutcome } from './client';
import { decide, type Assessment } from './assessAtSignup';
import { bandFor, type RiskBand } from './scores';
import {
  signupRiskGate,
  MIN_BAND_PRIMARY,
  MIN_BAND_THIN_FILE,
  THIN_FILE_EFFECTIVE_BAND,
  THIN_FILE_SCORECARD,
} from './signupRiskGate';
import { FIXTURES } from '@/lib/testing/experianFixtures';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The signup risk gate ──────────────────────────────────────────────
//
// The policy: average risk or better on a primary card; LOW risk or better
// on the thin-file fallback, and capped at average when it passes.
//
// The single most important property in this file is that the gate reads
// the BAND and not the DECISION. With the shipped (uncalibrated) exposure
// table every scored file comes back `referred`, so a gate that read
// `decision` would refuse the entire book including its best files.

const asOk = (json: string): ExperianOutcome => ({
  kind: 'ok', latencyMs: 1, raw: json, ...parseReturnData(json),
});

const card = (type: string, score: number): Assessment =>
  decide(asOk(`{"results":[{"resultType":"${type}","score":"${score}","reasons":[]}]}`));

describe('a scored primary card passes at average risk or better', () => {
  // SU bounds are 623 / 637 / 651 / 667.
  it.each([
    [630, 2 as RiskBand, false],
    [645, 3 as RiskBand, true],
    [660, 4 as RiskBand, true],
    [700, 5 as RiskBand, true],
  ])('SU %i is band %i → proceed %s', (score, band, proceed) => {
    expect(bandFor('SU', score), 'fixture sanity').toBe(band);
    const g = signupRiskGate(card('SU', score));
    expect(g.proceed).toBe(proceed);
    expect(g.outcome).toBe(proceed ? 'pass' : 'refuse');
  });

  it('passes at its OWN band, not a flattened one', () => {
    expect(signupRiskGate(card('SU', 660)).effectiveBand).toBe(4);
    expect(signupRiskGate(card('SU', 700)).effectiveBand).toBe(5);
    expect(signupRiskGate(card('SU', 645)).effectiveBand).toBe(3);
  });

  it('band 1 never proceeds, even though its exposure is calibrated', () => {
    // Band 1's exposure is 0, so decide() returns `declined` rather than
    // `referred`. Both routes must refuse, and the gate refuses on the
    // decision before it ever looks at the band.
    const d = decide(asOk(FIXTURES.ss_band1_upper));
    expect(d.decision).toBe('declined');
    const g = signupRiskGate(d);
    expect(g.proceed).toBe(false);
    expect(g.reason).toBe('bureau_declined');
  });

  it('the real captured payloads pass', () => {
    const su = signupRiskGate(decide(asOk(FIXTURES.real_su_credit_active)));
    expect(su.proceed).toBe(true);
    expect(su.effectiveBand).toBe(4);

    const ss = signupRiskGate(decide(asOk(FIXTURES.real_ss_minimum_risk)));
    expect(ss.proceed).toBe(true);
    expect(ss.effectiveBand).toBe(5);
  });
});

describe('the thin-file fallback is judged on a stricter bar and capped', () => {
  // STS bounds are 597 / 602 / 608 / 621.
  it.each([
    [600, 2 as RiskBand, false],
    [605, 3 as RiskBand, false],
    [615, 4 as RiskBand, true],
    [630, 5 as RiskBand, true],
  ])('STS %i is band %i → proceed %s', (score, band, proceed) => {
    expect(bandFor('STS', score), 'fixture sanity').toBe(band);
    const g = signupRiskGate(card('STS', score));
    expect(g.proceed).toBe(proceed);
  });

  it('band 3 on STS is refused where band 3 on SU passes', () => {
    // The asymmetry, stated as one assertion. Average risk is good enough on
    // a full file and not good enough on four months of history.
    expect(signupRiskGate(card('SU', 645)).effectiveBand).toBe(3);
    expect(signupRiskGate(card('STS', 605)).proceed).toBe(false);
    expect(MIN_BAND_THIN_FILE).toBeGreaterThan(MIN_BAND_PRIMARY);
  });

  it('a passing thin file is recorded as AVERAGE, whatever STS said', () => {
    // Both band 4 and band 5 collapse to 3. A short history buys entry to
    // the product and nothing more.
    for (const score of [615, 630]) {
      const g = signupRiskGate(card('STS', score));
      expect(g.proceed, `STS ${score}`).toBe(true);
      expect(g.effectiveBand, `STS ${score}`).toBe(THIN_FILE_EFFECTIVE_BAND);
      expect(g.effectiveBand).toBe(3);
      expect(g.thinFileFallback).toBe(true);
    }
  });

  it('the effective band never exceeds average on the thin-file card', () => {
    for (let score = 480; score <= 750; score++) {
      const g = signupRiskGate(card('STS', score));
      if (g.proceed) expect(g.effectiveBand, `STS ${score}`).toBe(THIN_FILE_EFFECTIVE_BAND);
    }
  });

  it('the real fallback payload falls SU → STS and passes at average', () => {
    // SU came back -1 (thin), STS scored 610. The preference list falls
    // through on its own; the gate then bands it on the STS bar.
    const d = decide(asOk(FIXTURES.sts_fallback_after_thin_su));
    expect(d.scorecard).toBe('STS');

    const g = signupRiskGate(d);
    expect(g.proceed).toBe(true);
    expect(g.thinFileFallback).toBe(true);
    expect(g.effectiveBand).toBe(3);

    // The discriminator: 610 is band 4 on STS and band 1 on SU. Had the gate
    // used the primary table, this applicant would have been REFUSED at the
    // entry decline rather than admitted at average.
    expect(bandFor(THIN_FILE_SCORECARD, 610)).toBe(4);
    expect(bandFor('SU', 610)).toBe(1);
  });
});

describe('an answer with nothing to score refuses', () => {
  it('a real thin file with NO STS card does not proceed', () => {
    // The captured payload from when the fallback was switched off on our
    // branch: SU -1, reason MI62, no STS beside it. Nothing to score is not
    // evidence of average risk.
    const d = decide(asOk(FIXTURES.real_su_thin_file));
    const g = signupRiskGate(d);
    expect(g.proceed).toBe(false);
    expect(g.outcome).toBe('refuse');
    expect(g.reason).toBe('no_usable_band');
  });

  it('a legacy thin file (score 3) does not proceed, and is not a risk decline', () => {
    const g = signupRiskGate(decide(asOk(FIXTURES.legacy_thin_file)));
    expect(g.proceed).toBe(false);
    expect(g.reason).toBe('no_usable_band');
    expect(g.reason).not.toBe('bureau_declined');
  });

  it('an unrecognised scorecard refuses rather than guessing a bar', () => {
    const g = signupRiskGate(decide(asOk(FIXTURES.unknown_scorecard)));
    expect(g.proceed).toBe(false);
    expect(g.effectiveBand).toBeNull();
  });

  it('an empty result set refuses', () => {
    expect(signupRiskGate(decide(asOk(FIXTURES.no_results))).proceed).toBe(false);
  });

  it('a bureau dispute refuses — it is a referral, not a clearance', () => {
    expect(signupRiskGate(decide(asOk(FIXTURES.ss_bureau_dispute))).proceed).toBe(false);
  });

  it.each([
    ['ss_deceased'], ['ss_sequestrated'], ['ss_debt_review'], ['ss_fraud'],
  ] as const)('%s refuses and records no band', (fixture) => {
    const g = signupRiskGate(decide(asOk(FIXTURES[fixture])));
    expect(g.proceed).toBe(false);
    expect(g.reason).toBe('bureau_declined');
    expect(g.effectiveBand).toBeNull();
  });

  it('one identity flag decides it, even beside a good score on another card', () => {
    const g = signupRiskGate(decide(asOk(FIXTURES.mixed_deceased_and_good)));
    expect(g.proceed).toBe(false);
    expect(g.reason).toBe('bureau_declined');
  });
});

describe('no score, no onboarding — but an outage is not a refusal', () => {
  it('a transport failure stops the applicant', () => {
    // Product decision: an applicant we could not assess does not continue
    // to the identity vendors. Spending at DHA and Didit on someone we have
    // no risk opinion about is the thing this ordering exists to avoid.
    const g = signupRiskGate(decide({
      kind: 'transport_error', reason: 'timeout', httpStatus: null, latencyMs: 1,
    }));
    expect(g.proceed).toBe(false);
    expect(g.effectiveBand).toBeNull();
  });

  it('but it is reported as UNAVAILABLE, never as a refusal', () => {
    // The distinction the return type exists for, and it survives the
    // decision to stop them: the door is shut either way, and only one of
    // the two is a fact about the person. The caller reads this field to
    // decide whether to say "try again later" or "contact support", and
    // collapsing the two would record our outage against their name.
    const g = signupRiskGate(decide({
      kind: 'transport_error', reason: 'timeout', httpStatus: null, latencyMs: 1,
    }));
    expect(g.outcome).toBe('unavailable');
    expect(g.outcome).not.toBe('refuse');
    expect(g.reason).toBe('bureau_unavailable');
  });

  it.each([
    ['config_error', '-107'],
    ['provider_error', '-999'],
    ['input_error', '-114'],
  ] as const)('%s is unavailable, not a refusal, and does not proceed', (kind, code) => {
    const g = signupRiskGate(decide({
      kind, errorCode: code, errorDescription: 'x', latencyMs: 1,
    } as ExperianOutcome));
    expect(g.outcome).toBe('unavailable');
    expect(g.proceed).toBe(false);
    expect(g.effectiveBand).toBeNull();
  });

  it('ONLY a pass ever proceeds', () => {
    // The invariant, stated once. Every construction of a decision that is
    // not a pass must have proceed false.
    const notPasses = [
      decide({ kind: 'transport_error', reason: 'x', httpStatus: null, latencyMs: 1 }),
      decide({ kind: 'config_error', errorCode: '-107', errorDescription: 'x', latencyMs: 1 }),
      decide({ kind: 'thin_file', errorCode: '-115', errorDescription: 'x', latencyMs: 1 }),
      decide(asOk(FIXTURES.real_su_thin_file)),
      decide(asOk(FIXTURES.mixed_deceased_and_good)),
      decide(asOk(FIXTURES.no_results)),
      card('SU', 630),
      card('STS', 605),
    ];
    for (const a of notPasses) {
      const g = signupRiskGate(a);
      expect(g.proceed, g.reason).toBe(g.outcome === 'pass');
      expect(g.proceed, g.reason).toBe(false);
    }
  });

  it('but a -115 thin file IS an answer, and refuses', () => {
    // Experian replied and said there is no data. That is a fact about the
    // file, not a fault on our side.
    const g = signupRiskGate(decide({
      kind: 'thin_file', errorCode: '-115', errorDescription: 'Thin file', latencyMs: 1,
    }));
    expect(g.outcome).toBe('refuse');
    expect(g.proceed).toBe(false);
  });

  it('no outcome ever yields a band without proceeding, or proceeds with a band below the bar', () => {
    // The invariant sweep, across every scorecard and every score.
    for (const type of ['SU', 'SS', 'STS']) {
      for (let score = 480; score <= 750; score++) {
        const g = signupRiskGate(card(type, score));
        if (g.effectiveBand !== null) {
          expect(g.proceed, `${type} ${score}`).toBe(true);
          expect(g.effectiveBand, `${type} ${score}`).toBeGreaterThanOrEqual(MIN_BAND_PRIMARY);
        }
      }
    }
  });
});

describe('the gate reads the BAND, not the decision', () => {
  it('passes files that decide() calls "referred" for want of calibration', () => {
    // The bug this prevents, and it would have been catastrophic and silent:
    // every exposure cell is null today, so a minimum-risk band-5 file comes
    // back `referred`. A gate written against `decision` would have refused
    // every applicant on the platform and looked like a working credit policy.
    const d = decide(asOk(FIXTURES.real_ss_minimum_risk));
    expect(d.decision, 'uncalibrated, so referred').toBe('referred');
    expect(d.band).toBe(5);

    expect(signupRiskGate(d).proceed, 'but the BAND is minimum risk').toBe(true);
  });
});

describe('where the gate sits in the identity step', () => {
  const ACTIONS = stripComments(
    readFileSync(resolve(process.cwd(), 'lib/onboarding/actions.ts'), 'utf8').replace(/\r\n/g, '\n'),
    { preserveUrls: true },
  );

  it('runs BEFORE either paid identity vendor', () => {
    // The whole point of the placement: a refusal costs one Experian call
    // instead of a DHA registry lookup plus a Didit face-match session.
    const gate = ACTIONS.indexOf('runSignupBureauGate(cleanedId, loaded)');
    const dha = ACTIONS.indexOf('resolveIdentityRouteForProvider(cleanedId');
    expect(gate, 'the gate call must exist').toBeGreaterThan(-1);
    expect(dha, 'the DHA route call must exist').toBeGreaterThan(-1);
    expect(gate, 'gate must precede the DHA lookup').toBeLessThan(dha);
  });

  it('runs after free local checks, before the paid KYC budget', () => {
    // Order is load-bearing in the other direction too: an invalid or
    // under-18 ID, or an ID already on the platform, is refused for free
    // rather than for the price of a bureau enquiry.
    const validate = ACTIONS.indexOf('validateSaId(cleanedId)');
    const risk = ACTIONS.indexOf("event:        'kyc_session'");
    const gate = ACTIONS.indexOf('runSignupBureauGate(cleanedId, loaded)');
    expect(validate).toBeLessThan(gate);
    expect(risk).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(risk);
  });

  it('is skipped entirely when Experian is unconfigured', () => {
    // Production today. No call, no rate-limit spend, no behaviour change.
    expect(ACTIONS).toMatch(/if \(experianConfigured\(\)\) \{\s*const gate = await runSignupBureauGate/);
  });

  it('is keyed on the ID hash, not only the account', () => {
    expect(ACTIONS).toMatch(/consumeAll\('bureau_enquiry'/);
    expect(ACTIONS).toMatch(/\[idHash,\s+RATE_LIMITS\.bureau_enquiry\.account!\]/);
  });

  it('charges the bureau risk budget before the enquiry', () => {
    const bureauBudget = ACTIONS.indexOf("event: 'credit_check'");
    const assessment = ACTIONS.indexOf('assessment = await assessAtSignup');
    expect(bureauBudget).toBeGreaterThan(-1);
    expect(bureauBudget).toBeLessThan(assessment);
  });

  it('persists the gate outcome and effective band', () => {
    expect(ACTIONS).toMatch(/persistSignupGate\(svc\(\), assessment\.attemptId, gate\)/);
  });

  it('answers a refusal with fixed copy that names no reason', () => {
    expect(ACTIONS).toMatch(/const REFUSAL = 'We\\'re unable to continue with your application at this time\. Please contact support\.'/);
    expect(ACTIONS).not.toMatch(/error:\s*gate\.reason/);
    expect(ACTIONS).not.toMatch(/error:\s*`[^`]*\$\{gate\.reason\}/);
  });

  it('answers an OUTAGE with different copy — transient, and not "contact support"', () => {
    // Two sentences, two meanings. Telling someone to contact support when
    // we simply could not reach the bureau is wrong twice: it implies a
    // decision was made about them, and it sends them to a queue that
    // cannot help. Pinned so the two never collapse into one string.
    expect(ACTIONS).toMatch(/const UNAVAILABLE = 'Sorry, our service providers are unavailable at the moment\. Please try again later\.'/);
    expect(ACTIONS).toMatch(/if \(gate\.outcome === 'unavailable'\) return \{ error: UNAVAILABLE \}/);
    // The transient message must not carry the refusal's support pointer.
    const start = ACTIONS.indexOf('const UNAVAILABLE =');
    const line = ACTIONS.slice(start, ACTIONS.indexOf('\n', start));
    expect(line).not.toMatch(/contact support/);
  });

  it('every non-pass path returns a message — none of them silently continues', () => {
    // The three early returns inside the gate helper, plus the two at the
    // end. If any of them ever goes back to `error: null`, an unassessed
    // applicant walks through to the paid identity vendors.
    const start = ACTIONS.indexOf('async function runSignupBureauGate');
    const body = ACTIONS.slice(start, ACTIONS.indexOf('export type SubmitIdentityInput', start));
    // Exactly one `error: null` in the helper: the pass.
    const nulls = body.match(/error: null/g) ?? [];
    expect(nulls.length, 'only the pass may return null').toBe(1);
    expect(body).toMatch(/if \(gate\.outcome === 'pass'\) return \{ error: null \}/);
  });

  it('does not log the ID, the hash, or any reason description', () => {
    const start = ACTIONS.indexOf("event: 'signup_bureau_gate'");
    expect(start).toBeGreaterThan(-1);
    const block = ACTIONS.slice(start, ACTIONS.indexOf('}));', start));
    expect(block).not.toMatch(/cleanedId/);
    expect(block).not.toMatch(/idHash/);
    expect(block).not.toMatch(/reasonCodes/);
  });
});
