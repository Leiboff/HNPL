import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseReturnData, type ExperianOutcome } from './client';
import { bandFor } from './scores';
import { decide, RISK_EXPOSURE_CENTS } from './assessAtSignup';
import { mapAssessment } from '@/lib/underwriting/affordabilityPolicy';
import { FIXTURES } from '@/lib/testing/experianFixtures';
import { stripComments } from '@/lib/testing/stripComments';

// ─── Adversarial probes ────────────────────────────────────────────────
//
// These are not "does it work" tests. Each one is an attack on a property
// that has to hold even when someone later changes something reasonable-
// looking: that calibrating one scorecard cannot silently price another,
// that a cleartext password cannot reach a log, and that a bureau reason
// code cannot reach a patient.
//
// Source-text assertions use lib/testing/stripComments so that a file which
// legitimately DISCUSSES the thing it must not do (which is how these
// decisions document themselves) does not fail its own test — and, more
// importantly, so that the absence assertions are not passing trivially
// because the prose was thrown away. preserveUrls is set because the
// endpoint constants are string literals containing '//'.

const ROOT = resolve(process.cwd());
const src = (p: string) =>
  stripComments(readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n'), { preserveUrls: true });

const CLIENT = src('lib/experian/client.ts');
const ASSESS = src('lib/experian/assessAtSignup.ts');
const CONFIG = src('lib/experian/config.ts');
const STORE = src('lib/experian/enquiryStore.ts');
const ACTIONS = src('lib/onboarding/actions.ts');
const POLICY = src('lib/underwriting/affordabilityPolicy.ts');

const asOk = (json: string): ExperianOutcome => ({
  kind: 'ok', latencyMs: 1, raw: json, ...parseReturnData(json),
});

// ── NAMED TEST (8) ─────────────────────────────────────────────────────
describe('calibration cannot leak across scorecards', () => {
  it('funding SS band 4 leaves NLR band 4 and STS band 4 still referring', () => {
    // Bands are ORDINAL LABELS on separate scorecards, not a shared risk
    // scale. A band 4 on NLR is not the same default probability as a band 4
    // on SS, and STS is different again — it is the thin-file card and its
    // bands are far tighter (2 and 3 are five and six points wide against
    // fourteen each on SU).
    //
    // The failure this guards is the tempting one: key the exposure table on
    // band alone, fund band 4 once, and every scorecard silently inherits a
    // price calibrated for a different population.
    const before = RISK_EXPOSURE_CENTS.SS[4];
    RISK_EXPOSURE_CENTS.SS[4] = 250_000;
    try {
      // SS band 4 is now funded and does approve...
      const ss = decide(asOk('{"results":[{"resultType":"SS","score":"640","reasons":[]}]}'));
      expect(ss.band).toBe(4);
      expect(ss.decision).toBe('approved');

      // ...but an NLR band-4 file must not have inherited it.
      //
      // NLR 650 IS band 4 on the NLR table — but note WHY the decision
      // refers, because it is not the reason you would guess: NLR is not in
      // SCORECARD_PREFERENCE at all, so decide() never selects it and never
      // reaches banding. That is a second, independent reason a legacy card
      // cannot be priced off SS's calibration, and it is worth having pinned:
      // if NLR is ever added to the preference list, this test starts
      // exercising the exposure table rather than the selection list, and it
      // must still refer.
      expect(bandFor('NLR', 650), 'the NLR table says band 4').toBe(4);
      const nlr = decide(asOk('{"results":[{"resultType":"NLR","score":"650","reasons":[]}]}'));
      expect(nlr.decision, 'an NLR band-4 file must still refer').toBe('referred');
      expect(nlr.riskExposureCents).toBeNull();
      expect(RISK_EXPOSURE_CENTS.NLR[4], 'and NLR band 4 is still uncalibrated').toBeNull();

      // ...nor STS band 4, which is the newest and least calibrated of all.
      const sts = decide(asOk(FIXTURES.sts_band4));
      expect(sts.band, 'STS 610 is band 4').toBe(4);
      expect(sts.decision, 'STS band 4 must still refer').toBe('referred');
      expect(sts.riskExposureCents).toBeNull();
    } finally {
      RISK_EXPOSURE_CENTS.SS[4] = before;
    }
  });

  it('the exposure table is keyed on scorecard first, in the source', () => {
    // Pinned in source as well as in behaviour, because the behavioural test
    // above would still pass on a table that happened to be per-card today
    // and was flattened tomorrow.
    expect(ASSESS).toMatch(/RISK_EXPOSURE_CENTS:\s*Record<string,\s*Record<RiskBand,\s*number \| null>>/);
    expect(ASSESS).toMatch(/RISK_EXPOSURE_CENTS\[card\.resultType\]/);
  });

  it('an unknown scorecard refers rather than borrowing a table', () => {
    const d = decide(asOk(FIXTURES.unknown_scorecard));
    expect(d.decision).toBe('referred');
    expect(d.riskExposureCents).toBeNull();
  });
});

// ── NAMED TEST (14) ────────────────────────────────────────────────────
describe('credentials never reach a log or a thrown value', () => {
  it('no module in lib/experian logs anything at all', () => {
    // The blunt rule, and it is blunt on purpose. The request body contains
    // the password in CLEARTEXT, and the reliable way to keep it out of a
    // logger, an error reporter and a Sentry breadcrumb is for these files to
    // have no logging statement to attach it to.
    for (const [name, text] of [
      ['client.ts', CLIENT], ['assessAtSignup.ts', ASSESS],
      ['config.ts', CONFIG], ['enquiryStore.ts', STORE],
    ] as const) {
      expect(text, `${name} must not log`).not.toMatch(/console\s*\./);
    }
  });

  it('the password is referenced exactly once, where it is bound into the envelope', () => {
    const hits = CLIENT.match(/cfg\.password/g) ?? [];
    expect(hits.length, 'one reference: inside buildRequest').toBe(1);
    expect(CLIENT).toMatch(/<pPassword>\$\{escapeXml\(cfg\.password\)\}<\/pPassword>/);
  });

  it('the built envelope is never captured into a variable that outlives the call', () => {
    // buildRequest's result goes straight into postSoap as an argument. A
    // `const body = buildRequest(...)` would be the first step towards it
    // appearing in an error, a retry, or a log line.
    expect(CLIENT).toMatch(/postSoap\(EXPERIAN_ENDPOINTS\[cfg\.env\], buildRequest\(idNumber, cfg\), cfg\.timeoutMs\)/);
    expect(CLIENT).not.toMatch(/=\s*buildRequest\(/);
  });

  it('the transport-error path carries no request detail', () => {
    // Asserted structurally as well as behaviourally (client.test.ts drives
    // a forced error and greps the serialised outcome): the catch returns a
    // reason built from the error's own name and message, and nothing else.
    expect(CLIENT).toMatch(/reason:\s*err instanceof Error \? `\$\{err\.name\}: \$\{err\.message\}` : 'unknown fetch failure'/);
  });

  it('the config object is never spread or serialised anywhere', () => {
    for (const [name, text] of [['client.ts', CLIENT], ['assessAtSignup.ts', ASSESS]] as const) {
      expect(text, `${name}`).not.toMatch(/JSON\.stringify\(\s*cfg/);
      expect(text, `${name}`).not.toMatch(/JSON\.stringify\(\s*deps/);
      expect(text, `${name}`).not.toMatch(/\.\.\.cfg\b/);
    }
  });

  it('the one place runCreditCheck logs a bureau fault names no secret and no ID', () => {
    // lib/onboarding/actions.ts DOES log — it is an application surface and
    // that is appropriate. What it must never log is the config, the deps or
    // the decrypted ID.
    const start = ACTIONS.indexOf('bureau config unusable');
    expect(start, 'the bureau catch must still exist').toBeGreaterThan(-1);
    // The console.error CALL only — up to its closing `});`. Slicing a fixed
    // number of characters instead ran past it into the surrounding reset
    // lines and failed on code that is not being logged at all.
    const end = ACTIONS.indexOf('});', start);
    expect(end).toBeGreaterThan(start);
    const block = ACTIONS.slice(start, end);

    expect(block).not.toMatch(/saIdNumber/);
    expect(block).not.toMatch(/bureauDeps/);
    expect(block).not.toMatch(/password/i);
    expect(block).not.toMatch(/experianConfig\(\)/);
    // Only the account id and a message.
    expect(block).toMatch(/userId:\s*loaded\.userId/);
  });

  it('the decrypted SA ID is passed through and never logged or persisted', () => {
    // It goes into assessAffordability and nowhere else. A write of the
    // plaintext would defeat the AES-256-GCM storage it came out of.
    expect(ACTIONS).toMatch(/saIdNumber = loaded\.profile\.sa_id_number \? decryptId\(loaded\.profile\.sa_id_number\) : null/);
    expect(ACTIONS).not.toMatch(/console\.[a-z]+\([^)]*saIdNumber/);
    expect(ACTIONS).not.toMatch(/sa_id_number:\s*saIdNumber/);
  });

  it('the enquiry log stores the ID HASH, never the ID', () => {
    expect(STORE).toMatch(/id_number_hash/);
    expect(STORE).not.toMatch(/sa_id_number/);
    expect(STORE).not.toMatch(/idNumber/);
  });
});

// ── NAMED TEST (15) ────────────────────────────────────────────────────
describe('reason DESCRIPTIONS never reach a client-facing shape', () => {
  it('an assessment carries codes only, never the description text', () => {
    // The real payload's description is long, human-readable and would look
    // like an adverse-action reason to anyone who saw it. It is not one:
    // confirmed against real data, MI39 appeared on 46% of a 50-file sample
    // INCLUDING minimum-risk files. It describes the largest drag on a score,
    // not the basis of a decision.
    const d = decide(asOk(FIXTURES.real_su_credit_active));
    expect(d.reasonCodes).toEqual(['MI39']);

    const serialised = JSON.stringify(d);
    expect(serialised).not.toContain('Recent Increase in Overdue Balance Levels');
    expect(serialised).not.toContain('reasonDescription');
  });

  it('holds for a payload whose description contains markup', () => {
    const d = decide(asOk(FIXTURES.reason_with_metachars));
    expect(d.reasonCodes).toEqual(['TM53']);
    expect(JSON.stringify(d)).not.toContain('<loans>');
  });

  it('the affordability decision carries codes only', () => {
    const declined = mapAssessment(decide(asOk(FIXTURES.mixed_deceased_and_good)));
    expect(declined.outcome).toBe('declined');
    if (declined.outcome !== 'declined') return;
    expect(declined.reason).toBe('bureau:WARN-2');
    expect(declined.reason).not.toMatch(/[a-z]{4,}\s+[a-z]{4,}/); // no prose
  });

  it('the Assessment type has no field that could carry a description', () => {
    expect(ASSESS).toMatch(/reasonCodes:\s*string\[\]/);
    expect(ASSESS).not.toMatch(/reasonDescriptions/);
    // decide() maps reasons to their CODE, never the pair.
    expect(ASSESS).toMatch(/card\.reasons\.map\(\(r\) => r\.code\)/);
    expect(ASSESS).not.toMatch(/\.map\(\(r\) => r\.description\)/);
  });

  it('runCreditCheck answers a decline with fixed copy, not with the reason', () => {
    // The reason string is internal. The patient sees one sentence that says
    // nothing about why — adverse-action wording needs legal review and has
    // not had it.
    expect(ACTIONS).toMatch(/return \{ error: 'We could not approve an amount right now\.' \}/);
    expect(ACTIONS).not.toMatch(/error:\s*decision\.reason/);
    expect(ACTIONS).not.toMatch(/error:\s*`[^`]*\$\{decision\.reason\}/);
  });

  it('the policy never widens declined.reason into prose', () => {
    expect(POLICY).toMatch(/bureau:\$\{assessment\.reasonCodes\.join\(','\)\}/);
    expect(POLICY).not.toMatch(/assessment\.detail/);
  });
});

describe('fail-closed holds on the paths that bypass the bureau entirely', () => {
  it('an unconfigured policy cannot approve, and says why without guessing', () => {
    // Every non-approving bureau outcome maps to unavailable or declined —
    // never to approved. Swept over the whole Assessment decision space.
    const outcomes = ['referred', 'error'] as const;
    for (const decision of outcomes) {
      const mapped = mapAssessment({
        decision, riskExposureCents: null, scorecard: null, score: null, band: null,
        reasonCodes: [], detail: 'x', billed: false, fromCache: false,
      });
      expect(mapped.outcome, decision).toBe('unavailable');
    }
  });

  it('a bureau APPROVAL still cannot grant a limit, because the allowance rule is missing', () => {
    // The most important fail-closed case, and the least obvious. A
    // calibrated exposure is not a credit limit: exposure becomes a purchase
    // allowance through a rule that is not implemented in this repository.
    //
    // So populating RISK_EXPOSURE_CENTS alone will NOT start approvals. If
    // this test ever fails, someone has wired the conversion — and that is
    // the moment it needs an NCA affordability calculation beside it, not a
    // multiplier remembered from a brief.
    const mapped = mapAssessment({
      decision: 'approved', riskExposureCents: 250_000, scorecard: 'SU', score: 657,
      band: 4, reasonCodes: ['MI39'], detail: 'SU 657 → band 4', billed: true, fromCache: false,
    });
    expect(mapped.outcome).toBe('unavailable');
    if (mapped.outcome !== 'unavailable') return;
    expect(mapped.reason).toBe('purchase_allowance_rule_not_implemented');
  });

  it('no source file in the integration multiplies an exposure by anything', () => {
    // The Purchase Allowance = Exposure x 1.5 rule is a business rule that
    // does not exist in this codebase. A stray multiplier appearing here
    // would be someone implementing it from memory.
    for (const [name, text] of [
      ['assessAtSignup.ts', ASSESS], ['affordabilityPolicy.ts', POLICY], ['enquiryStore.ts', STORE],
    ] as const) {
      expect(text, name).not.toMatch(/riskExposureCents\s*\*/);
      expect(text, name).not.toMatch(/exposure\s*\*/);
      expect(text, name).not.toMatch(/\*\s*1\.5/);
    }
  });
});

describe('the live service is never contacted from a test', () => {
  it('no test file in lib/experian names a live endpoint as a call target', () => {
    // Every transaction is billable and every enquiry is logged against a
    // real person's credit file. The suite drives fixtures through a mocked
    // global fetch; nothing here may reach apis.experian.co.za.
    const tests = [
      'lib/experian/client.test.ts',
      'lib/experian/scores.test.ts',
      'lib/experian/assessAtSignup.test.ts',
      'lib/experian/experian.adversarial.test.ts',
    ];
    for (const file of tests) {
      const text = src(file);
      expect(text, `${file} must not unstub fetch and call out`)
        .not.toMatch(/apis(-uat)?\.experian\.co\.za/);
    }
  });

  it('the endpoints are only ever read through the constant', () => {
    expect(CLIENT).toMatch(/EXPERIAN_ENDPOINTS\[cfg\.env\]/);
  });
});
