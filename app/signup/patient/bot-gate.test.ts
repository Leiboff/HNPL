import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stripComments } from '@/lib/testing/stripComments';

// ─── The signup automation gate is WIRED ────────────────────────────────
//
// botSignals.test.ts proves the scorer is right. This file proves the
// scorer is called, and called in the right ORDER, because a control that
// exists and is never consulted is the exact failure audit F-10 recorded:
// approved_credit_limit written, displayed, and read by no gate anywhere.
//
// Source-text assertions rather than an invocation test: signUpPatient
// creates auth users and sends mail, so exercising it here would need the
// whole Supabase surface mocked to assert something a read of the file
// establishes directly.

const ROOT = resolve(process.cwd());
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

const ACTION_SRC = read('app/signup/patient/actions.ts');
const ACTION     = stripComments(ACTION_SRC);
const FORM       = stripComments(read('app/signup/patient/PatientSignupForm.tsx'));

describe('the gate is called', () => {
  it('signUpPatient assesses bot signals', () => {
    expect(ACTION).toContain('assessBotSignals');
  });

  it('refuses on the automated verdict', () => {
    expect(ACTION).toMatch(/verdict === 'automated'/);
  });

  it('does NOT refuse on the suspect verdict — that band is observe-only today', () => {
    expect(ACTION).not.toMatch(/verdict === 'suspect'/);
  });

  it('reads the User-Agent server-side rather than trusting the client for it', () => {
    // A client-supplied UA would be scored as evidence about a header the
    // attacker writes. The header the server received is the only version
    // worth anything.
    expect(ACTION).toContain('requestUserAgent');
    expect(ACTION).not.toMatch(/userAgent:\s*input\.client/);
  });
});

describe('ordering', () => {
  it('spends the rate limit before scoring, and scores before creating anything', () => {
    const rateLimit = ACTION.indexOf("consumeAll('signup'");
    // The CALL, not the import — `assessBotSignals(` only matches the
    // invocation, since the import binds it without parentheses.
    const assess    = ACTION.indexOf('assessBotSignals(');
    const refuse    = ACTION.indexOf("verdict === 'automated'");
    const signUp    = ACTION.indexOf('signUp(');

    expect(rateLimit).toBeGreaterThan(-1);
    expect(assess).toBeGreaterThan(rateLimit);
    // The refusal must precede any account creation, or the control is
    // scoring something it has already let happen.
    expect(refuse).toBeLessThan(signUp === -1 ? Number.MAX_SAFE_INTEGER : signUp);
  });
});

describe('the refusal leaks nothing', () => {
  it('uses the same copy as the rate limit, so a script cannot tell them apart', () => {
    const copy = 'Too many sign-up attempts from this connection.';
    const occurrences = ACTION.split(copy).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('never returns the signal codes or the score to the caller', () => {
    // Anything surfaced to the client is a tuning oracle.
    expect(ACTION).not.toMatch(/error:\s*[`'"].*bot\.(score|verdict|signals)/i);
    expect(ACTION).not.toMatch(/success:\s*false,\s*signals/);
  });
});

describe('the form supplies the observations', () => {
  it('renders a honeypot that is hidden from people', () => {
    expect(FORM).toContain('honeypot');
    expect(FORM).toMatch(/left-\[-9999px\]/);
  });

  it('keeps the honeypot away from assistive technology and password managers', () => {
    // A honeypot that traps a screen reader is a honeypot that refuses
    // disabled customers.
    expect(FORM).toMatch(/aria-hidden="true"/);
    expect(FORM).toMatch(/tabIndex=\{-1\}/);
    expect(FORM).toMatch(/autoComplete="off"/);
  });

  it('reports dwell, interaction count and timezone', () => {
    expect(FORM).toContain('dwellMs');
    expect(FORM).toContain('interactionCount');
    expect(FORM).toContain('timezone');
  });

  it('counts interaction in the capture phase so it cannot be silenced', () => {
    expect(FORM).toMatch(/capture:\s*true/);
  });
});
