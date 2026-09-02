import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Where the fraud rules are actually connected ─────────────────────────
//
// lib/security/identitySignals.test.ts proves the RULES are right.
// supabase/migrations/0138_identity_signals.rls.test.ts proves the STORE is
// safe. Neither notices if nobody calls them, and a fraud control that is
// correct and unreachable is the most expensive kind of nothing — it looks
// finished on every dashboard and defends against no one.
//
// So this file pins the call sites, in source. Three things, each of which
// would silently gut the mechanism if a refactor dropped it:
//
//   1. The device cookie is minted in proxy.ts, on every request. If this
//      moves to signup, the signal becomes worthless: correlation only works
//      if the value was present BEFORE you needed to ask about it.
//   2. Signup RECORDS and does not refuse. Refusing there would roll back
//      the account, profiles cascades to identity_signals, and the link
//      that triggered the block would delete itself — a loop, not a wall.
//   3. runCreditCheck ENFORCES, before any credit limit is written. This is
//      the only enforcement point in the patient flow.

const ROOT  = resolve(process.cwd());
const read  = (p: string) => readFileSync(resolve(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

const PROXY   = read('proxy.ts');
const SIGNUP  = read('app/signup/patient/actions.ts');
const ONBOARD = read('lib/onboarding/actions.ts');
const CARD    = read('lib/payments/peach/saveCardForPatient.ts');
const RULES   = read('lib/security/identitySignals.ts');

/** Source with line comments removed — several assertions below look for the
 *  ABSENCE of an identifier, and this file's own explanatory comments name
 *  the very things they must not find in the code. */
const codeOnly = (src: string) =>
  src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

describe('the device id is minted in the proxy, not at signup', () => {
  it('proxy.ts sets the cookie', () => {
    expect(PROXY).toMatch(/DEVICE_COOKIE/);
    expect(PROXY).toMatch(/response\.cookies\.set\(\s*DEVICE_COOKIE/);
  });

  it('httpOnly — so no script can read it OR choose it', () => {
    // Choosing it is the worse half: a page that could set the value would
    // let one person pin fifty accounts to one id, or pin their account to
    // somebody else's and drag that person over a threshold.
    const setCall = PROXY.slice(PROXY.indexOf('DEVICE_COOKIE, newDeviceId()'));
    expect(setCall.slice(0, 400)).toMatch(/httpOnly:\s*true/);
  });

  it('only mints when the existing value is absent or malformed', () => {
    // Rewriting it on every request would reset the age of the signal and
    // break the "this browser has been here three weeks" reading entirely.
    expect(PROXY).toMatch(/if \(!isValidDeviceId\(existingDeviceId\)\)/);
  });

  it('signup does NOT mint one — the whole point is that it predates signup', () => {
    expect(codeOnly(SIGNUP)).not.toMatch(/newDeviceId/);
  });
});

describe('signup records but never refuses', () => {
  it('calls assessIdentity with the request signals', () => {
    expect(SIGNUP).toMatch(/assessIdentity\(\s*svc,\s*newUserId,\s*'signup'/);
  });

  it('does not branch on the verdict', () => {
    // If this ever gains a `decision === 'block'` branch, read the comment
    // above the call: the refusal would delete its own evidence.
    const source = codeOnly(SIGNUP);
    const call = source.slice(source.indexOf('assessIdentity('));
    expect(call).not.toMatch(/decision\s*===\s*'block'/);
  });

  it('runs after the terms acceptance is safely recorded', () => {
    // A signal write must never be the thing that costs somebody an account.
    expect(SIGNUP.indexOf('await recordAcceptance(svc, newUserId'))
      .toBeLessThan(SIGNUP.indexOf('assessIdentity('));
  });
});

describe('the credit step is the enforcement point', () => {
  it('assesses on the credit_claim surface', () => {
    expect(ONBOARD).toMatch(/assessIdentity\(/);
    expect(ONBOARD).toMatch(/'credit_claim'/);
  });

  it('refuses on a block', () => {
    expect(ONBOARD).toMatch(/assessment\.decision === 'block'/);
    expect(ONBOARD).toMatch(/FRAUD_BLOCK_MESSAGE/);
  });

  it('refuses BEFORE any credit limit is written', () => {
    // The assertion that actually matters. An enforcement check placed after
    // the UPDATE would return an error message to a customer who had already
    // been granted the limit.
    expect(ONBOARD.indexOf('assessment.decision === \'block\''))
      .toBeLessThan(ONBOARD.indexOf('approved_credit_limit:'));
  });

  it('does not write credit_check_status on a block', () => {
    // 'failed' would be a lie — no affordability decision was made — and it
    // would also be terminal, which a releasable block must not be.
    const source  = codeOnly(ONBOARD);
    const between = source.slice(
      source.indexOf('assessment.decision === \'block\''),
      source.indexOf('const decision = stubAffordabilityPolicy()'),
    );
    expect(between).not.toMatch(/credit_check_status/);
  });
});

describe('the card signal is recorded, not enforced', () => {
  it('saveCardForPatient records the signature', () => {
    expect(CARD).toMatch(/recordSignals\(supabase, patientId, \{ card: signature \}\)/);
  });

  it('and never refuses — it runs inside a webhook, after the money moved', () => {
    const source = codeOnly(CARD);
    expect(source).not.toMatch(/assessIdentity/);
    expect(source).not.toMatch(/FRAUD_BLOCK_MESSAGE/);
  });

  it('records on the already_saved branch too, so repeat sightings count', () => {
    expect(CARD.indexOf('recordSignals('))
      .toBeLessThan(CARD.indexOf("if (action.action === 'already_saved')"));
  });
});

describe('the rules themselves cannot be quietly loosened', () => {
  it('IP is hard-capped at flag in the source, not merely by its default', () => {
    // A future "make the thresholds consistent" pass would naturally give IP
    // a blockAt to match the others. In South Africa that refuses suburbs.
    const source = codeOnly(RULES);
    const ipCase = source.slice(source.indexOf("case 'ip':"), source.indexOf("case 'device':"));
    expect(ipCase).toMatch(/blockAt:\s*null/);
    expect(ipCase).not.toMatch(/FRAUD_IP_BLOCK_AT/);
  });

  it('the verdict is strongest-signal-wins, never a sum', () => {
    const fn = codeOnly(RULES).slice(codeOnly(RULES).indexOf('export function evaluateLinks'));
    expect(fn).not.toMatch(/\+=/);
    expect(fn).not.toMatch(/reduce\(/);
  });
});
